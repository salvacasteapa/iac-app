// Seguimiento escalado y avisos en tiempo real.
// Cada cliente tiene un nivel de atención y un comercial responsable. Cada operación toma el nivel
// mayor entre el del cliente y el que marca su importe (y sube uno si se pierde, si así se configura).
// Según el nivel y el resultado (ganada, perdida o en espera), se avisa a quien corresponde y se
// propone una llamada o una reunión. El gerente decide si la agenda.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS client_accounts (
  seller_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  level INTEGER DEFAULT 1, owner_id INTEGER, notes TEXT,
  PRIMARY KEY (seller_id, buyer_id)
);
CREATE TABLE IF NOT EXISTS followup_settings (company_id INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  other_id INTEGER, other_name TEXT, deal_id INTEGER, ext_id INTEGER,
  outcome TEXT NOT NULL, level INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT,
  total REAL, product_id INTEGER, suggest_kind TEXT, suggest_days INTEGER, owner_id INTEGER,
  recipients TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'nuevo', cita_id INTEGER,
  decided_by TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_reads (alert_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (alert_id, user_id));`);

const OUTCOME_T = { ganado: 'Ganada', perdido: 'Perdida', standby: 'En espera' };
const DEFAULTS = {
  levels: {
    1: { name: 'Estándar', notify: 'nadie' },
    2: { name: 'Atención', notify: 'responsable' },
    3: { name: 'Prioritario', notify: 'responsable_gerente' },
    4: { name: 'Crítico', notify: 'responsable_gerente' }
  },
  importe: { 2: 1000, 3: 5000, 4: 20000 },       // a partir de este importe, la operación sube a ese nivel
  perdida_sube: true,                             // una operación perdida sube un nivel
  acciones: {                                     // por nivel y resultado: qué proponer y en cuántos días
    1: { ganado: ['nada', 0], perdido: ['nada', 0], standby: ['nada', 0] },
    2: { ganado: ['nada', 0], perdido: ['llamada', 2], standby: ['llamada', 1] },
    3: { ganado: ['llamada', 3], perdido: ['llamada', 1], standby: ['llamada', 0] },
    4: { ganado: ['reunion', 7], perdido: ['reunion', 2], standby: ['llamada', 0] }
  }
};
function getSettings(cid) {
  const r = one('SELECT json FROM followup_settings WHERE company_id=?', cid);
  const s = structuredClone(DEFAULTS); if (!r) return s;
  const saved = JSON.parse(r.json);
  for (const k of [1, 2, 3, 4]) { s.levels[k] = { ...s.levels[k], ...(saved.levels?.[k] || {}) }; s.acciones[k] = { ...s.acciones[k], ...(saved.acciones?.[k] || {}) }; }
  s.importe = { ...s.importe, ...(saved.importe || {}) }; if (saved.perdida_sube !== undefined) s.perdida_sube = !!saved.perdida_sube;
  return s;
}
const account = (sellerId, buyerId) => buyerId ? one('SELECT * FROM client_accounts WHERE seller_id=? AND buyer_id=?', sellerId, buyerId) : null;

/** Nivel de atención de una operación. */
function levelFor(cid, otherId, total, outcome) {
  const s = getSettings(cid), acc = account(cid, otherId);
  let lv = acc?.level || 1;
  for (const k of [2, 3, 4]) if (total != null && s.importe[k] != null && total >= s.importe[k]) lv = Math.max(lv, k);
  if (outcome === 'perdido' && s.perdida_sube) lv = Math.min(4, lv + 1);
  return lv;
}

/** Crea un aviso para la empresa `cid` (la que tiene que reaccionar). */
function alert({ cid, otherId, otherName, dealId, extId, outcome, total, productId, title, summary }) {
  const s = getSettings(cid), acc = account(cid, otherId);
  const level = levelFor(cid, otherId, total, outcome);
  const notify = s.levels[level].notify;
  const [kind, days] = s.acciones[level][outcome] || ['nada', 0];
  const admins = all('SELECT id FROM users WHERE company_id=? AND is_admin=1', cid).map(u => u.id);
  const owner = acc?.owner_id && one('SELECT id FROM users WHERE id=? AND company_id=?', acc.owner_id, cid) ? acc.owner_id : null;
  const rec = new Set();
  if (notify !== 'nadie') { if (owner) rec.add(owner); else admins.forEach(x => rec.add(x)); }
  if (notify === 'responsable_gerente') admins.forEach(x => rec.add(x));
  const r = run(`INSERT INTO alerts (company_id, other_id, other_name, deal_id, ext_id, outcome, level, title, summary, total, product_id, suggest_kind, suggest_days, owner_id, recipients, status, created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, otherId || null, otherName || null, dealId || null, extId || null, outcome, level, title, summary || null, total ?? null, productId || null,
    kind === 'nada' ? null : kind, days, owner, JSON.stringify([...rec]), rec.size ? 'nuevo' : 'registrado', now());
  const id = Number(r.lastInsertRowid);
  if (rec.size) setImmediate(() => require('./notify').dispatch(id).catch(e => console.error('aviso', id, e.message)));
  return id;
}

