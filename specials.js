// Autorizaciones especiales del jefe de ventas: condiciones fuera de las reglas generales
// para un pedido concreto, para una familia de productos o para un cliente.
// Cada una fija un precio especial (o un descuento máximo) y, si quiere, un plazo de entrega especial.
// El agente de ventas las aplica al negociar y el pedido deja constancia de quién las autorizó.
const { db, one, all, run, now } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS special_auths (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('pedido','familia','cliente')),
  buyer_id INTEGER, product_id INTEGER, category TEXT,
  price_mode TEXT NOT NULL DEFAULT 'precio', price REAL, discount_pct REAL,
  lead_days INTEGER, min_qty INTEGER, max_qty INTEGER,
  valid_from TEXT, valid_to TEXT, uses_max INTEGER, uses INTEGER DEFAULT 0,
  auto_close INTEGER DEFAULT 1, reason TEXT, authorized_by TEXT, user_id INTEGER,
  active INTEGER DEFAULT 1, created INTEGER NOT NULL
);`);
{ const have = all('PRAGMA table_info(deals)').map(c => c.name); if (!have.includes('auth_id')) db.exec('ALTER TABLE deals ADD COLUMN auth_id INTEGER'); }

const r2 = n => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const SCOPE_T = { pedido: 'Pedido', familia: 'Familia', cliente: 'Cliente' };

/** Estado de una autorización hoy. */
function authState(a) {
  if (!a.active) return 'desactivada';
  if (a.valid_from && a.valid_from > today()) return 'futura';
  if (a.valid_to && a.valid_to < today()) return 'caducada';
  if (a.uses_max && a.uses >= a.uses_max) return 'agotada';
  return 'activa';
}
/** Precio suelo y de salida que permite una autorización sobre un artículo. */
function authPrices(a, p) {
  if (a.price_mode === 'precio') return { floor: r2(a.price), open: r2(Math.min(p.list_price, a.price)), fixed: true };
  const off = r2(p.list_price * (1 - a.discount_pct / 100));
  // Una oferta especial enviada al cliente es un precio cerrado: se aplica tal cual, sin regatear
  if (a.offer_id) return { floor: off, open: off, fixed: true };
  return { floor: off, open: p.list_price };
}
/** Descripción corta, para el registro de la negociación y el pedido. */
function authText(a, p) {
  const parts = [];
  if (a.price_mode === 'precio') parts.push(`precio especial ${a.price.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`);
  else parts.push(`descuento hasta ${a.discount_pct}%`);
  if (a.lead_days != null) parts.push(`plazo ${a.lead_days} días`);
  return `Autorización especial nº ${a.id} (${SCOPE_T[a.scope].toLowerCase()}${a.scope === 'familia' ? ' ' + a.category : ''}), autorizada por ${a.authorized_by || 'el jefe de ventas'}: ${parts.join(', ')}.`;
}

/**
 * La autorización que aplica a este artículo, cliente y cantidad. Prioridad: la más concreta.
 * pedido > cliente con artículo > familia del cliente > cliente (toda la gama) > familia para todos.
 */
function findAuth(sellerId, buyerId, product, qty) {
  const cands = all(`SELECT * FROM special_auths WHERE company_id=? AND active=1 AND (buyer_id IS NULL OR buyer_id=?)`, sellerId, buyerId)
    .filter(a => authState(a) === 'activa')
    .filter(a => (a.min_qty == null || qty >= a.min_qty) && (a.max_qty == null || qty <= a.max_qty))
    .filter(a => a.scope === 'familia' ? (product.category || '').trim().toLowerCase() === (a.category || '').trim().toLowerCase()
      : a.product_id ? a.product_id === product.id : a.scope === 'cliente');
  const rank = a => a.scope === 'pedido' ? 0 : a.scope === 'cliente' && a.product_id ? 1 : a.scope === 'familia' && a.buyer_id ? 2 : a.scope === 'cliente' ? 3 : 4;
  return cands.sort((x, y) => rank(x) - rank(y) || x.id - y.id)[0] || null;
}

function register(app, { auth, active, bad, str, num, sellerOnly, admin }) {
  const view = a => {
    const b = a.buyer_id && one('SELECT id, name FROM companies WHERE id=?', a.buyer_id);
    const p = a.product_id && one('SELECT id, name, sku, unit, list_price, min_price, lead_days FROM products WHERE id=?', a.product_id);
    return { ...a, auto_close: !!a.auto_close, active: !!a.active, buyer: b || null, product: p || null, state: authState(a),
      deals: one('SELECT count(*) n, coalesce(sum(total),0) t FROM deals WHERE auth_id=? AND status=\'cerrado\'', a.id) };
  };
  app.get('/api/specials', auth, sellerOnly, (req, res) => res.json(all('SELECT * FROM special_auths WHERE company_id=? ORDER BY active DESC, created DESC', req.company.id).map(view)));
  app.post('/api/specials', auth, active, sellerOnly, admin, (req, res) => {
    const b = req.body || {}, cid = req.company.id;
    const scope = SCOPE_T[b.scope] ? b.scope : null; if (!scope) return bad(res, 'Elige si es para un pedido, una familia o un cliente');
    const buyer_id = +b.buyer_id || null;
    if (buyer_id && !one(`SELECT id FROM connections WHERE seller_id=? AND buyer_id=? AND status='activa'`, cid, buyer_id)) return bad(res, 'Ese cliente no está conectado contigo');
    if ((scope === 'pedido' || scope === 'cliente') && !buyer_id) return bad(res, 'Elige el cliente');
    const p = +b.product_id ? one('SELECT * FROM products WHERE id=? AND company_id=? AND active=1', +b.product_id, cid) : null;
    if (scope === 'pedido' && !p) return bad(res, 'Elige el artículo del pedido');
    const category = scope === 'familia' ? str(b.category, 80) : null;
    if (scope === 'familia' && !category) return bad(res, 'Elige la familia de productos');
    const price_mode = b.price_mode === 'descuento' ? 'descuento' : 'precio';
    const price = price_mode === 'precio' ? num(b.price) : null, discount_pct = price_mode === 'descuento' ? num(b.discount_pct) : null;
    if (price_mode === 'precio' && !(price > 0)) return bad(res, 'Pon el precio especial');
    if (price_mode === 'precio' && scope === 'familia') return bad(res, 'Para una familia usa un descuento máximo: cada artículo tiene su precio');
    if (price_mode === 'precio' && scope === 'cliente' && !p) return bad(res, 'Un precio especial para un cliente va con un artículo. Para toda la gama usa un descuento máximo.');
    if (price_mode === 'descuento' && !(discount_pct > 0 && discount_pct < 90)) return bad(res, 'El descuento tiene que estar entre 0 y 90%');
    const lead_days = b.lead_days === '' || b.lead_days == null ? null : Math.max(0, Math.floor(num(b.lead_days) ?? 0));
    const min_qty = Math.floor(num(b.min_qty) ?? 0) || null, max_qty = Math.floor(num(b.max_qty) ?? 0) || null;
    if (min_qty && max_qty && min_qty > max_qty) return bad(res, 'La cantidad mínima no puede ser mayor que la máxima');
    const date = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
    const valid_from = date(b.valid_from), valid_to = date(b.valid_to);
    if (valid_from && valid_to && valid_from > valid_to) return bad(res, 'La fecha de fin es anterior a la de inicio');
    const uses_max = scope === 'pedido' ? Math.max(1, Math.floor(num(b.uses_max) ?? 1)) : (Math.floor(num(b.uses_max) ?? 0) || null);
    const r = run(`INSERT INTO special_auths (company_id, scope, buyer_id, product_id, category, price_mode, price, discount_pct, lead_days, min_qty, max_qty, valid_from, valid_to, uses_max, auto_close, reason, authorized_by, user_id, created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, cid, scope, buyer_id, p ? p.id : null, category, price_mode, price, discount_pct, lead_days, min_qty, max_qty, valid_from, valid_to, uses_max,
      b.auto_close === false || b.auto_close === 'false' ? 0 : 1, str(b.reason, 500), req.user.name || req.user.email, req.user.id, now());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });
  app.post('/api/specials/:id/:action', auth, active, sellerOnly, admin, (req, res) => {
    const a = one('SELECT * FROM special_auths WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!a) return bad(res, 'No encontrada', 404);
    if (!['activar', 'desactivar'].includes(req.params.action)) return bad(res, 'Acción no válida');
    run('UPDATE special_auths SET active=? WHERE id=?', req.params.action === 'activar' ? 1 : 0, a.id); res.json({ ok: true });
  });
}

module.exports = { register, findAuth, authPrices, authText, authState };
