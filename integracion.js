// Base para conectar IAC con CRM, ERP y herramientas como Zapier o Make:
// - claves de API por empresa (sirven en todas las rutas /api con "Authorization: Bearer iac_...")
// - webhooks firmados: IAC avisa a otro sistema cuando pasa algo (pedido, oferta, cita, aviso…)
// - sincronización por lotes de artículos y clientes, importación CSV/Excel y exportación de pedidos
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { db, one, all, run, now } = require('./db');
const { norm, gtinOk } = require('./codes');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, name TEXT, prefix TEXT NOT NULL, hash TEXT UNIQUE NOT NULL,
  created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT NOT NULL, events TEXT NOT NULL, secret TEXT NOT NULL, active INTEGER DEFAULT 1,
  fails INTEGER DEFAULT 0, last_status TEXT, last_at INTEGER, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER NOT NULL, event TEXT, status TEXT, code INTEGER, error TEXT, created INTEGER NOT NULL
);`);
if (!all('PRAGMA table_info(products)').some(c => c.name === 'erp_code')) db.exec('ALTER TABLE products ADD COLUMN erp_code TEXT');

// ---------- cifrado de secretos guardados (contraseñas de ERP) ----------
const KEY = (() => {
  if (process.env.SECRET_KEY) return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  const f = path.join(DATA_DIR, 'secret.key');
  try { return Buffer.from(fs.readFileSync(f, 'utf8'), 'hex'); } catch { const k = crypto.randomBytes(32); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 }); return k; }
})();
const seal = txt => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const e = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
const open = s => { if (!s) return ''; const [iv, tag, e] = s.split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };

// ---------- claves de API ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
/** Empresa y usuario de una petición con clave de API, o null. */
function apiAuth(req) {
  const m = /^Bearer\s+(iac_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const k = one('SELECT * FROM api_keys WHERE hash=? AND revoked IS NULL', sha(m[1])); if (!k) return null;
  if (!k.last_used || now() - k.last_used > 60e3) run('UPDATE api_keys SET last_used=? WHERE id=?', now(), k.id);
  const user = one('SELECT * FROM users WHERE id=? AND company_id=?', k.user_id, k.company_id) || one('SELECT * FROM users WHERE company_id=? AND is_admin=1 ORDER BY id', k.company_id);
  const company = one('SELECT * FROM companies WHERE id=?', k.company_id);
  return user && company ? { user, company, key: k } : null;
}

// ---------- webhooks ----------
const EVENTS = {
  'pedido.cerrado': 'Pedido cerrado', 'pedido.pendiente': 'Pedido pendiente de aprobación', 'pedido.perdido': 'Pedido perdido o rechazado',
  'oferta.enviada': 'Oferta especial enviada', 'oferta.recibida': 'Oferta especial recibida', 'cita.creada': 'Cita creada en la agenda',
  'aviso.creado': 'Aviso de seguimiento', 'conexion.solicitada': 'Nueva solicitud de conexión', 'articulos.sincronizados': 'Artículos sincronizados'
};
const listeners = [];
/** Otros módulos (conector de SAP B1) se apuntan a los eventos. */
const on = fn => listeners.push(fn);
const RETRY = process.env.NODE_ENV === 'test' ? [50, 100] : [5e3, 60e3, 600e3];

function post(url, body, headers) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve({ code: 0, error: 'URL no válida' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'IAC-Webhooks/1', ...headers }, timeout: 10e3 }, res => { res.resume(); res.on('end', () => resolve({ code: res.statusCode })); });
    r.on('timeout', () => r.destroy(new Error('Sin respuesta en 10 s'))); r.on('error', e => resolve({ code: 0, error: e.message })); r.end(body);
  });
}
async function deliver(h, event, payload, attempt = 0) {
  const body = JSON.stringify(payload), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', h.secret).update(`${ts}.${body}`).digest('hex');
  const r = await post(h.url, body, { 'x-iac-event': event, 'x-iac-signature': `t=${ts},v1=${sig}`, 'x-iac-delivery': payload.id });
  const ok = r.code >= 200 && r.code < 300;
  run('INSERT INTO webhook_log (webhook_id, event, status, code, error, created) VALUES (?,?,?,?,?,?)', h.id, event, ok ? 'ok' : 'error', r.code || null, ok ? null : (r.error || 'HTTP ' + r.code), now());
  run(`DELETE FROM webhook_log WHERE webhook_id=? AND id NOT IN (SELECT id FROM webhook_log WHERE webhook_id=? ORDER BY id DESC LIMIT 100)`, h.id, h.id);
  if (ok) { run(`UPDATE webhooks SET fails=0, last_status='ok', last_at=? WHERE id=?`, now(), h.id); return true; }
  const fails = (one('SELECT fails FROM webhooks WHERE id=?', h.id)?.fails || 0) + 1;
  run(`UPDATE webhooks SET fails=?, last_status=?, last_at=?, active=? WHERE id=?`, fails, (r.error || 'HTTP ' + r.code).slice(0, 200), now(), fails >= 20 ? 0 : 1, h.id);
  if (attempt < RETRY.length && !payload.test) setTimeout(() => deliver(h, event, payload, attempt + 1), RETRY[attempt]).unref?.();
  return false;
}
/** Lanza un evento de la empresa `cid` a sus webhooks y a los conectores. */
function emit(cid, event, data) {
  if (!cid) return;
  const payload = { id: crypto.randomUUID(), event, created: new Date().toISOString(), company_id: cid, data };
  for (const fn of listeners) setImmediate(() => { try { fn(cid, event, data); } catch (e) { console.error('conector', e.message); } });
  for (const h of all('SELECT * FROM webhooks WHERE company_id=? AND active=1', cid))
    if (JSON.parse(h.events).includes(event) || JSON.parse(h.events).includes('*')) setImmediate(() => deliver(h, event, payload));
}

/** Pedido tal como lo ven los otros sistemas. */
function dealOut(d, cid) {
  const c = id => { const x = one('SELECT id, code, name, tax_id FROM companies WHERE id=?', id); return x && { id: x.id, codigo: x.code, nombre: x.name, nif: x.tax_id }; };
  const p = d.product_id && one('SELECT sku, erp_code, name, unit, family_id, category FROM products WHERE id=?', d.product_id);
  return { id: d.id, lado: d.seller_id === cid ? 'venta' : 'compra', estado: d.status, fecha: new Date(d.closed || d.created).toISOString(),
    proveedor: c(d.seller_id), cliente: c(d.buyer_id),
    articulo: { cod_fabricante: d.mfr_code || p?.sku || null, cod_erp_proveedor: p?.erp_code || p?.sku || null, cod_cliente: d.buyer_code || null, nombre: p?.name || null, familia: p?.category || null, unidad: p?.unit || 'ud' },
    cantidad: d.qty, precio: d.price, total: d.total, plazo_dias: d.lead_days, entrega_parcial: !!d.partial, autorizacion_especial: d.auth_id || null };
}
/** Evento de una operación entre agentes, para las dos empresas. */
function dealEvent(dealId) {
  const d = one('SELECT * FROM deals WHERE id=?', dealId); if (!d) return;
  const ev = d.status === 'cerrado' ? 'pedido.cerrado' : d.status === 'pendiente' ? 'pedido.pendiente' : 'pedido.perdido';
  emit(d.seller_id, ev, dealOut(d, d.seller_id));
  if (d.chosen || d.status === 'cerrado' || d.status === 'rechazado') emit(d.buyer_id, ev, dealOut(d, d.buyer_id));
}

// ---------- CSV (Excel guarda en CSV con ";" y coma decimal) ----------
function parseCSV(text) {
  text = String(text || '').replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter(r => r.some(x => x.trim()));
  if (!clean.length) return [];
  const key = s => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const head = clean[0].map(key);
  return clean.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const toCSV = rows => { if (!rows.length) return ''; const cols = Object.keys(rows[0]); const esc = v => { const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return '﻿' + [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n'); };
const pick = (o, ...names) => { for (const n of names) if (o[n] !== undefined && o[n] !== '') return o[n]; return undefined; };
const dec = v => { if (v === undefined || v === null || v === '') return undefined; if (typeof v === 'number') return v; const s = String(v).replace(/\s|€/g, ''); const n = Number(/,\d{1,4}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

/**
 * Crea o actualiza artículos por código de fabricante. Al actualizar solo cambia lo que llega.
 * Campos (en español o como los exporta un ERP): codigo, nombre, familia, precio_lista, precio_minimo, coste, stock, plazo, unidad, ean, descripcion.
 */
function upsertItems(cid, items, source = 'api') {
  const fam = require('./familias');
  const out = { creados: 0, actualizados: 0, errores: [] };
  const bySku = new Map(all('SELECT * FROM products WHERE company_id=? AND active=1', cid).map(p => [norm(p.sku), p]));
  items.forEach((it, i) => {
    const raw = pick(it, 'codigo', 'cod_fabricante', 'codigo_fabricante', 'sku', 'itemcode', 'referencia', 'ref');
    const sku = norm(raw); if (!sku) return out.errores.push({ fila: i + 1, error: 'Falta el código del artículo' });
    const v = { name: pick(it, 'nombre', 'name', 'itemname', 'articulo'), family: pick(it, 'familia', 'family', 'grupo_articulo', 'itemsgroup'),
      list_price: dec(pick(it, 'precio_lista', 'precio', 'list_price', 'pvp', 'price')), min_price: dec(pick(it, 'precio_minimo', 'min_price', 'minimo')),
      cost: dec(pick(it, 'coste', 'cost', 'costo')), stock: dec(pick(it, 'stock', 'existencias', 'quantityonstock')), lead_days: dec(pick(it, 'plazo', 'plazo_dias', 'lead_days')),
      unit: pick(it, 'unidad', 'unit', 'salesunit'), ean: pick(it, 'ean', 'codigo_barras', 'barcode'), description: pick(it, 'descripcion', 'description') };
    for (const k of ['list_price', 'min_price', 'cost', 'stock', 'lead_days']) if (Number.isNaN(v[k]) || (v[k] !== undefined && v[k] < 0)) return out.errores.push({ fila: i + 1, codigo: sku, error: `El campo ${k} no es un número válido` });
    const ean = v.ean ? String(v.ean).replace(/\D/g, '') : undefined;
    const f = v.family !== undefined ? fam.resolve(cid, { category: String(v.family) }) : null;
    const ex = bySku.get(sku);
    if (ex) {
      const n = { name: v.name !== undefined ? String(v.name).slice(0, 160) : ex.name, list_price: v.list_price ?? ex.list_price, min_price: v.min_price ?? ex.min_price, cost: v.cost ?? ex.cost,
        stock: v.stock !== undefined ? Math.floor(v.stock) : ex.stock, lead_days: v.lead_days !== undefined ? Math.floor(v.lead_days) : ex.lead_days, unit: v.unit !== undefined ? String(v.unit).slice(0, 20) : ex.unit,
        ean: ean !== undefined ? (gtinOk(ean) ? ean : ex.ean) : ex.ean, description: v.description !== undefined ? String(v.description).slice(0, 4000) : ex.description,
        family_id: f ? f.family_id : ex.family_id, category: f ? f.category : ex.category };
      if (n.min_price > n.list_price) n.min_price = n.list_price;
      run(`UPDATE products SET name=?, list_price=?, min_price=?, cost=?, stock=?, lead_days=?, unit=?, ean=?, description=?, family_id=?, category=?, erp_code=coalesce(erp_code, ?) WHERE id=?`,
        n.name, n.list_price, n.min_price, n.cost, n.stock, n.lead_days, n.unit, n.ean, n.description, n.family_id, n.category, String(raw), ex.id);
      out.actualizados++;
    } else {
      if (!v.name || v.list_price === undefined) return out.errores.push({ fila: i + 1, codigo: sku, error: 'Para dar de alta un artículo hacen falta nombre y precio de lista' });
      const min = v.min_price ?? v.list_price;
      const r = run(`INSERT INTO products (created, company_id, sku, erp_code, ean, name, unit, category, family_id, description, list_price, min_price, cost, stock, lead_days, photos, certs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','[]')`,
        now(), cid, sku, String(raw), ean && gtinOk(ean) ? ean : null, String(v.name).slice(0, 160), v.unit ? String(v.unit).slice(0, 20) : 'ud', f?.category || '', f?.family_id || null, v.description ? String(v.description).slice(0, 4000) : '',
        v.list_price, Math.min(min, v.list_price), v.cost ?? 0, Math.floor(v.stock ?? 0), Math.floor(v.lead_days ?? 3));
      bySku.set(sku, one('SELECT * FROM products WHERE id=?', Number(r.lastInsertRowid)));
      out.creados++;
    }
  });
  if (out.creados || out.actualizados) emit(cid, 'articulos.sincronizados', { origen: source, creados: out.creados, actualizados: out.actualizados });
  return out;
}

