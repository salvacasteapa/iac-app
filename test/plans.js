// Prueba de planes: precios, tope de conexiones, promoción, conexión pagada por el cliente y negociaciones del plan Compras + Ventas
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/iacp-');
process.env.MAX_CONEXIONES = '2'; process.env.PROMO_CLIENTES = '1'; process.env.NEGOCIACIONES_INCLUIDAS = '2';
const assert = require('assert');
const app = require('../server'); const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}/api`;
const jar = () => { let c = ''; return async (p, body, method) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; }; };
const { run } = require('../db');
(async () => {
  const pl = await (await fetch(base + '/plans')).json();
  assert.equal(pl.comprador.price, 19); assert.equal(pl.vendedor.price, 49); assert.equal(pl.empresa.price, 199);
  assert.equal(pl.conexion.price, 14); assert.equal(pl.empresa.max_neg, 2); assert.equal(pl.empresa.extra_neg, 0.99); assert.equal(pl.empresa.max_conn, null);
  const S = jar(); await S('/signup', { company: 'Prov', role: 'vendedor', name: 'S', email: 's@p.es', password: 'secreto123' });
  const sme = await S('/me'); await S('/products', { sku: 'A1', name: 'Pieza', list_price: 10, min_price: 8, stock: 1000, lead_days: 2 });
  // promoción: el primer cliente invitado tiene 6 meses gratis; el segundo ya no (tope de 1 en esta prueba)
  const B1 = jar(), B2 = jar(), B3 = jar();
  const inv = await (await fetch(base + '/invite/' + sme.company.code)).json(); assert.equal(inv.kind, 'vendedor'); assert.equal(inv.promo, 6);
  await B1('/signup', { company: 'Cli1', role: 'comprador', name: 'A', email: 'a@p.es', password: 'secreto123', invite: sme.company.code });
  await B2('/signup', { company: 'Cli2', role: 'comprador', name: 'B', email: 'b@p.es', password: 'secreto123', invite: sme.company.code });
  const m1 = await B1('/me'), m2 = await B2('/me');
  assert.equal(m1.company.plan_status, 'active'); assert.equal(m1.company.promo_by, 'Prov'); assert.ok(m1.company.plan_until - Date.now() > 170 * 864e5);
  assert.equal(m2.company.plan_status, 'trial'); assert.equal(m2.company.promo_by, null);
  assert.deepEqual((await S('/me')).usage.promo, { used: 1, max: 1, months: 6 });
  // tope de conexiones (2 en esta prueba): el proveedor ya tiene 2 pendientes
  await B3('/signup', { company: 'Cli3', role: 'comprador', name: 'C', email: 'c@p.es', password: 'secreto123' });
  await assert.rejects(S('/connections', { code: (await B3('/me')).company.code }), /máximo de 2 conexiones/);
  // pasar a Compras + Ventas quita el tope de conexiones
  await S('/billing/checkout', { plan: 'empresa' }); const se = await S('/me');
  assert.equal(se.company.role, 'ambos'); assert.equal(se.usage.max, null);
  await S('/connections', { code: (await B3('/me')).company.code });
  // negociaciones incluidas (2 en esta prueba) y extra a 0,99 €
  for (const B of [B1, B2]) { const k = (await B('/connections'))[0]; await B(`/connections/${k.id}/status`, { status: 'activa' }); }
  for (let i = 0; i < 3; i++) await B1('/needs', { product_name: 'Pieza', qty: 10, target_price: 9, max_price: 10, max_days: 3 });
  const N = (await S('/me')).usage.negociaciones; assert.equal(N.used, 3); assert.equal(N.included, 2); assert.equal(N.extra, 1); assert.equal(N.extra_eur, 0.99);
  // conexión pagada por el cliente: un proveedor sin plan puede vender solo a ese cliente
  const P2 = jar(); const bc = (await B2('/me')).company.code;
  const inv2 = await (await fetch(base + '/invite/' + bc)).json(); assert.equal(inv2.kind, 'comprador');
  await P2('/signup', { company: 'Prov2', role: 'vendedor', name: 'P', email: 'p2@p.es', password: 'secreto123', invite: bc });
  const p2 = await P2('/me'); await P2('/products', { sku: 'B1', name: 'Junta', list_price: 3, min_price: 2, stock: 500, lead_days: 2 });
  let k2 = (await P2('/connections'))[0]; assert.equal(k2.requested_by, 'comprador');
  await P2(`/connections/${k2.id}/status`, { status: 'activa' }); // el proveedor acepta la petición de su cliente
  run(`UPDATE companies SET plan_status='cancelado' WHERE id=?`, p2.company.id);
  let r = await B2('/needs', { product_name: 'Junta', qty: 10, target_price: 2.5, max_price: 3, max_days: 3 });
  assert.equal((await B2('/deals')).filter(d => d.need?.id === r.id).length, 0, 'sin plan ni pago, no negocia');
  await assert.rejects(P2('/products', { sku: 'B9', name: 'X', list_price: 3, min_price: 2 }), /no está activa/);
  k2 = (await B2('/connections')).find(c => c.other.id === p2.company.id); assert.equal(k2.seller_plan, false);
  await B2('/billing/connection/' + k2.id, {});
  assert.ok((await B2('/connections')).find(c => c.id === k2.id).sponsor_until);
  r = await B2('/needs', { product_name: 'Junta', qty: 10, target_price: 2.5, max_price: 3, max_days: 3 });
  assert.equal((await B2('/deals')).filter(d => d.need?.id === r.id).length, 1, 'con la conexión pagada, negocia');
  assert.ok((await P2('/me')).company.sponsored); await P2('/products', { sku: 'B2', name: 'Arandela', list_price: 1, min_price: 0.8 });
  await B2('/billing/connection/' + k2.id, null, 'DELETE');
  await assert.rejects(P2('/products', { sku: 'B9', name: 'X', list_price: 3, min_price: 2 }), /no está activa/);
  console.log('planes OK: 19 / 49 / 199 €, promoción, tope de conexiones, negociaciones extra y conexión pagada por el cliente');
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
