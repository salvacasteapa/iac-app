// Agenda comercial: llamadas, visitas y reuniones, cada una con su motivo,
// su resultado y el siguiente paso. Incluye sugerencias de a quién contactar y por qué.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER, kind TEXT NOT NULL, motive TEXT NOT NULL,
  other_id INTEGER, contact_company TEXT, contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  start TEXT NOT NULL, minutes INTEGER DEFAULT 30, place TEXT,
  product_id INTEGER, offer_price REAL, notes TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente', result TEXT, result_notes TEXT,
  parent_id INTEGER, created INTEGER NOT NULL, done INTEGER
);`);

if (!all('PRAGMA table_info(products)').some(c => c.name === 'created')) db.exec('ALTER TABLE products ADD COLUMN created INTEGER');

const KINDS = { llamada: 'Llamada', visita: 'Visita', reunion: 'Reunión' };
// Motivos: para qué tipos sirven, cuánto duran por defecto y si piden un artículo.
const MOTIVES = {
  oferta: { t: 'Presentar una oferta', k: ['llamada', 'visita', 'reunion'], prod: true, min: 15 },
  nuevo_producto: { t: 'Ofrecer un producto nuevo', k: ['llamada', 'visita', 'reunion'], prod: true, min: 20 },
  regular: { t: 'Contacto regular', k: ['llamada', 'visita'], min: 10 },
  seguimiento_oferta: { t: 'Seguimiento de una oferta enviada', k: ['llamada', 'visita'], prod: true, min: 10 },
  reposicion: { t: 'Reposición: hace tiempo que no pide', k: ['llamada', 'visita'], prod: true, min: 10 },
  conexion: { t: 'Conseguir la conexión con su agente de compras', k: ['llamada', 'visita', 'reunion'], min: 30 },
  captacion: { t: 'Captación de cliente nuevo', k: ['llamada', 'visita', 'reunion'], min: 30 },
  tarifa: { t: 'Renovar condiciones o tarifa anual', k: ['llamada', 'visita', 'reunion'], min: 45 },
  demostracion: { t: 'Demostración o visita técnica', k: ['visita', 'reunion'], prod: true, min: 60 },
  incidencia: { t: 'Incidencia o reclamación', k: ['llamada', 'visita', 'reunion'], prod: true, min: 20 },
  cobro: { t: 'Cobro pendiente', k: ['llamada', 'visita'], min: 10 },
  postventa: { t: 'Postventa: ¿todo bien con el pedido?', k: ['llamada', 'visita'], min: 10 },
  certificados: { t: 'Certificados u homologación', k: ['llamada', 'reunion'], min: 20 },
  revision: { t: 'Revisión de resultados del año', k: ['visita', 'reunion'], min: 60 },
  proveedor: { t: 'Negociar con un proveedor', k: ['llamada', 'visita', 'reunion'], prod: true, min: 30 },
  feria: { t: 'Feria o evento', k: ['visita', 'reunion'], min: 120 },
  otro: { t: 'Otro motivo', k: ['llamada', 'visita', 'reunion'], min: 30 }
};
// Resultados posibles y qué siguiente paso propone cada uno (motivo y en cuántos días).
const RESULTS = {
  pedido: { t: 'Ha hecho pedido', next: ['postventa', 'llamada', 7] },
  interesado: { t: 'Interesado', next: ['seguimiento_oferta', 'llamada', 3] },
  enviar_info: { t: 'Pide más información', next: ['seguimiento_oferta', 'llamada', 5] },
  volver_llamar: { t: 'Volver a llamar', next: [null, 'llamada', 2] },
  no_contesta: { t: 'No contesta', next: [null, 'llamada', 1] },
  visita: { t: 'Quiere una visita', next: [null, 'visita', 7] },
  conexion_ok: { t: 'Acepta conectar su agente', next: ['regular', 'llamada', 30] },
  no_interesado: { t: 'No interesado', next: ['regular', 'llamada', 90] },
  resuelto: { t: 'Resuelto', next: null }
};

const ymd = d => d.toISOString().slice(0, 10);
const addDays = (n, base = new Date()) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

function register(app, { auth, active, bad, str, num }) {
  const view = a => {
    const u = a.user_id && one('SELECT id, name, email FROM users WHERE id=?', a.user_id);
    const p = a.product_id && one('SELECT id, name, sku, unit, list_price FROM products WHERE id=?', a.product_id);
    const o = a.other_id && one('SELECT id, name, logo, color FROM companies WHERE id=?', a.other_id);
    return { ...a, user: u || null, product: p || null, other: o || null, who: o?.name || a.contact_company || a.contact_name || '—' };
  };
  const input = (b, req) => {
    const kind = KINDS[b.kind] ? b.kind : 'llamada';
    const motive = MOTIVES[b.motive] ? b.motive : 'otro';
    let other_id = +b.other_id || null;
    if (other_id && !one(`SELECT id FROM connections WHERE status='activa' AND ((seller_id=? AND buyer_id=?) OR (buyer_id=? AND seller_id=?))`, req.company.id, other_id, req.company.id, other_id)) other_id = null;
    const product_id = +b.product_id && one('SELECT id FROM products WHERE id=? AND company_id=?', +b.product_id, req.company.id) ? +b.product_id : null;
    const user_id = +b.user_id && one('SELECT id FROM users WHERE id=? AND company_id=?', +b.user_id, req.company.id) ? +b.user_id : req.user.id;
    const start = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.start || '') ? b.start : null;
    return { kind, motive, other_id, contact_company: str(b.contact_company, 160), contact_name: str(b.contact_name, 120), contact_phone: str(b.contact_phone, 40), contact_email: str(b.contact_email, 160),
      start, minutes: Math.min(600, Math.max(5, Math.floor(num(b.minutes) ?? MOTIVES[motive].min))), place: str(b.place, 300), product_id, offer_price: num(b.offer_price), notes: str(b.notes, 4000), user_id };
  };
  const F = ['kind', 'motive', 'other_id', 'contact_company', 'contact_name', 'contact_phone', 'contact_email', 'start', 'minutes', 'place', 'product_id', 'offer_price', 'notes', 'user_id'];

  app.get('/api/agenda/meta', auth, (req, res) => res.json({ kinds: KINDS, motives: MOTIVES, results: RESULTS }));
  app.get('/api/agenda', auth, (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to + 'T99' : '9999';
    res.json(all(`SELECT * FROM agenda WHERE company_id=? AND ((start>=? AND start<=?) OR (status='pendiente' AND start<?)) ORDER BY start`, req.company.id, from, to, from).map(view));
  });
  app.get('/api/agenda/:id', auth, (req, res) => {
    const a = one('SELECT * FROM agenda WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!a) return bad(res, 'No encontrada', 404);
    const history = all('SELECT * FROM agenda WHERE company_id=? AND id<>? AND ((other_id IS NOT NULL AND other_id=?) OR (other_id IS NULL AND contact_company<>\'\' AND contact_company=?)) ORDER BY start DESC LIMIT 20',
      req.company.id, a.id, a.other_id, a.contact_company).map(view);
    res.json({ ...view(a), history });
  });
  app.post('/api/agenda', auth, active, (req, res) => {
    const b = req.body || {}, v = input(b, req);
    if (!v.start) return bad(res, 'Pon el día y la hora');
    if (!v.other_id && !v.contact_company && !v.contact_name) return bad(res, 'Elige un cliente o proveedor, o escribe con quién es');
    if (b.id) {
      const a = one('SELECT id FROM agenda WHERE id=? AND company_id=?', +b.id, req.company.id); if (!a) return bad(res, 'No encontrada', 404);
      run(`UPDATE agenda SET ${F.map(f => f + '=?').join(', ')} WHERE id=?`, ...F.map(f => v[f]), a.id);
      return res.json({ ok: true, id: a.id });
    }
    const parent = +b.parent_id && one('SELECT id FROM agenda WHERE id=? AND company_id=?', +b.parent_id, req.company.id) ? +b.parent_id : null;
    const r = run(`INSERT INTO agenda (company_id, ${F.join(', ')}, parent_id, created) VALUES (?, ${F.map(() => '?').join(', ')}, ?, ?)`, req.company.id, ...F.map(f => v[f]), parent, now());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });
  // Registrar el resultado. Devuelve el siguiente paso propuesto (o lo crea si se pide).
  app.post('/api/agenda/:id/resultado', auth, active, (req, res) => {
    const a = one('SELECT * FROM agenda WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!a) return bad(res, 'No encontrada', 404);
    const b = req.body || {};
    if (b.status === 'cancelada') { run(`UPDATE agenda SET status='cancelada', result_notes=?, done=? WHERE id=?`, str(b.result_notes, 2000), now(), a.id); return res.json({ ok: true }); }
    if (!RESULTS[b.result]) return bad(res, 'Elige cómo ha ido');
    run(`UPDATE agenda SET status='hecha', result=?, result_notes=?, done=? WHERE id=?`, b.result, str(b.result_notes, 4000), now(), a.id);
    let next = null;
    if (b.next && b.next.start) {
      const v = input({ ...a, ...b.next, other_id: a.other_id, contact_company: a.contact_company, contact_name: a.contact_name, contact_phone: a.contact_phone, contact_email: a.contact_email, product_id: b.next.product_id ?? a.product_id }, req);
      if (v.start) next = Number(run(`INSERT INTO agenda (company_id, ${F.join(', ')}, parent_id, created) VALUES (?, ${F.map(() => '?').join(', ')}, ?, ?)`, req.company.id, ...F.map(f => v[f]), a.id, now()).lastInsertRowid);
    }
    res.json({ ok: true, next });
  });
  app.post('/api/agenda/:id/aplazar', auth, active, (req, res) => {
    const a = one('SELECT * FROM agenda WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!a) return bad(res, 'No encontrada', 404);
    const start = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(req.body?.start || '') ? req.body.start : null; if (!start) return bad(res, 'Elige la nueva fecha');
    run(`UPDATE agenda SET start=?, status='pendiente' WHERE id=?`, start, a.id); res.json({ ok: true });
  });
  app.delete('/api/agenda/:id', auth, active, (req, res) => { run('DELETE FROM agenda WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true }); });

  // Sugerencias: a quién contactar y por qué, a partir de los datos de la plataforma.
  app.get('/api/agenda-sugerencias', auth, (req, res) => {
    const cid = req.company.id, out = [];
    const planned = (otherId, motive) => one(`SELECT id FROM agenda WHERE company_id=? AND other_id=? AND motive=? AND status='pendiente'`, cid, otherId, motive);
    const clients = all(`SELECT c.id, c.name FROM connections k JOIN companies c ON c.id=k.buyer_id WHERE k.seller_id=? AND k.status='activa'`, cid);
    const DAY = 864e5;
    for (const c of clients) {
      const last = one(`SELECT max(closed) t FROM deals WHERE seller_id=? AND buyer_id=? AND status='cerrado'`, cid, c.id).t;
      const lastContact = one(`SELECT max(start) s FROM agenda WHERE company_id=? AND other_id=? AND status='hecha'`, cid, c.id).s;
      if (last && now() - last > 30 * DAY && !planned(c.id, 'reposicion')) out.push({ kind: 'llamada', motive: 'reposicion', other_id: c.id, who: c.name, why: `No pide desde hace ${Math.floor((now() - last) / DAY)} días` });
      const newProds = all(`SELECT id, name FROM products WHERE company_id=? AND active=1 AND created>?`, cid, now() - 30 * DAY);
      if (newProds.length && !planned(c.id, 'nuevo_producto')) out.push({ kind: 'llamada', motive: 'nuevo_producto', other_id: c.id, who: c.name, product_id: newProds[0].id, why: `Tienes ${newProds.length} artículo${newProds.length > 1 ? 's' : ''} nuevo${newProds.length > 1 ? 's' : ''}: ${newProds.slice(0, 2).map(p => p.name).join(', ')}` });
      if ((!lastContact || Date.parse(lastContact) < now() - 45 * DAY) && !planned(c.id, 'regular')) out.push({ kind: 'llamada', motive: 'regular', other_id: c.id, who: c.name, why: lastContact ? `Último contacto el ${lastContact.slice(0, 10)}` : 'Aún no has registrado ningún contacto' });
      const recent = one(`SELECT d.id, p.name FROM deals d LEFT JOIN products p ON p.id=d.product_id WHERE d.seller_id=? AND d.buyer_id=? AND d.status='cerrado' AND d.closed>? ORDER BY d.closed DESC`, cid, c.id, now() - 10 * DAY);
      if (recent && !planned(c.id, 'postventa')) out.push({ kind: 'llamada', motive: 'postventa', other_id: c.id, who: c.name, why: `Pedido reciente de ${recent.name || 'artículo'}` });
    }
    for (const n of all(`SELECT * FROM ext_negotiations WHERE company_id=? AND status IN ('sin_acuerdo','humano') ORDER BY updated DESC LIMIT 10`, cid))
      out.push({ kind: 'llamada', motive: n.status === 'humano' ? 'oferta' : 'seguimiento_oferta', contact_company: n.cp_company, contact_name: n.cp_name, contact_email: n.cp_email, product_id: n.product_id, why: n.status === 'humano' ? `Pidió hablar con una persona (${n.product_name})` : `Negociación sin acuerdo (${n.product_name})` });
    for (const c of all(`SELECT * FROM certificates WHERE company_id=? AND expires IS NOT NULL AND expires<?`, cid, ymd(addDays(45))))
      out.push({ kind: 'llamada', motive: 'certificados', who: c.name + (c.issuer ? ' · ' + c.issuer : ''), contact_company: c.issuer || c.name, contact_name: '', why: `${c.name} ${c.expires < ymd(new Date()) ? 'caducó' : 'caduca'} el ${c.expires}` });
    res.json(out.slice(0, 12));
  });

  // Archivo de calendario (.ics) para Google Calendar, Outlook o el móvil
  app.get('/agenda/:id.ics', auth, (req, res) => {
    const a = one('SELECT * FROM agenda WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!a) return res.status(404).send('No encontrada');
    const v = view(a), t = a.start.replace(/[-:]/g, '') + '00';
    const end = new Date(Date.parse(a.start + ':00Z') + a.minutes * 6e4).toISOString().slice(0, 16).replace(/[-:]/g, '') + '00';
    const esc = s => String(s ?? '').replace(/[\\;,]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const desc = [MOTIVES[a.motive]?.t, v.product ? 'Artículo: ' + v.product.name + (v.product.sku ? ' (' + v.product.sku + ')' : '') : '', a.offer_price != null ? 'Oferta: ' + a.offer_price + ' €' : '', a.contact_name, a.contact_phone, a.contact_email, a.notes].filter(Boolean).join('\n');
    res.set('content-type', 'text/calendar; charset=utf-8').set('content-disposition', `attachment; filename="cita-${a.id}.ics"`).send([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IAC//Agenda//ES', 'BEGIN:VEVENT', `UID:iac-${a.id}@iac`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART:${t}`, `DTEND:${end}`, `SUMMARY:${esc(KINDS[a.kind] + ' · ' + v.who + ' · ' + (MOTIVES[a.motive]?.t || ''))}`, `DESCRIPTION:${esc(desc)}`, a.place ? `LOCATION:${esc(a.place)}` : '', 'END:VEVENT', 'END:VCALENDAR'
    ].filter(Boolean).join('\r\n'));
  });
}

module.exports = { register, KINDS, MOTIVES, RESULTS };
