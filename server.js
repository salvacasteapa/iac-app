// IAC · servidor web. Arranque: npm start  (puerto PORT, por defecto 8080)
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { one, all, run, now, getPolicy, setPolicy } = require('./db');
const { negotiate, scoreOffers, approvals } = require('./negotiation');

const PORT = +process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const TRIAL_DAYS = +process.env.TRIAL_DAYS || 14;
const DAY = 864e5;

const PLANS = {
  comprador: { name: 'Compras', price: +process.env.PRICE_COMPRADOR || 29, stripe: process.env.STRIPE_PRICE_COMPRADOR, roles: ['comprador'] },
  vendedor: { name: 'Ventas', price: +process.env.PRICE_VENDEDOR || 99, stripe: process.env.STRIPE_PRICE_VENDEDOR, roles: ['vendedor'] },
  empresa: { name: 'Compras + Ventas', price: +process.env.PRICE_EMPRESA || 149, stripe: process.env.STRIPE_PRICE_EMPRESA, roles: ['comprador', 'vendedor', 'ambos'] }
};
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const AGENT_KEY = process.env.ANTHROPIC_API_KEY;
const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-haiku-5-5';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- Stripe webhook (necesita el cuerpo sin procesar) ----------
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(400).send('webhook no configurado');
  const sig = String(req.headers['stripe-signature'] || '');
  const parts = Object.fromEntries(sig.split(',').map(x => x.split('=')));
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${req.body}`).digest('hex');
  const ok = parts.v1 && parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  if (!ok || Math.abs(Date.now() / 1000 - +parts.t) > 600) return res.status(400).send('firma no válida');
  const ev = JSON.parse(req.body);
  const o = ev.data.object;
  if (ev.type === 'checkout.session.completed') {
    const cid = +o.client_reference_id;
    run('UPDATE companies SET plan=?, plan_status=?, plan_until=?, stripe_customer=?, stripe_subscription=? WHERE id=?',
      o.metadata?.plan || null, 'active', now() + 32 * DAY, o.customer || null, o.subscription || null, cid);
  } else if (ev.type === 'invoice.paid') {
    run('UPDATE companies SET plan_status=?, plan_until=? WHERE stripe_customer=?', 'active', now() + 32 * DAY, o.customer);
  } else if (ev.type === 'customer.subscription.deleted' || ev.type === 'invoice.payment_failed') {
    run('UPDATE companies SET plan_status=? WHERE stripe_customer=?', ev.type === 'invoice.payment_failed' ? 'impagado' : 'cancelado', o.customer);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));

// ---------- utilidades ----------
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const check = (pw, stored) => { const [salt, h] = stored.split(':'); const x = crypto.scryptSync(pw, salt, 64); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = (v, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : null; };
const isActive = c => ['trial', 'active'].includes(c.plan_status) && (c.plan_until || 0) > now();
const sellerSide = c => c.role === 'vendedor' || c.role === 'ambos';
const buyerSide = c => c.role === 'comprador' || c.role === 'ambos';
const newCode = name => (name.normalize('NFD').replace(/[^\w]/g, '').toUpperCase().slice(0, 6) || 'EMP') + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
const publicCompany = c => c && ({ id: c.id, name: c.name, code: c.code, role: c.role, logo: c.logo, color: c.color, tax_id: c.tax_id, address: c.address, phone: c.phone, web: c.web });

function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)', token, userId, now() + 30 * DAY);
  res.setHeader('Set-Cookie', `iac_s=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
}
function auth(req, res, next) {
  const t = cookies(req).iac_s;
  const s = t && one('SELECT * FROM sessions WHERE token=? AND expires>?', t, now());
  if (!s) return bad(res, 'Sesión caducada', 401);
  req.user = one('SELECT * FROM users WHERE id=?', s.user_id);
  req.company = req.user && one('SELECT * FROM companies WHERE id=?', req.user.company_id);
  if (!req.user || !req.company) return bad(res, 'Sesión no válida', 401);
  next();
}
const active = (req, res, next) => isActive(req.company) || req.user.is_super ? next() : bad(res, 'Tu membresía no está activa. Revisa la sección Membresía.', 402);
const admin = (req, res, next) => req.user.is_admin ? next() : bad(res, 'Solo el administrador de la empresa puede hacer esto', 403);
const sellerOnly = (req, res, next) => sellerSide(req.company) ? next() : bad(res, 'Solo para empresas que venden', 403);
const buyerOnly = (req, res, next) => buyerSide(req.company) ? next() : bad(res, 'Solo para empresas que compran', 403);

