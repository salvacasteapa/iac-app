// Doble código por artículo: el código del fabricante (del proveedor) y el código del comprador.
// Cada pareja de códigos es un "vínculo" entre un proveedor y un cliente que las DOS empresas
// tienen que confirmar. Solo un vínculo confirmado y vigente sirve para negociar por código, y
// el pedido guarda los dos códigos. Si el proveedor cambia su código, el cliente tiene que
// volver a confirmar. La descripción puede cambiar sin que el vínculo se rompa.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS item_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  mfr_code TEXT NOT NULL, buyer_code TEXT NOT NULL, buyer_desc TEXT,
  seller_ok INTEGER DEFAULT 0, buyer_ok INTEGER DEFAULT 0, created_by INTEGER,
  created INTEGER NOT NULL, confirmed INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS item_links_bcode ON item_links(seller_id, buyer_id, buyer_code);
CREATE UNIQUE INDEX IF NOT EXISTS item_links_prod ON item_links(seller_id, buyer_id, product_id);`);
const addCols = (table, list) => { const have = all(`PRAGMA table_info(${table})`).map(c => c.name); for (const [c, t] of list) if (!have.includes(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${t}`); };
addCols('products', [['ean', 'TEXT']]);
addCols('needs', [['buyer_code', 'TEXT']]);
addCols('deals', [['mfr_code', 'TEXT'], ['buyer_code', 'TEXT'], ['link_id', 'INTEGER']]);