const eur = n => Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
/** Aviso a partir de una operación entre agentes, para el lado vendedor. */
function dealAlert(d, outcome, why) {
  const buyer = one('SELECT name FROM companies WHERE id=?', d.buyer_id), p = d.product_id && one('SELECT name FROM products WHERE id=?', d.product_id);
  const total = d.total ?? (d.qty && d.price ? d.qty * d.price : null);
  const what = `${d.qty ? d.qty + ' ud de ' : ''}${p?.name || 'artículo'}`;
  const title = outcome === 'ganado' ? `${buyer.name} ha hecho un pedido` : outcome === 'standby' ? `Pedido de ${buyer.name} en espera` : `Pedido perdido con ${buyer.name}`;
  const summary = `${what}${total != null ? ' · ' + eur(total) : ''}${d.price ? ' a ' + eur(d.price) + '/ud' : ''}${why ? '. ' + why : ''}`;
  return alert({ cid: d.seller_id, otherId: d.buyer_id, otherName: buyer.name, dealId: d.id, outcome, total, productId: d.product_id, title, summary });
}
/** Aviso a partir de una negociación con una empresa sin agente. */
function extAlert(n, outcome) {
  const who = n.cp_company || n.cp_name || 'empresa sin agente';
  const verb = n.side === 'venta' ? { ganado: `${who} ha aceptado la propuesta`, perdido: `Sin acuerdo con ${who}`, standby: n.status === 'humano' ? `${who} pide hablar con una persona` : `Acuerdo con ${who} pendiente de aprobar` }
    : { ganado: `Compra cerrada con ${who}`, perdido: `Sin acuerdo con el proveedor ${who}`, standby: n.status === 'humano' ? `${who} pide hablar con una persona` : `Compra a ${who} pendiente de aprobar` };
  return alert({ cid: n.company_id, otherName: who, extId: n.id, outcome, total: n.total ?? (n.our_offer ? n.our_offer * n.qty : null), productId: n.product_id, title: verb[outcome],
    summary: `${n.qty} ${n.unit} de ${n.product_name}${n.price ? ' a ' + eur(n.price) + '/' + n.unit : n.our_offer ? ' · última propuesta ' + eur(n.our_offer) : ''}` });
}