// ---------- cuentas ----------
app.post('/api/signup', (req, res) => {
  const b = req.body || {};
  const company = str(b.company, 120), name = str(b.name, 120), email = str(b.email, 160).toLowerCase(), password = String(b.password || '');
  const role = ['comprador', 'vendedor', 'ambos'].includes(b.role) ? b.role : null;
  if (!company || !email.includes('@') || password.length < 8 || !role) return bad(res, 'Rellena empresa, tipo, email y una contraseña de al menos 8 caracteres');
  if (one('SELECT id FROM users WHERE email=?', email)) return bad(res, 'Ese email ya tiene cuenta');
  const c = run('INSERT INTO companies (name, code, role, plan, plan_status, plan_until, created) VALUES (?,?,?,?,?,?,?)',
    company, newCode(company), role, role === 'ambos' ? 'empresa' : role, 'trial', now() + TRIAL_DAYS * DAY, now());
  const cid = Number(c.lastInsertRowid);
  const u = run('INSERT INTO users (company_id, email, name, pass, is_admin, is_super, created) VALUES (?,?,?,?,1,?,?)',
    cid, email, name, hash(password), ADMIN_EMAIL && email === ADMIN_EMAIL ? 1 : 0, now());
  // Invitación de un proveedor: crea la solicitud de conexión pendiente
  const inv = str(b.invite, 40).toUpperCase();
  const seller = inv && one('SELECT * FROM companies WHERE code=?', inv);
  if (seller && sellerSide(seller) && role !== 'vendedor') {
    run('INSERT OR IGNORE INTO connections (seller_id, buyer_id, status, message, created) VALUES (?,?,?,?,?)', seller.id, cid, 'pendiente', 'Invitación por enlace', now());
  }
  startSession(res, req, Number(u.lastInsertRowid));
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const email = str(req.body?.email, 160).toLowerCase();
  const u = one('SELECT * FROM users WHERE email=?', email);
  if (!u || !check(String(req.body?.password || ''), u.pass)) return bad(res, 'Email o contraseña incorrectos', 401);
  startSession(res, req, u.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const t = cookies(req).iac_s; if (t) run('DELETE FROM sessions WHERE token=?', t);
  res.setHeader('Set-Cookie', 'iac_s=; Path=/; Max-Age=0'); res.json({ ok: true });
});
app.get('/api/invite/:code', (req, res) => {
  const c = one('SELECT * FROM companies WHERE code=?', str(req.params.code, 40).toUpperCase());
  res.json(c && sellerSide(c) ? { name: c.name, logo: c.logo, color: c.color } : null);
});
app.get('/api/me', auth, (req, res) => {
  const c = req.company;
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, is_admin: !!req.user.is_admin, is_super: !!req.user.is_super },
    company: { ...publicCompany(c), plan: c.plan, plan_status: c.plan_status, plan_until: c.plan_until, active: isActive(c) },
    plans: Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, { name: p.name, price: p.price, roles: p.roles }])),
    features: { stripe: !!STRIPE_KEY, instrucciones: !!AGENT_KEY }
  });
});