const taxNorm = s => { let t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (/^ES[A-Z0-9]{9}$/.test(t)) t = t.slice(2); return t; };
/** Pone grupo y nivel a clientes conectados, buscándolos por código IAC o por NIF. */
function upsertClients(cid, rows) {
  const out = { actualizados: 0, errores: [] };
  const clients = all(`SELECT c.* FROM connections k JOIN companies c ON c.id=k.buyer_id WHERE k.seller_id=? AND k.status IN ('activa','pausada','pendiente')`, cid);
  rows.forEach((r, i) => {
    const code = String(pick(r, 'codigo_empresa', 'codigo_iac', 'codigo', 'code') || '').toUpperCase().trim(), nif = taxNorm(pick(r, 'nif', 'cif', 'tax_id', 'federaltaxid'));
    const c = clients.find(x => (code && x.code === code) || (nif && taxNorm(x.tax_id) === nif));
    if (!c) return out.errores.push({ fila: i + 1, error: `No tienes conectado ningún cliente con ${code ? 'código ' + code : 'NIF ' + (nif || '(vacío)')}` });
    const grupo = pick(r, 'grupo', 'group', 'grupo_cliente', 'segmento'), lv = dec(pick(r, 'nivel', 'level'));
    const acc = one('SELECT * FROM client_accounts WHERE seller_id=? AND buyer_id=?', cid, c.id);
    run(`INSERT INTO client_accounts (seller_id, buyer_id, level, grupo) VALUES (?,?,?,?) ON CONFLICT(seller_id, buyer_id) DO UPDATE SET level=excluded.level, grupo=excluded.grupo`,
      cid, c.id, lv >= 1 && lv <= 4 ? Math.floor(lv) : acc?.level || 1, grupo !== undefined ? String(grupo).slice(0, 60) || null : acc?.grupo || null);
    out.actualizados++;
  });
  return out;
}