function register(app, { auth, active, bad, str, num, admin }) {
  const mine = (a, uid) => JSON.parse(a.recipients).includes(uid);
  const view = (a, uid) => ({ ...a, recipients: undefined, for_me: mine(a, uid), read: !!one('SELECT 1 x FROM alert_reads WHERE alert_id=? AND user_id=?', a.id, uid),
    owner: a.owner_id ? one('SELECT id, name, email FROM users WHERE id=?', a.owner_id) : null });
  const visible = (req, a) => req.user.is_admin || mine(a, req.user.id);

  app.get('/api/alerts', auth, (req, res) => {
    const since = +req.query.since || 0;
    const rows = all('SELECT * FROM alerts WHERE company_id=? AND id>? ORDER BY id DESC LIMIT 200', req.company.id, since).filter(a => visible(req, a));
    res.json(rows.map(a => view(a, req.user.id)));
  });
  app.get('/api/alerts/unread', auth, (req, res) => {
    const rows = all(`SELECT * FROM alerts WHERE company_id=? AND status='nuevo' AND id NOT IN (SELECT alert_id FROM alert_reads WHERE user_id=?) ORDER BY id DESC LIMIT 50`, req.company.id, req.user.id).filter(a => mine(a, req.user.id));
    res.json(rows.map(a => view(a, req.user.id)));
  });
  app.post('/api/alerts/:id/:action', auth, active, (req, res) => {
    const a = one('SELECT * FROM alerts WHERE id=? AND company_id=?', +req.params.id, req.company.id);
    if (!a || !visible(req, a)) return bad(res, 'No encontrado', 404);
    const by = req.user.name || req.user.email;
    if (req.params.action === 'leido') run('INSERT OR IGNORE INTO alert_reads (alert_id, user_id) VALUES (?,?)', a.id, req.user.id);
    else if (req.params.action === 'descartar') { run(`UPDATE alerts SET status='descartado', decided_by=? WHERE id=?`, by, a.id); run('INSERT OR IGNORE INTO alert_reads (alert_id, user_id) VALUES (?,?)', a.id, req.user.id); }
    else if (req.params.action === 'agendado') {
      const c = one('SELECT id FROM agenda WHERE id=? AND company_id=?', +req.body?.cita_id, req.company.id); if (!c) return bad(res, 'Cita no encontrada');
      run(`UPDATE alerts SET status='agendado', cita_id=?, decided_by=? WHERE id=?`, c.id, by, a.id); run('INSERT OR IGNORE INTO alert_reads (alert_id, user_id) VALUES (?,?)', a.id, req.user.id);
    } else return bad(res, 'Acción no válida');
    res.json({ ok: true });
  });

  // Niveles de atención por cliente y comercial responsable
  app.get('/api/followup', auth, (req, res) => {
    const cid = req.company.id;
    const clients = all(`SELECT c.id, c.name, c.logo, c.color FROM connections k JOIN companies c ON c.id=k.buyer_id WHERE k.seller_id=? AND k.status IN ('activa','pausada') ORDER BY c.name`, cid)
      .map(c => { const acc = account(cid, c.id); const s = one(`SELECT count(*) n, coalesce(sum(total),0) t, max(closed) last FROM deals WHERE seller_id=? AND buyer_id=? AND status='cerrado'`, cid, c.id); return { ...c, level: acc?.level || 1, owner_id: acc?.owner_id || null, notes: acc?.notes || '', grupo: acc?.grupo || '', orders: s.n, revenue: s.t, last: s.last }; });
    res.json({ settings: getSettings(cid), clients, users: all('SELECT id, name, email, is_admin FROM users WHERE company_id=?', cid) });
  });
  app.post('/api/followup/client', auth, active, admin, (req, res) => {
    const b = req.body || {}, cid = req.company.id, bid = +b.buyer_id;
    if (!one(`SELECT id FROM connections WHERE seller_id=? AND buyer_id=?`, cid, bid)) return bad(res, 'Cliente no encontrado');
    const level = Math.min(4, Math.max(1, Math.floor(num(b.level) ?? 1)));
    const owner = +b.owner_id && one('SELECT id FROM users WHERE id=? AND company_id=?', +b.owner_id, cid) ? +b.owner_id : null;
    run(`INSERT INTO client_accounts (seller_id, buyer_id, level, owner_id, notes) VALUES (?,?,?,?,?) ON CONFLICT(seller_id, buyer_id) DO UPDATE SET level=excluded.level, owner_id=excluded.owner_id, notes=excluded.notes`, cid, bid, level, owner, str(b.notes, 500));
    res.json({ ok: true });
  });
  app.put('/api/followup/settings', auth, active, admin, (req, res) => {
    const b = req.body || {}, s = getSettings(req.company.id);
    const N = ['nadie', 'responsable', 'responsable_gerente'], K = ['nada', 'llamada', 'reunion'];
    for (const k of [1, 2, 3, 4]) {
      const l = b.levels?.[k]; if (l) { if (str(l.name, 40)) s.levels[k].name = str(l.name, 40); if (N.includes(l.notify)) s.levels[k].notify = l.notify; }
      for (const o of ['ganado', 'perdido', 'standby']) { const x = b.acciones?.[k]?.[o]; if (Array.isArray(x) && K.includes(x[0])) s.acciones[k][o] = [x[0], Math.min(90, Math.max(0, Math.floor(num(x[1]) ?? 0)))]; }
    }
    for (const k of [2, 3, 4]) if (b.importe && b.importe[k] !== undefined) s.importe[k] = b.importe[k] === '' || b.importe[k] === null ? null : Math.max(0, num(b.importe[k]) ?? 0);
    if (b.perdida_sube !== undefined) s.perdida_sube = !!b.perdida_sube;
    run('INSERT INTO followup_settings (company_id, json) VALUES (?,?) ON CONFLICT(company_id) DO UPDATE SET json=excluded.json', req.company.id, JSON.stringify(s));
    res.json(s);
  });
}

module.exports = { register, dealAlert, extAlert, levelFor, getSettings, OUTCOME_T };
