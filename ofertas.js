// Ofertas especiales: el proveedor envía una oferta a un cliente, a un grupo de clientes o a todos,
// sobre una familia de artículos o sobre un artículo concreto.
// Cada oferta crea, para cada cliente que la recibe, una autorización especial: así su agente de compras
// consigue ese precio al negociar sin que nadie tenga que acordarse. Retirar la oferta las desactiva.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL, message TEXT,
  target TEXT NOT NULL CHECK (target IN ('familia','articulo')), category TEXT, product_id INTEGER,
  audience TEXT NOT NULL CHECK (audience IN ('cliente','grupo','todos')), buyer_id INTEGER, grupo TEXT,
  price_mode TEXT NOT NULL DEFAULT 'descuento', price REAL, discount_pct REAL, lead_days INTEGER, min_qty INTEGER,
  valid_to TEXT, status TEXT NOT NULL DEFAULT 'activa', user_id INTEGER, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_recipients (
  offer_id INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  auth_id INTEGER, status TEXT NOT NULL DEFAULT 'nueva', seen INTEGER,
  PRIMARY KEY (offer_id, buyer_id)
);`);
if (!all('PRAGMA table_info(client_accounts)').some(c => c.name === 'grupo')) db.exec('ALTER TABLE client_accounts ADD COLUMN grupo TEXT');
if (!all('PRAGMA table_info(special_auths)').some(c => c.name === 'offer_id')) db.exec('ALTER TABLE special_auths ADD COLUMN offer_id INTEGER');

const today = () => new Date().toISOString().slice(0, 10);
const eur = n => Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const expired = o => o.status !== 'activa' || (o.valid_to && o.valid_to < today());
const clientsOf = sellerId => all(`SELECT c.id, c.name, c.logo, c.color, a.grupo FROM connections k JOIN companies c ON c.id=k.buyer_id
  LEFT JOIN client_accounts a ON a.seller_id=k.seller_id AND a.buyer_id=k.buyer_id WHERE k.seller_id=? AND k.status='activa' ORDER BY c.name`, sellerId);
const groupsOf = sellerId => all(`SELECT DISTINCT grupo FROM client_accounts WHERE seller_id=? AND coalesce(grupo,'')<>'' ORDER BY grupo`, sellerId).map(r => r.grupo);
const condText = o => [o.price_mode === 'precio' ? `precio ${eur(o.price)}` : `${o.discount_pct}% de descuento`, o.lead_days != null ? `entrega en ${o.lead_days} días` : '', o.min_qty ? `desde ${o.min_qty} ud` : '', o.valid_to ? `hasta el ${o.valid_to.split('-').reverse().join('/')}` : ''].filter(Boolean).join(' · ');
const newCount = buyerId => one(`SELECT count(*) n FROM offer_recipients r JOIN offers o ON o.id=r.offer_id WHERE r.buyer_id=? AND r.status='nueva' AND o.status='activa' AND (o.valid_to IS NULL OR o.valid_to>=?)`, buyerId, today()).n;

function register(app, { auth, active, bad, str, num, sellerOnly, admin }) {
  const notify = (() => { try { return require('./notify'); } catch { return null; } })();

  // Grupo de un cliente (lo pone el proveedor; el cliente no lo ve)
  app.post('/api/clientes/grupo', auth, active, sellerOnly, (req, res) => {
    const cid = req.company.id, bid = +req.body?.buyer_id;
    if (!one('SELECT id FROM connections WHERE seller_id=? AND buyer_id=?', cid, bid)) return bad(res, 'Cliente no encontrado');
    const g = str(req.body?.grupo, 60) || null;
    run(`INSERT INTO client_accounts (seller_id, buyer_id, grupo) VALUES (?,?,?) ON CONFLICT(seller_id, buyer_id) DO UPDATE SET grupo=excluded.grupo`, cid, bid, g);
    res.json({ ok: true });
  });

  const sentView = o => {
    const p = o.product_id && one('SELECT id, name, sku, unit, list_price FROM products WHERE id=?', o.product_id);
    const rs = all('SELECT r.*, c.name FROM offer_recipients r JOIN companies c ON c.id=r.buyer_id WHERE r.offer_id=?', o.id);
    const ids = rs.map(r => r.auth_id).filter(Boolean);
    const orders = ids.length ? one(`SELECT count(*) n, coalesce(sum(total),0) t FROM deals WHERE status='cerrado' AND auth_id IN (${ids.map(() => '?').join(',')})`, ...ids) : { n: 0, t: 0 };
    return { ...o, product: p || null, conditions: condText(o), state: expired(o) ? (o.status === 'activa' ? 'caducada' : o.status) : 'activa',
      recipients: rs.map(r => ({ id: r.buyer_id, name: r.name, status: r.status })), seen: rs.filter(r => r.seen).length, orders };
  };
  app.get('/api/ofertas', auth, sellerOnly, (req, res) => {
    const cid = req.company.id;
    res.json({ offers: all('SELECT * FROM offers WHERE company_id=? ORDER BY created DESC LIMIT 200', cid).map(sentView),
      clients: clientsOf(cid), groups: groupsOf(cid),
      families: all(`SELECT DISTINCT category FROM products WHERE company_id=? AND active=1 AND coalesce(category,'')<>'' ORDER BY category`, cid).map(r => r.category) });
  });

  app.post('/api/ofertas', auth, active, sellerOnly, admin, async (req, res) => {
    const b = req.body || {}, cid = req.company.id;
    const target = b.target === 'articulo' ? 'articulo' : b.target === 'familia' ? 'familia' : null;
    if (!target) return bad(res, 'Elige si la oferta es para una familia o para un artículo');
    const audience = ['cliente', 'grupo', 'todos'].includes(b.audience) ? b.audience : null;
    if (!audience) return bad(res, 'Elige a quién va la oferta');
    const p = target === 'articulo' ? one('SELECT * FROM products WHERE id=? AND company_id=? AND active=1', +b.product_id, cid) : null;
    if (target === 'articulo' && !p) return bad(res, 'Elige el artículo');
    const category = target === 'familia' ? str(b.category, 80) : null;
    if (target === 'familia' && !one('SELECT id FROM products WHERE company_id=? AND active=1 AND lower(trim(category))=lower(trim(?))', cid, category)) return bad(res, 'Elige una familia de tu catálogo');
    const price_mode = b.price_mode === 'precio' && target === 'articulo' ? 'precio' : 'descuento';
    const price = price_mode === 'precio' ? num(b.price) : null, discount_pct = price_mode === 'descuento' ? num(b.discount_pct) : null;
    if (price_mode === 'precio' && !(price > 0)) return bad(res, 'Pon el precio de la oferta');
    if (price_mode === 'descuento' && !(discount_pct > 0 && discount_pct < 90)) return bad(res, 'El descuento tiene que estar entre 0 y 90%');
    const lead_days = b.lead_days === '' || b.lead_days == null ? null : Math.max(0, Math.floor(num(b.lead_days) ?? 0));
    const min_qty = Math.floor(num(b.min_qty) ?? 0) || null;
    const valid_to = /^\d{4}-\d{2}-\d{2}$/.test(b.valid_to || '') ? b.valid_to : null;
    if (valid_to && valid_to < today()) return bad(res, 'La fecha de fin ya ha pasado');
    // destinatarios
    let clients = clientsOf(cid), grupo = null, buyer_id = null;
    if (audience === 'cliente') { buyer_id = +b.buyer_id; clients = clients.filter(c => c.id === buyer_id); if (!clients.length) return bad(res, 'Ese cliente no está conectado contigo'); }
    if (audience === 'grupo') { grupo = str(b.grupo, 60); clients = clients.filter(c => (c.grupo || '').toLowerCase() === grupo.toLowerCase()); if (!clients.length) return bad(res, 'No hay clientes conectados en ese grupo'); }
    if (!clients.length) return bad(res, 'Aún no tienes clientes conectados');
    const title = str(b.title, 120) || (target === 'familia' ? `Oferta en ${category}` : `Oferta en ${p.name}`);
    const oid = Number(run(`INSERT INTO offers (company_id, title, message, target, category, product_id, audience, buyer_id, grupo, price_mode, price, discount_pct, lead_days, min_qty, valid_to, user_id, created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, title, str(b.message, 1000), target, category, p ? p.id : null, audience, buyer_id || null, grupo, price_mode, price, discount_pct, lead_days, min_qty, valid_to, req.user.id, now()).lastInsertRowid);
    for (const c of clients) {
      // La autorización especial que aplicará el agente de ventas cuando este cliente compre
      const aid = Number(run(`INSERT INTO special_auths (company_id, scope, buyer_id, product_id, category, price_mode, price, discount_pct, lead_days, min_qty, valid_to, auto_close, reason, authorized_by, user_id, offer_id, created)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`, cid, target === 'familia' ? 'familia' : 'cliente', c.id, p ? p.id : null, category, price_mode, price, discount_pct, lead_days, min_qty, valid_to,
        `Oferta especial nº ${oid}: ${title}`, req.user.name || req.user.email, req.user.id, oid, now()).lastInsertRowid);
      run('INSERT INTO offer_recipients (offer_id, buyer_id, auth_id) VALUES (?,?,?)', oid, c.id, aid);
    }
    res.json({ ok: true, id: oid, sent: clients.length });
    // Aviso al móvil de los usuarios del cliente que lo tengan activado
    if (notify?.sendPush) for (const c of clients) for (const u of all('SELECT id FROM users WHERE company_id=?', c.id))
      notify.sendPush(u.id, { title: `Oferta de ${req.company.name}`, body: `${title}: ${condText({ price_mode, price, discount_pct, lead_days, min_qty, valid_to })}`, url: '/app#ofertas', tag: 'oferta-' + oid }).catch(() => {});
  });

  app.post('/api/ofertas/:id/retirar', auth, active, sellerOnly, admin, (req, res) => {
    const o = one('SELECT * FROM offers WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!o) return bad(res, 'Oferta no encontrada', 404);
    run(`UPDATE offers SET status='retirada' WHERE id=?`, o.id); run('UPDATE special_auths SET active=0 WHERE offer_id=?', o.id);
    res.json({ ok: true });
  });

  // Lado del cliente: ofertas recibidas
  app.get('/api/ofertas/recibidas', auth, (req, res) => {
    const rows = all(`SELECT o.*, r.status rstatus, r.auth_id, c.name seller_name, c.logo seller_logo, c.color seller_color FROM offer_recipients r JOIN offers o ON o.id=r.offer_id JOIN companies c ON c.id=o.company_id
      WHERE r.buyer_id=? AND o.status='activa' ORDER BY o.created DESC LIMIT 200`, req.company.id);
    res.json(rows.map(o => {
      const p = o.product_id && one('SELECT id, name, sku, unit, list_price, photos FROM products WHERE id=?', o.product_id);
      const ph = p ? (() => { try { return JSON.parse(p.photos || '[]')[0]; } catch { return null; } })() : null;
      const items = o.target === 'familia' ? all(`SELECT name FROM products WHERE company_id=? AND active=1 AND lower(trim(category))=lower(trim(?)) ORDER BY name LIMIT 30`, o.company_id, o.category).map(x => x.name) : [];
      return { id: o.id, title: o.title, message: o.message, target: o.target, category: o.category, items, created: o.created, valid_to: o.valid_to, expired: expired(o),
        price_mode: o.price_mode, price: o.price, discount_pct: o.discount_pct, lead_days: o.lead_days, min_qty: o.min_qty, conditions: condText(o), status: o.rstatus,
        product: p ? { id: p.id, name: p.name, sku: p.sku, unit: p.unit, list_price: p.list_price, photo: ph ? `/media/${ph}` : null } : null,
        seller: { id: o.company_id, name: o.seller_name, logo: o.seller_logo, color: o.seller_color } };
    }));
  });
  app.post('/api/ofertas/recibidas/:id/:action', auth, (req, res) => {
    const st = { vista: 'vista', descartar: 'descartada', pedir: 'pedida' }[req.params.action]; if (!st) return bad(res, 'Acción no válida');
    const r = one('SELECT * FROM offer_recipients WHERE offer_id=? AND buyer_id=?', +req.params.id, req.company.id); if (!r) return bad(res, 'Oferta no encontrada', 404);
    run('UPDATE offer_recipients SET status=?, seen=coalesce(seen,?) WHERE offer_id=? AND buyer_id=?', r.status === 'pedida' && st === 'vista' ? 'pedida' : st, now(), r.offer_id, r.buyer_id);
    res.json({ ok: true });
  });
}

module.exports = { register, newCount };