function register(app, { auth, active, bad, str, admin, sellerOnly }) {
  // claves
  app.get('/api/integraciones/claves', auth, admin, (req, res) => res.json(all('SELECT id, name, prefix, created, last_used, revoked FROM api_keys WHERE company_id=? ORDER BY id DESC', req.company.id)));
  app.post('/api/integraciones/claves', auth, active, admin, (req, res) => {
    const key = 'iac_' + crypto.randomBytes(24).toString('base64url');
    run('INSERT INTO api_keys (company_id, user_id, name, prefix, hash, created) VALUES (?,?,?,?,?,?)', req.company.id, req.user.id, str(req.body?.name, 80) || 'Clave', key.slice(0, 10) + '…', sha(key), now());
    res.json({ key }); // se enseña una sola vez
  });
  app.delete('/api/integraciones/claves/:id', auth, admin, (req, res) => { run('UPDATE api_keys SET revoked=? WHERE id=? AND company_id=?', now(), +req.params.id, req.company.id); res.json({ ok: true }); });

  // webhooks
  app.get('/api/integraciones/webhooks', auth, admin, (req, res) => res.json({ events: EVENTS,
    hooks: all('SELECT * FROM webhooks WHERE company_id=? ORDER BY id DESC', req.company.id).map(h => ({ ...h, events: JSON.parse(h.events), active: !!h.active,
      log: all('SELECT event, status, code, error, created FROM webhook_log WHERE webhook_id=? ORDER BY id DESC LIMIT 10', h.id) })) }));
  app.post('/api/integraciones/webhooks', auth, active, admin, (req, res) => {
    const url = str(req.body?.url, 500); let u; try { u = new URL(url); } catch { }
    if (!u || !/^https?:$/.test(u.protocol)) return bad(res, 'Pon la dirección completa, empezando por https://');
    if (u.protocol === 'http:' && process.env.NODE_ENV !== 'test' && !/^(localhost|127\.)/.test(u.hostname)) return bad(res, 'Por seguridad, la dirección tiene que empezar por https://');
    const events = (Array.isArray(req.body?.events) ? req.body.events : []).filter(e => EVENTS[e] || e === '*'); if (!events.length) return bad(res, 'Elige al menos un evento');
    const secret = 'whsec_' + crypto.randomBytes(18).toString('base64url');
    const r = run('INSERT INTO webhooks (company_id, url, events, secret, created) VALUES (?,?,?,?,?)', req.company.id, url, JSON.stringify(events), secret, now());
    res.json({ ok: true, id: Number(r.lastInsertRowid), secret });
  });
  app.post('/api/integraciones/webhooks/:id/probar', auth, admin, async (req, res) => {
    const h = one('SELECT * FROM webhooks WHERE id=? AND company_id=?', +req.params.id, req.company.id); if (!h) return bad(res, 'No encontrado', 404);
    const ok = await deliver(h, 'prueba', { id: crypto.randomUUID(), event: 'prueba', test: true, created: new Date().toISOString(), company_id: h.company_id, data: { mensaje: 'Prueba de IAC' } });
    ok ? res.json({ ok }) : bad(res, 'No ha respondido bien: ' + (one('SELECT last_status FROM webhooks WHERE id=?', h.id).last_status));
  });
  app.post('/api/integraciones/webhooks/:id/:accion', auth, admin, (req, res) => {
    const a = { activar: 1, pausar: 0 }[req.params.accion]; if (a === undefined) return bad(res, 'Acción no válida');
    run('UPDATE webhooks SET active=?, fails=0 WHERE id=? AND company_id=?', a, +req.params.id, req.company.id); res.json({ ok: true });
  });
  app.delete('/api/integraciones/webhooks/:id', auth, admin, (req, res) => { run('DELETE FROM webhooks WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true }); });

  // sincronización por lotes (para ERP, CRM, Zapier, Make…)
  app.post('/api/v1/articulos/lote', auth, active, sellerOnly, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body?.articulos; if (!Array.isArray(items)) return bad(res, 'Envía una lista de artículos');
    if (items.length > 5000) return bad(res, 'Máximo 5000 artículos por envío');
    res.json(upsertItems(req.company.id, items));
  });
  app.post('/api/v1/clientes/lote', auth, active, sellerOnly, (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : req.body?.clientes; if (!Array.isArray(rows)) return bad(res, 'Envía una lista de clientes');
    res.json(upsertClients(req.company.id, rows));
  });
  const ordersFor = (cid, q) => {
    const desde = q.desde ? (/^\d+$/.test(q.desde) ? +q.desde : Date.parse(q.desde)) || 0 : 0;
    const est = ['cerrado', 'pendiente', 'todos'].includes(q.estado) ? q.estado : 'cerrado';
    return all(`SELECT * FROM deals WHERE (seller_id=? OR (buyer_id=? AND (chosen=1 OR status='cerrado'))) AND coalesce(closed, created)>=? ${est === 'todos' ? '' : 'AND status=?'} ORDER BY id LIMIT 2000`,
      ...[cid, cid, desde, ...(est === 'todos' ? [] : [est])]).map(d => dealOut(d, cid));
  };
  app.get('/api/v1/pedidos', auth, (req, res) => res.json(ordersFor(req.company.id, req.query)));
  app.get('/api/v1/clientes', auth, sellerOnly, (req, res) => res.json(all(`SELECT c.id, c.code codigo, c.name nombre, c.tax_id nif, k.status conexion, a.grupo, coalesce(a.level,1) nivel FROM connections k JOIN companies c ON c.id=k.buyer_id
    LEFT JOIN client_accounts a ON a.seller_id=k.seller_id AND a.buyer_id=k.buyer_id WHERE k.seller_id=? ORDER BY c.name`, req.company.id)));

  // Excel / CSV
  app.post('/api/importar/:que', auth, active, admin, (req, res) => {
    const rows = parseCSV(req.body?.csv); if (!rows.length) return bad(res, 'El archivo está vacío o no tiene cabecera');
    if (req.params.que === 'articulos') { if (!['vendedor', 'ambos'].includes(req.company.role)) return bad(res, 'Solo para empresas que venden', 403); return res.json(upsertItems(req.company.id, rows, 'excel')); }
    if (req.params.que === 'clientes') return res.json(upsertClients(req.company.id, rows));
    bad(res, 'No sé importar eso');
  });
  app.get('/api/exportar/:que', auth, (req, res) => {
    let rows;
    if (req.params.que === 'pedidos.csv') rows = ordersFor(req.company.id, { ...req.query, estado: req.query.estado || 'cerrado' }).map(o => ({ pedido: o.id, fecha: o.fecha.slice(0, 10), lado: o.lado, estado: o.estado,
      proveedor: o.proveedor?.nombre, nif_proveedor: o.proveedor?.nif, cliente: o.cliente?.nombre, nif_cliente: o.cliente?.nif, cod_fabricante: o.articulo.cod_fabricante, cod_cliente: o.articulo.cod_cliente,
      articulo: o.articulo.nombre, familia: o.articulo.familia, cantidad: o.cantidad, unidad: o.articulo.unidad, precio: o.precio, total: o.total, plazo_dias: o.plazo_dias }));
    else if (req.params.que === 'articulos.csv') rows = all('SELECT * FROM products WHERE company_id=? AND active=1 ORDER BY category, name', req.company.id).map(p => ({ codigo: p.erp_code || p.sku, nombre: p.name, familia: p.category, precio_lista: p.list_price, precio_minimo: p.min_price, coste: p.cost, stock: p.stock, plazo: p.lead_days, unidad: p.unit, ean: p.ean, descripcion: p.description }));
    else return bad(res, 'No sé exportar eso', 404);
    if (!rows.length) rows = [{ sin_datos: '' }];
    res.setHeader('content-type', 'text/csv; charset=utf-8'); res.setHeader('content-disposition', `attachment; filename="iac-${req.params.que}"`);
    res.send(toCSV(rows));
  });
}

module.exports = { register, apiAuth, emit, on, dealEvent, dealOut, upsertItems, upsertClients, parseCSV, taxNorm, seal, open, EVENTS };
