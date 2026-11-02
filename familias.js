// Familias de artículos: tabla propia por empresa, para listarlas y sacar estadísticas.
// El artículo guarda family_id; el nombre se copia también en products.category porque
// autorizaciones especiales y ofertas lo usan para encontrar los artículos de la familia.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, code TEXT, description TEXT,
  active INTEGER DEFAULT 1, created INTEGER NOT NULL,
  UNIQUE (company_id, name)
);`);
{ const have = all('PRAGMA table_info(products)').map(c => c.name);
  if (!have.includes('category')) db.exec('ALTER TABLE products ADD COLUMN category TEXT');
  if (!have.includes('family_id')) db.exec('ALTER TABLE products ADD COLUMN family_id INTEGER'); }
// Paso único: las familias que ya estaban escritas a mano en los artículos pasan a la tabla
for (const r of all(`SELECT DISTINCT company_id, trim(category) name FROM products WHERE family_id IS NULL AND coalesce(trim(category),'')<>''`)) {
  run('INSERT OR IGNORE INTO families (company_id, name, created) VALUES (?,?,?)', r.company_id, r.name, now());
  const f = one('SELECT id, name FROM families WHERE company_id=? AND name=?', r.company_id, r.name);
  run(`UPDATE products SET family_id=?, category=? WHERE company_id=? AND family_id IS NULL AND lower(trim(category))=lower(?)`, f.id, f.name, r.company_id, r.name);
}

/** Familia del artículo: por id de la lista o, si llega un nombre, la busca o la crea. */
function resolve(cid, b) {
  if (+b.family_id) { const f = one('SELECT * FROM families WHERE id=? AND company_id=?', +b.family_id, cid); return f ? { family_id: f.id, category: f.name } : { error: 'Esa familia no existe' }; }
  const name = String(b.category ?? '').trim().slice(0, 80);
  if (!name) return { family_id: null, category: '' };
  let f = one('SELECT * FROM families WHERE company_id=? AND name=?', cid, name);
  if (!f) { run('INSERT INTO families (company_id, name, created) VALUES (?,?,?)', cid, name, now()); f = one('SELECT * FROM families WHERE company_id=? AND name=?', cid, name); }
  if (!f.active) run('UPDATE families SET active=1 WHERE id=?', f.id);
  return { family_id: f.id, category: f.name };
}

const DAY = 864e5;
function stats(cid, from, to) {
  const fams = all('SELECT * FROM families WHERE company_id=? ORDER BY active DESC, name', cid);
  const sales = all(`SELECT p.family_id fid, count(*) orders, coalesce(sum(d.qty),0) units, coalesce(sum(d.total),0) revenue,
      coalesce(sum((d.price - coalesce(p.cost,0)) * d.qty),0) margin, count(DISTINCT d.buyer_id) clients, coalesce(avg((p.list_price - d.price) / p.list_price * 100),0) disc
    FROM deals d JOIN products p ON p.id=d.product_id WHERE d.seller_id=? AND d.status='cerrado' AND d.closed>=? AND d.closed<? GROUP BY p.family_id`, cid, from, to);
  const lost = all(`SELECT p.family_id fid, count(*) n FROM deals d JOIN products p ON p.id=d.product_id WHERE d.seller_id=? AND d.status IN ('sin_acuerdo','descartada','rechazado') AND d.created>=? AND d.created<? GROUP BY p.family_id`, cid, from, to);
  const prev = all(`SELECT p.family_id fid, coalesce(sum(d.total),0) revenue FROM deals d JOIN products p ON p.id=d.product_id WHERE d.seller_id=? AND d.status='cerrado' AND d.closed>=? AND d.closed<? GROUP BY p.family_id`, cid, from - (to - from), from);
  const by = (rows, id) => rows.find(r => r.fid === id);
  const row = (f, id) => {
    const s = by(sales, id) || { orders: 0, units: 0, revenue: 0, margin: 0, clients: 0, disc: 0 }, l = by(lost, id)?.n || 0, pv = by(prev, id)?.revenue || 0;
    const top = all(`SELECT c.name, sum(d.total) t FROM deals d JOIN products p ON p.id=d.product_id JOIN companies c ON c.id=d.buyer_id WHERE d.seller_id=? AND d.status='cerrado' AND d.closed>=? AND d.closed<? AND p.family_id IS ? GROUP BY d.buyer_id ORDER BY t DESC LIMIT 3`, cid, from, to, id);
    return { ...f, items: one('SELECT count(*) n FROM products WHERE company_id=? AND active=1 AND family_id IS ?', cid, id).n,
      orders: s.orders, units: s.units, revenue: Math.round(s.revenue * 100) / 100, margin: Math.round(s.margin * 100) / 100, clients: s.clients,
      avg_discount: Math.round(s.disc * 10) / 10, lost: l, win_rate: s.orders + l ? Math.round(s.orders / (s.orders + l) * 100) : null,
      prev_revenue: Math.round(pv * 100) / 100, growth: pv ? Math.round((s.revenue - pv) / pv * 1000) / 10 : null, top_clients: top,
      offers: f.name ? one(`SELECT count(*) n FROM offers WHERE company_id=? AND status='activa' AND target='familia' AND category=?`, cid, f.name).n : 0 };
  };
  const list = fams.map(f => row({ id: f.id, name: f.name, code: f.code, description: f.description, active: !!f.active, created: f.created }, f.id));
  const none = row({ id: null, name: null, code: null, description: null, active: true }, null);
  if (none.items || none.orders) list.push(none);
  return list;
}

function register(app, { auth, active, bad, str, sellerOnly, admin }) {
  app.get('/api/familias', auth, sellerOnly, (req, res) => {
    if (req.query.lista) return res.json(all('SELECT id, name, code FROM families WHERE company_id=? AND active=1 ORDER BY name', req.company.id));
    const days = { 30: 30, 90: 90, 365: 365 }[req.query.dias] || null, to = now() + 1, from = days ? to - days * DAY : 0;
    const list = stats(req.company.id, from, to);
    const tot = list.reduce((a, f) => ({ revenue: a.revenue + f.revenue, orders: a.orders + f.orders, margin: a.margin + f.margin }), { revenue: 0, orders: 0, margin: 0 });
    res.json({ dias: days, families: list, totals: tot });
  });
  const clean = (b, cid, id = 0) => {
    const name = str(b.name, 80); if (!name) return { error: 'Pon el nombre de la familia' };
    if (one('SELECT id FROM families WHERE company_id=? AND name=? AND id<>?', cid, name, id)) return { error: `Ya tienes la familia ${name}` };
    return { name, code: str(b.code, 30).toUpperCase() || null, description: str(b.description, 500) || null };
  };
  app.post('/api/familias', auth, active, sellerOnly, (req, res) => {
    const f = clean(req.body || {}, req.company.id); if (f.error) return bad(res, f.error);
    const r = run('INSERT INTO families (company_id, name, code, description, created) VALUES (?,?,?,?,?)', req.company.id, f.name, f.code, f.description, now());
    res.json({ ok: true, id: Number(r.lastInsertRowid), name: f.name });
  });
  app.put('/api/familias/:id', auth, active, sellerOnly, admin, (req, res) => {
    const cid = req.company.id, old = one('SELECT * FROM families WHERE id=? AND company_id=?', +req.params.id, cid); if (!old) return bad(res, 'Familia no encontrada', 404);
    const f = clean(req.body || {}, cid, old.id); if (f.error) return bad(res, f.error);
    run('UPDATE families SET name=?, code=?, description=?, active=1 WHERE id=?', f.name, f.code, f.description, old.id);
    if (f.name !== old.name) {
      // El nuevo nombre llega a los artículos, autorizaciones y ofertas de la familia
      run('UPDATE products SET category=? WHERE company_id=? AND family_id=?', f.name, cid, old.id);
      run('UPDATE special_auths SET category=? WHERE company_id=? AND lower(category)=lower(?)', f.name, cid, old.name);
      try { run('UPDATE offers SET category=? WHERE company_id=? AND lower(category)=lower(?)', f.name, cid, old.name); } catch { }
    }
    res.json({ ok: true });
  });
  app.delete('/api/familias/:id', auth, active, sellerOnly, admin, (req, res) => {
    const f = one('SELECT * FROM families WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!f) return bad(res, 'Familia no encontrada', 404);
    const n = one('SELECT count(*) n FROM products WHERE family_id=? AND active=1', f.id).n;
    if (n) return bad(res, `La familia tiene ${n} artículo${n > 1 ? 's' : ''}. Pásalos a otra familia antes de darla de baja.`);
    // Se da de baja (no se borra) para no perder las estadísticas de pedidos antiguos
    run('UPDATE families SET active=0 WHERE id=?', f.id);
    res.json({ ok: true });
  });
}

module.exports = { register, resolve };