// ---------- empresa y usuarios ----------
app.put('/api/company', auth, admin, (req, res) => {
  const b = req.body || {};
  const logo = b.logo === null ? null : (typeof b.logo === 'string' && /^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(b.logo) && b.logo.length < 700000 ? b.logo : req.company.logo);
  const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : req.company.color;
  run('UPDATE companies SET name=?, color=?, logo=?, tax_id=?, address=?, phone=?, web=? WHERE id=?',
    str(b.name, 120) || req.company.name, color, logo, str(b.tax_id, 40), str(b.address, 300), str(b.phone, 40), str(b.web, 120), req.company.id);
  res.json({ ok: true });
});
app.get('/api/users', auth, (req, res) => res.json(all('SELECT id, name, email, is_admin FROM users WHERE company_id=?', req.company.id)));
app.post('/api/users', auth, admin, (req, res) => {
  const email = str(req.body?.email, 160).toLowerCase(), pw = String(req.body?.password || '');
  if (!email.includes('@') || pw.length < 8) return bad(res, 'Email y contraseña de al menos 8 caracteres');
  if (one('SELECT id FROM users WHERE email=?', email)) return bad(res, 'Ese email ya tiene cuenta');
  run('INSERT INTO users (company_id, email, name, pass, is_admin, created) VALUES (?,?,?,?,?,?)', req.company.id, email, str(req.body?.name, 120), hash(pw), req.body?.is_admin ? 1 : 0, now());
  res.json({ ok: true });
});
app.delete('/api/users/:id', auth, admin, (req, res) => {
  if (+req.params.id === req.user.id) return bad(res, 'No puedes borrarte a ti mismo');
  run('DELETE FROM users WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true });
});

// ---------- políticas de los agentes ----------
const side = s => (s === 'compra' || s === 'venta') ? s : null;
app.get('/api/policy/:side', auth, (req, res) => side(req.params.side) ? res.json(getPolicy(req.company.id, req.params.side)) : bad(res, 'Lado no válido'));
app.put('/api/policy/:side', auth, active, (req, res) => {
  const s = side(req.params.side); if (!s) return bad(res, 'Lado no válido');
  const cur = getPolicy(req.company.id, s), b = req.body || {};
  const merged = sanitizePolicy(s, b, cur);
  setPolicy(req.company.id, s, merged);
  res.json(merged);
});
function sanitizePolicy(s, b, cur) {
  const out = structuredClone(cur);
  const bool = (o, k, src) => { if (src && k in src) o[k] = !!src[k]; };
  const n = (o, k, src, min = 0, max = 1e9) => { if (src && k in src) { const v = Number(src[k]); if (Number.isFinite(v)) o[k] = Math.min(max, Math.max(min, v)); } };
  if (['duro', 'equilibrado', 'flexible'].includes(b.estilo)) out.estilo = b.estilo;
  if ('instrucciones' in b) out.instrucciones = str(b.instrucciones, 2000);
  if (b.cierre) { if (['auto', 'aprobacion'].includes(b.cierre.modo)) out.cierre.modo = b.cierre.modo; n(out.cierre, 'importe_max_auto', b.cierre); n(out.cierre, 'descuento_max_auto', b.cierre, 0, 100); }
  if (s === 'venta') {
    for (const k of ['catalogo', 'stock', 'plazo', 'costes']) bool(out.mostrar, k, b.mostrar);
    for (const k of ['margen', 'volumen', 'rotacion']) n(out.prioridades, k, b.prioridades, 0, 100);
    n(out, 'margen_min_pct', b, 0, 500);
  } else {
    for (const k of ['consumo', 'prevision', 'stock']) bool(out.compartir, k, b.compartir);
    for (const k of ['precio', 'plazo', 'fiabilidad']) n(out.prioridades, k, b.prioridades, 0, 100);
    bool(out, 'acepta_parciales', b);
  }
  return out;
}
// Órdenes del gestor en lenguaje natural. El agente las traduce a cambios de su política.
app.post('/api/policy/:side/instruct', auth, active, async (req, res) => {
  const s = side(req.params.side); if (!s) return bad(res, 'Lado no válido');
  const text = str(req.body?.text, 1000); if (!text) return bad(res, 'Escribe una orden');
  const cur = getPolicy(req.company.id, s);
  if (!AGENT_KEY) {
    cur.instrucciones = text; setPolicy(req.company.id, s, cur);
    return res.json({ policy: cur, explicacion: 'Orden guardada. Ajusta los valores de la política para aplicarla.', cambios: [] });
  }
  const prompt = `Eres el agente de ${s === 'venta' ? 'VENTAS' : 'COMPRAS'} de la empresa "${req.company.name}". Tu gestor te da esta orden:
"${text}"
Tu política actual (JSON): ${JSON.stringify(cur)}
Significado: estilo = duro|equilibrado|flexible; cierre.modo = auto|aprobacion; importes en euros; prioridades de 0 a 100.
Responde SOLO con un JSON: {"cambios": <objeto con SOLO las claves de la política que cambian, misma estructura>, "explicacion": "<una o dos frases en español, primera persona, diciendo qué harás distinto>"}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': AGENT_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AGENT_MODEL, max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    const txt = (j.content || []).map(c => c.text || '').join('');
    const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    const merged = sanitizePolicy(s, { ...(parsed.cambios || {}), instrucciones: text }, cur);
    setPolicy(req.company.id, s, merged);
    res.json({ policy: merged, explicacion: str(parsed.explicacion, 500) || 'Orden aplicada.' });
  } catch (e) {
    cur.instrucciones = text; setPolicy(req.company.id, s, cur);
    res.json({ policy: cur, explicacion: 'Orden guardada. No he podido aplicarla automáticamente; revisa los valores.' });
  }
});

// ---------- catálogo del vendedor ----------
const productIn = b => ({ sku: str(b.sku, 60), name: str(b.name, 160), unit: str(b.unit, 20) || 'ud', list_price: num(b.list_price), min_price: num(b.min_price), cost: num(b.cost) ?? 0, stock: Math.floor(num(b.stock) ?? 0), lead_days: Math.floor(num(b.lead_days) ?? 3) });
app.get('/api/products', auth, sellerOnly, (req, res) => res.json(all('SELECT * FROM products WHERE company_id=? AND active=1 ORDER BY name', req.company.id)));
app.post('/api/products', auth, active, sellerOnly, (req, res) => {
  const p = productIn(req.body || {});
  if (!p.name || p.list_price === null || p.min_price === null || p.min_price > p.list_price) return bad(res, 'Nombre, precio de lista y precio mínimo (no mayor que el de lista)');
  run('INSERT INTO products (company_id, sku, name, unit, list_price, min_price, cost, stock, lead_days) VALUES (?,?,?,?,?,?,?,?,?)',
    req.company.id, p.sku, p.name, p.unit, p.list_price, p.min_price, p.cost, p.stock, p.lead_days);
  res.json({ ok: true });
});
app.put('/api/products/:id', auth, active, sellerOnly, (req, res) => {
  const p = productIn(req.body || {});
  if (!p.name || p.list_price === null || p.min_price === null || p.min_price > p.list_price) return bad(res, 'Revisa nombre y precios');
  run('UPDATE products SET sku=?, name=?, unit=?, list_price=?, min_price=?, cost=?, stock=?, lead_days=? WHERE id=? AND company_id=?',
    p.sku, p.name, p.unit, p.list_price, p.min_price, p.cost, p.stock, p.lead_days, +req.params.id, req.company.id);
  res.json({ ok: true });
});
app.delete('/api/products/:id', auth, active, sellerOnly, (req, res) => { run('UPDATE products SET active=0 WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true }); });

// ---------- conexiones ----------
app.get('/api/connections', auth, (req, res) => {
  const cid = req.company.id;
  const rows = all(`SELECT k.*, s.name s_name, s.logo s_logo, s.color s_color, s.code s_code, b.name b_name, b.logo b_logo, b.color b_color, b.code b_code
    FROM connections k JOIN companies s ON s.id=k.seller_id JOIN companies b ON b.id=k.buyer_id WHERE k.seller_id=? OR k.buyer_id=? ORDER BY k.created DESC`, cid, cid);
  res.json(rows.map(r => ({
    id: r.id, status: r.status, message: r.message, created: r.created,
    as: r.seller_id === cid ? 'vendedor' : 'comprador',
    other: r.seller_id === cid ? { name: r.b_name, logo: r.b_logo, color: r.b_color, code: r.b_code } : { name: r.s_name, logo: r.s_logo, color: r.s_color, code: r.s_code },
    shared: r.seller_id === cid && r.status === 'activa' ? getPolicy(r.buyer_id, 'compra').compartir : null
  })));
});
app.post('/api/connections', auth, active, sellerOnly, (req, res) => {
  const buyer = one('SELECT * FROM companies WHERE code=?', str(req.body?.code, 40).toUpperCase());
  if (!buyer || !buyerSide(buyer)) return bad(res, 'No existe ninguna empresa compradora con ese código');
  if (buyer.id === req.company.id) return bad(res, 'No puedes conectarte contigo mismo');
  const ex = one('SELECT * FROM connections WHERE seller_id=? AND buyer_id=?', req.company.id, buyer.id);
  if (ex && ex.status === 'activa') return bad(res, 'Ya estáis conectados');
  if (ex) run('UPDATE connections SET status=?, message=?, created=? WHERE id=?', 'pendiente', str(req.body?.message, 600), now(), ex.id);
  else run('INSERT INTO connections (seller_id, buyer_id, status, message, created) VALUES (?,?,?,?,?)', req.company.id, buyer.id, 'pendiente', str(req.body?.message, 600), now());
  res.json({ ok: true });
});
app.post('/api/connections/:id/status', auth, active, (req, res) => {
  const k = one('SELECT * FROM connections WHERE id=?', +req.params.id);
  const st = req.body?.status;
  if (!k || (k.buyer_id !== req.company.id && k.seller_id !== req.company.id)) return bad(res, 'Conexión no encontrada', 404);
  const isBuyer = k.buyer_id === req.company.id;
  const allowed = isBuyer ? ['activa', 'rechazada', 'pausada'] : ['pausada'];
  if (!allowed.includes(st)) return bad(res, 'Solo el cliente puede autorizar la conexión');
  run('UPDATE connections SET status=? WHERE id=?', st, k.id);
  res.json({ ok: true });
});

// Catálogo visible para el comprador: productos de sus proveedores conectados
app.get('/api/catalog', auth, buyerOnly, (req, res) => {
  const rows = all(`SELECT p.*, c.name seller_name, c.id seller_id FROM products p JOIN connections k ON k.seller_id=p.company_id AND k.buyer_id=? AND k.status='activa'
    JOIN companies c ON c.id=p.company_id WHERE p.active=1 ORDER BY p.name`, req.company.id);
  res.json(rows.filter(p => getPolicy(p.seller_id, 'venta').mostrar.catalogo).map(p => {
    const m = getPolicy(p.seller_id, 'venta').mostrar;
    return { name: p.name, unit: p.unit, seller: p.seller_name, list_price: p.list_price, stock: m.stock ? p.stock : null, lead_days: m.plazo ? p.lead_days : null, cost: m.costes ? p.cost : null };
  }));
});

// ---------- necesidades y negociación ----------
app.get('/api/needs', auth, buyerOnly, (req, res) => res.json(all('SELECT * FROM needs WHERE buyer_id=? ORDER BY created DESC LIMIT 100', req.company.id)));
app.post('/api/needs', auth, active, buyerOnly, (req, res) => {
  const b = req.body || {};
  const need = {
    product_name: str(b.product_name, 160), qty: Math.floor(num(b.qty, 1) ?? 0), target_price: num(b.target_price), max_price: num(b.max_price),
    max_days: Math.floor(num(b.max_days, 0) ?? 0), consumption: Math.floor(num(b.consumption) ?? 0) || null, forecast: Math.floor(num(b.forecast) ?? 0) || null, buyer_stock: Math.floor(num(b.buyer_stock) ?? 0) || null
  };
  if (!need.product_name || !need.qty || need.target_price === null || need.max_price === null || need.max_price < need.target_price || !need.max_days)
    return bad(res, 'Producto, cantidad, plazo, precio objetivo y precio máximo (mayor o igual que el objetivo)');
  const buyer = req.company, bp = getPolicy(buyer.id, 'compra');
  const nid = Number(run(`INSERT INTO needs (buyer_id, product_name, qty, target_price, max_price, max_days, consumption, forecast, buyer_stock, status, created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, buyer.id, need.product_name, need.qty, need.target_price, need.max_price, need.max_days, need.consumption, need.forecast, need.buyer_stock, 'abierta', now()).lastInsertRowid);

  // Lo que el comprador comparte con los proveedores
  const sharedNeed = { ...need, consumption: bp.compartir.consumo ? need.consumption : null, forecast: bp.compartir.prevision ? need.forecast : null };
  const candidates = all(`SELECT p.*, c.name seller_name FROM products p JOIN connections k ON k.seller_id=p.company_id AND k.buyer_id=? AND k.status='activa'
    JOIN companies c ON c.id=p.company_id WHERE p.active=1 AND lower(trim(p.name))=lower(trim(?))`, buyer.id, need.product_name)
    .filter(p => isActive(one('SELECT * FROM companies WHERE id=?', p.company_id)));

  const offers = [];
  for (const p of candidates) {
    const sp = getPolicy(p.company_id, 'venta');
    const r = negotiate({ product: p, need: sharedNeed, sellerPolicy: sp, buyerPolicy: bp, seller: { name: p.seller_name }, buyer: { name: buyer.name } });
    const base = { need_id: nid, seller_id: p.company_id, buyer_id: buyer.id, product_id: p.id, log: r.log };
    if (r.status === 'acuerdo') {
      const pastOrders = one(`SELECT count(*) n FROM deals WHERE seller_id=? AND buyer_id=? AND status='cerrado'`, p.company_id, buyer.id).n;
      offers.push({ ...base, ...r, pastOrders, sp });
    } else {
      run(`INSERT INTO deals (need_id, seller_id, buyer_id, product_id, status, motivo, log, created) VALUES (?,?,?,?,?,?,?,?)`, nid, p.company_id, buyer.id, p.id, 'sin_acuerdo', r.motivo, JSON.stringify(r.log), now());
    }
  }
  if (!offers.length) {
    run('UPDATE needs SET status=? WHERE id=?', candidates.length ? 'sin_acuerdo' : 'sin_proveedor', nid);
    return res.json({ id: nid, status: candidates.length ? 'sin_acuerdo' : 'sin_proveedor' });
  }
  scoreOffers(offers, need, bp);
  offers.forEach((o, i) => {
    const chosen = i === 0;
    const ap = chosen ? approvals(o, o.sp, bp) : { buyer: false, seller: false };
    const log = chosen ? [...o.log, { who: 'sys', text: offers.length > 1 ? `Elegida entre ${offers.length} ofertas (puntuación ${o.score}).` : 'Única oferta recibida.' }] : [...o.log, { who: 'sys', text: `Oferta no elegida (puntuación ${o.score}).` }];
    const status = !chosen ? 'descartada' : (ap.buyer || ap.seller) ? 'pendiente' : 'cerrado';
    if (status === 'pendiente') log.push({ who: 'sys', text: `Pendiente de aprobación: ${[ap.buyer && 'jefe de compras', ap.seller && 'jefe de ventas'].filter(Boolean).join(' y ')}.` });
    if (status === 'cerrado') log.push({ who: 'sys', text: 'Dentro de los límites de los dos gestores. Pedido cerrado automáticamente.' });
    run(`INSERT INTO deals (need_id, seller_id, buyer_id, product_id, status, price, qty, total, lead_days, partial, score, chosen, need_buyer_ok, need_seller_ok, buyer_ok, seller_ok, log, created, closed)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, nid, o.seller_id, o.buyer_id, o.product_id, status, o.price, o.qty, o.total, o.lead_days, o.partial ? 1 : 0, o.score, chosen ? 1 : 0,
      ap.buyer ? 1 : 0, ap.seller ? 1 : 0, ap.buyer ? 0 : 1, ap.seller ? 0 : 1, JSON.stringify(log), now(), status === 'cerrado' ? now() : null);
    if (status === 'cerrado') run('UPDATE products SET stock=max(0, stock-?) WHERE id=?', o.qty, o.product_id);
  });
  const top = offers[0];
  const st = one('SELECT status FROM deals WHERE need_id=? AND chosen=1', nid).status;
  run('UPDATE needs SET status=? WHERE id=?', st === 'cerrado' ? 'cerrada' : 'pendiente', nid);
  res.json({ id: nid, status: st, price: top.price });
});

function dealView(d, cid) {
  const seller = one('SELECT * FROM companies WHERE id=?', d.seller_id), buyer = one('SELECT * FROM companies WHERE id=?', d.buyer_id);
  const need = one('SELECT * FROM needs WHERE id=?', d.need_id);
  const product = d.product_id && one('SELECT name, unit, sku, list_price FROM products WHERE id=?', d.product_id);
  const iAmSeller = d.seller_id === cid;
  let needOut = need;
  if (iAmSeller) {
    const c = getPolicy(d.buyer_id, 'compra').compartir;
    needOut = { product_name: need.product_name, qty: need.qty, max_days: need.max_days, consumption: c.consumo ? need.consumption : null, forecast: c.prevision ? need.forecast : null, buyer_stock: c.stock ? need.buyer_stock : null };
  }
  return {
    id: d.id, status: d.status, motivo: d.motivo, price: d.price, qty: d.qty, total: d.total, lead_days: d.lead_days, partial: !!d.partial, score: d.score, chosen: !!d.chosen,
    need_buyer_ok: !!d.need_buyer_ok, need_seller_ok: !!d.need_seller_ok, buyer_ok: !!d.buyer_ok, seller_ok: !!d.seller_ok,
    created: d.created, closed: d.closed, as: iAmSeller ? 'vendedor' : 'comprador',
    seller: publicCompany(seller), buyer: publicCompany(buyer), product, need: needOut,
    log: JSON.parse(d.log || '[]'),
    list_price: product?.list_price
  };
}
app.get('/api/deals', auth, (req, res) => {
  const cid = req.company.id;
  const rows = all(`SELECT * FROM deals WHERE buyer_id=? OR (seller_id=? AND status!='descartada') ORDER BY created DESC LIMIT 200`, cid, cid);
  res.json(rows.map(d => { const v = dealView(d, cid); delete v.log; return v; }));
});
app.get('/api/deals/:id', auth, (req, res) => {
  const d = one('SELECT * FROM deals WHERE id=?', +req.params.id);
  if (!d || (d.buyer_id !== req.company.id && d.seller_id !== req.company.id) || (d.seller_id === req.company.id && d.status === 'descartada' && d.buyer_id !== req.company.id)) return bad(res, 'No encontrado', 404);
  res.json(dealView(d, req.company.id));
});
app.post('/api/deals/:id/:action', auth, active, (req, res) => {
  const d = one('SELECT * FROM deals WHERE id=?', +req.params.id);
  if (!d || d.status !== 'pendiente') return bad(res, 'Esta operación ya no está pendiente');
  const isB = d.buyer_id === req.company.id, isS = d.seller_id === req.company.id;
  if (!isB && !isS) return bad(res, 'No encontrado', 404);
  const log = JSON.parse(d.log || '[]');
  if (req.params.action === 'rechazar') {
    log.push({ who: 'sys', text: `Rechazado por ${isB ? 'el jefe de compras' : 'el jefe de ventas'} (${req.user.name || req.user.email}).` });
    run('UPDATE deals SET status=?, log=?, closed=? WHERE id=?', 'rechazado', JSON.stringify(log), now(), d.id);
    run('UPDATE needs SET status=? WHERE id=?', 'rechazada', d.need_id);
    return res.json({ ok: true });
  }
  if (req.params.action !== 'aprobar') return bad(res, 'Acción no válida');
  const bok = isB ? 1 : d.buyer_ok, sok = isS ? 1 : d.seller_ok;
  log.push({ who: 'sys', text: `Aprobado por ${isB ? 'el jefe de compras' : 'el jefe de ventas'} (${req.user.name || req.user.email}).` });
  const done = bok && sok;
  if (done) { log.push({ who: 'sys', text: 'Pedido cerrado.' }); run('UPDATE products SET stock=max(0, stock-?) WHERE id=?', d.qty, d.product_id); run('UPDATE needs SET status=? WHERE id=?', 'cerrada', d.need_id); }
  run('UPDATE deals SET buyer_ok=?, seller_ok=?, status=?, log=?, closed=? WHERE id=?', bok, sok, done ? 'cerrado' : 'pendiente', JSON.stringify(log), done ? now() : null, d.id);
  res.json({ ok: true });
});

app.get('/api/stats', auth, (req, res) => {
  const cid = req.company.id;
  const q = (where, ...a) => one(`SELECT count(*) n, coalesce(sum(total),0) t FROM deals WHERE ${where}`, ...a);
  const buy = q(`buyer_id=? AND status='cerrado'`, cid), sell = q(`seller_id=? AND status='cerrado'`, cid);
  const savings = one(`SELECT coalesce(sum((p.list_price - d.price) * d.qty),0) s FROM deals d JOIN products p ON p.id=d.product_id WHERE d.buyer_id=? AND d.status='cerrado'`, cid).s;
  const margin = one(`SELECT coalesce(sum((d.price - p.cost) * d.qty),0) s FROM deals d JOIN products p ON p.id=d.product_id WHERE d.seller_id=? AND d.status='cerrado' AND p.cost>0`, cid).s;
  const pending = one(`SELECT count(*) n FROM deals WHERE status='pendiente' AND ((buyer_id=? AND buyer_ok=0) OR (seller_id=? AND seller_ok=0))`, cid, cid).n;
  const conns = one(`SELECT count(*) n FROM connections WHERE (seller_id=? OR buyer_id=?) AND status='activa'`, cid, cid).n;
  const requests = one(`SELECT count(*) n FROM connections WHERE buyer_id=? AND status='pendiente'`, cid).n;
  const auto = one(`SELECT count(*) n FROM deals WHERE (buyer_id=? OR seller_id=?) AND status='cerrado' AND need_buyer_ok=0 AND need_seller_ok=0`, cid, cid).n;
  res.json({ compras: buy, ventas: sell, ahorro: savings, margen: margin, pendientes: pending, conexiones: conns, solicitudes: requests, automaticos: auto });
});

// ---------- membresía ----------
app.post('/api/billing/checkout', auth, admin, async (req, res) => {
  const planKey = req.body?.plan, plan = PLANS[planKey];
  if (!plan) return bad(res, 'Plan no válido');
  if (!plan.roles.includes(req.company.role)) return bad(res, 'Ese plan no corresponde a tu tipo de empresa');
  if (!STRIPE_KEY || !plan.stripe) {
    // Modo demostración: activa 30 días sin cobrar
    run('UPDATE companies SET plan=?, plan_status=?, plan_until=? WHERE id=?', planKey, 'active', now() + 30 * DAY, req.company.id);
    return res.json({ demo: true });
  }
  const form = new URLSearchParams({
    mode: 'subscription', 'line_items[0][price]': plan.stripe, 'line_items[0][quantity]': '1',
    success_url: `${BASE_URL}/#membresia?ok=1`, cancel_url: `${BASE_URL}/#membresia`,
    client_reference_id: String(req.company.id), customer_email: req.user.email, 'metadata[plan]': planKey, locale: 'es'
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const j = await r.json();
  if (!j.url) return bad(res, 'No se ha podido iniciar el pago: ' + (j.error?.message || 'error de Stripe'));
  res.json({ url: j.url });
});

// ---------- administración de la plataforma (tú) ----------
const superOnly = (req, res, next) => req.user.is_super ? next() : bad(res, 'Solo administración IAC', 403);
app.get('/api/admin/companies', auth, superOnly, (req, res) => {
  res.json(all(`SELECT c.id, c.name, c.code, c.role, c.plan, c.plan_status, c.plan_until, c.created,
    (SELECT count(*) FROM users u WHERE u.company_id=c.id) users,
    (SELECT count(*) FROM deals d WHERE (d.buyer_id=c.id OR d.seller_id=c.id) AND d.status='cerrado') orders,
    (SELECT coalesce(sum(total),0) FROM deals d WHERE d.seller_id=c.id AND d.status='cerrado') sold
    FROM companies c ORDER BY c.created DESC`));
});
app.post('/api/admin/companies/:id', auth, superOnly, (req, res) => {
  const st = req.body?.plan_status, days = num(req.body?.days);
  if (!['trial', 'active', 'cancelado', 'impagado'].includes(st)) return bad(res, 'Estado no válido');
  run('UPDATE companies SET plan_status=?, plan_until=? WHERE id=?', st, now() + (days ?? 30) * DAY, +req.params.id);
  res.json({ ok: true });
});

// ---------- pedido imprimible con membrete ----------
app.get('/pedido/:id', (req, res, next) => {
  const t = cookies(req).iac_s; const s = t && one('SELECT * FROM sessions WHERE token=? AND expires>?', t, now());
  if (!s) return res.redirect('/#login');
  const u = one('SELECT * FROM users WHERE id=?', s.user_id);
  const d = one('SELECT * FROM deals WHERE id=?', +req.params.id);
  if (!d || (d.buyer_id !== u.company_id && d.seller_id !== u.company_id) || d.status !== 'cerrado') return res.status(404).send('Pedido no encontrado');
  const v = dealView(d, u.company_id);
  const e = x => String(x ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const eur = n => Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  const head = c => `<div class="lh" style="border-color:${e(c.color)}">${c.logo ? `<img src="${e(c.logo)}" alt="">` : ''}<div><b>${e(c.name)}</b><br>${e(c.tax_id)}<br>${e(c.address)}<br>${e(c.phone)} ${e(c.web)}</div></div>`;
  const mine = v.as === 'vendedor' ? v.seller : v.buyer;
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Pedido ${d.id}</title><style>
  body{font:14px/1.5 system-ui,sans-serif;color:#1d2330;max-width:820px;margin:30px auto;padding:0 24px}
  .top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:4px solid ${e(mine.color)};padding-bottom:14px}
  .top img{max-height:64px;max-width:220px}.top h1{margin:0;font-size:22px;color:${e(mine.color)}}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:20px 0}.lh{border-left:4px solid;padding-left:12px}.lh img{max-height:36px;display:block;margin-bottom:6px}
  table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:8px;border-bottom:1px solid #dde1e7;text-align:left}td.n,th.n{text-align:right}
  .tot{font-size:18px;font-weight:700;text-align:right;margin-top:12px}.small{color:#5d6676;font-size:12px;margin-top:30px}
  @media print{button{display:none}}</style></head><body>
  <div class="top"><div>${mine.logo ? `<img src="${e(mine.logo)}" alt="">` : `<h1>${e(mine.name)}</h1>`}</div><div style="text-align:right"><h1>Pedido nº ${d.id}</h1>${new Date(d.closed).toLocaleDateString('es-ES')}</div></div>
  <div class="cols"><div><small>PROVEEDOR</small>${head(v.seller)}</div><div><small>CLIENTE</small>${head(v.buyer)}</div></div>
  <table><tr><th>Producto</th><th class="n">Cantidad</th><th class="n">Precio</th><th class="n">Importe</th></tr>
  <tr><td>${e(v.product?.name)} ${v.product?.sku ? `(${e(v.product.sku)})` : ''}${v.partial ? ' · entrega parcial' : ''}</td><td class="n">${v.qty} ${e(v.product?.unit)}</td><td class="n">${eur(v.price)}</td><td class="n">${eur(v.total)}</td></tr></table>
  <div class="tot">Total (sin impuestos): ${eur(v.total)}</div>
  <p>Plazo de entrega: ${v.lead_days} días.</p>
  <p class="small">Pedido acordado entre los agentes de compras y ventas de ambas empresas, conforme a las políticas fijadas por sus responsables.</p>
  <button onclick="print()">Imprimir o guardar en PDF</button></body></html>`);
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

if (require.main === module) app.listen(PORT, () => console.log(`IAC en ${BASE_URL}`));
module.exports = app;