/** Forma canónica para comparar: sin espacios y en mayúsculas ("ab-12 3" → "AB-123"). */
const norm = s => String(s ?? '').replace(/\s+/g, '').toUpperCase().slice(0, 60);
/** EAN/GTIN de 8, 12, 13 o 14 cifras con dígito de control correcto. */
function gtinOk(code) {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const d = code.split('').map(Number), check = d.pop();
  const sum = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Estado de un vínculo: confirmado (sirve para pedir), pendiente de quién, o roto. */
function linkState(l, product) {
  if (!product || !product.active) return { ok: false, state: 'roto', why: 'El proveedor ha retirado el artículo' };
  if (norm(product.sku) !== l.mfr_code) return { ok: false, state: 'cambiado', why: `El proveedor cambió su código de ${l.mfr_code} a ${norm(product.sku)}` };
  if (!l.seller_ok) return { ok: false, state: 'falta_proveedor', why: 'Falta que lo confirme el proveedor' };
  if (!l.buyer_ok) return { ok: false, state: 'falta_cliente', why: 'Falta que lo confirme el cliente' };
  return { ok: true, state: 'confirmado' };
}

/** Productos que el comprador puede pedir con SU código: solo vínculos confirmados y vigentes. */
function verifiedByBuyerCode(buyerId, buyerCode) {
  const code = norm(buyerCode);
  return all(`SELECT l.* FROM item_links l JOIN connections k ON k.seller_id=l.seller_id AND k.buyer_id=l.buyer_id AND k.status='activa'
    WHERE l.buyer_id=? AND l.buyer_code=?`, buyerId, code)
    .map(l => ({ link: l, product: one('SELECT * FROM products WHERE id=?', l.product_id) }))
    .filter(x => linkState(x.link, x.product).ok);
}
/** Vínculo confirmado entre un comprador y un producto concreto (para pedidos hechos por nombre). */
function verifiedForProduct(buyerId, product) {
  const l = one('SELECT * FROM item_links WHERE buyer_id=? AND product_id=?', buyerId, product.id);
  return l && linkState(l, product).ok ? l : null;
}

function register(app, { auth, active, bad, str }) {
  const view = (l, cid) => {
    const p = one('SELECT * FROM products WHERE id=?', l.product_id);
    const s = one('SELECT id, name FROM companies WHERE id=?', l.seller_id), b = one('SELECT id, name FROM companies WHERE id=?', l.buyer_id);
    const st = linkState(l, p);
    const as = l.seller_id === cid ? 'vendedor' : 'comprador';
    const mine = as === 'vendedor' ? 'seller_ok' : 'buyer_ok';
    return {
      id: l.id, as, seller: s, buyer: b, product: p ? { id: p.id, name: p.name, unit: p.unit, ean: p.ean, current_code: norm(p.sku) } : null,
      mfr_code: l.mfr_code, buyer_code: l.buyer_code, buyer_desc: l.buyer_desc, ...st,
      can_confirm: !st.ok && st.state !== 'roto' && (st.state === 'cambiado' ? as === 'comprador' : !l[mine]), created: l.created, confirmed: l.confirmed
    };
  };
  const mineSQL = 'SELECT * FROM item_links WHERE seller_id=? OR buyer_id=? ORDER BY buyer_code';
  app.get('/api/codes', auth, (req, res) => res.json(all(mineSQL, req.company.id, req.company.id).map(l => view(l, req.company.id))));

  // Crear un vínculo. Lo puede proponer cualquiera de las dos empresas; la otra lo confirma.
  app.post('/api/codes', auth, active, (req, res) => {
    const b = req.body || {}, cid = req.company.id;
    const p = one('SELECT * FROM products WHERE id=? AND active=1', +b.product_id);
    if (!p) return bad(res, 'Elige un artículo del proveedor');
    if (!norm(p.sku)) return bad(res, 'Ese artículo no tiene código del fabricante. El proveedor tiene que ponerlo antes en su catálogo.');
    const iAmSeller = p.company_id === cid;
    const buyerId = iAmSeller ? +b.buyer_id : cid;
    const k = one(`SELECT * FROM connections WHERE seller_id=? AND buyer_id=? AND status='activa'`, p.company_id, buyerId);
    if (!k) return bad(res, iAmSeller ? 'Ese cliente no está conectado contigo' : 'No estás conectado con ese proveedor');
    const code = norm(b.buyer_code);
    if (!code) return bad(res, 'Pon el código del artículo del cliente');
    const dupCode = one('SELECT l.*, p.name pname FROM item_links l JOIN products p ON p.id=l.product_id WHERE l.seller_id=? AND l.buyer_id=? AND l.buyer_code=?', p.company_id, buyerId, code);
    if (dupCode) return bad(res, `El código ${code} ya está vinculado a «${dupCode.pname}» (${dupCode.mfr_code}). Un código del cliente solo puede apuntar a un artículo.`);
    const dupProd = one('SELECT * FROM item_links WHERE seller_id=? AND buyer_id=? AND product_id=?', p.company_id, buyerId, p.id);
    if (dupProd) return bad(res, `Ese artículo ya está vinculado al código ${dupProd.buyer_code} del cliente.`);
    const r = run(`INSERT INTO item_links (seller_id, buyer_id, product_id, mfr_code, buyer_code, buyer_desc, seller_ok, buyer_ok, created_by, created) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      p.company_id, buyerId, p.id, norm(p.sku), code, str(b.buyer_desc, 160), iAmSeller ? 1 : 0, iAmSeller ? 0 : 1, cid, now());
    res.json(view(one('SELECT * FROM item_links WHERE id=?', Number(r.lastInsertRowid)), cid));
  });

  // Confirmar: la otra empresa comprueba que los dos códigos son el mismo artículo.
  app.post('/api/codes/:id/confirmar', auth, active, (req, res) => {
    const cid = req.company.id, l = one('SELECT * FROM item_links WHERE id=?', +req.params.id);
    if (!l || (l.seller_id !== cid && l.buyer_id !== cid)) return bad(res, 'No encontrado', 404);
    const p = one('SELECT * FROM products WHERE id=?', l.product_id);
    if (!p || !p.active) return bad(res, 'El artículo ya no está en el catálogo del proveedor');
    // Se confirma exactamente lo que la persona ha visto en pantalla
    if (req.body?.mfr_code != null && norm(req.body.mfr_code) !== norm(p.sku)) return bad(res, 'El código del fabricante ha cambiado mientras lo revisabas. Vuelve a cargar la página.');
    if (l.seller_id === cid) run('UPDATE item_links SET seller_ok=1, mfr_code=? WHERE id=?', norm(p.sku), l.id);
    else run('UPDATE item_links SET buyer_ok=1, mfr_code=? WHERE id=?', norm(p.sku), l.id);
    const n = one('SELECT * FROM item_links WHERE id=?', l.id);
    if (n.seller_ok && n.buyer_ok) run('UPDATE item_links SET confirmed=? WHERE id=?', now(), l.id);
    res.json(view(one('SELECT * FROM item_links WHERE id=?', l.id), cid));
  });
  app.delete('/api/codes/:id', auth, active, (req, res) => {
    const cid = req.company.id; run('DELETE FROM item_links WHERE id=? AND (seller_id=? OR buyer_id=?)', +req.params.id, cid, cid); res.json({ ok: true });
  });
}

module.exports = { register, norm, gtinOk, linkState, verifiedByBuyerCode, verifiedForProduct };
