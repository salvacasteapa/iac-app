// Prueba de ofertas especiales: grupos de clientes, envío por familia y por artículo, y precio aplicado al negociar
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/iaco-');
const assert = require('assert');
const app = require('../server'); const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}/api`;
const jar = () => { let c = ''; return async (p, body, method) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; }; };
(async () => {
  const S = jar(); await S('/signup', { company: 'Prov', role: 'vendedor', name: 'S', email: 's@o.es', password: 'secreto123' });
  const code = (await S('/me')).company.code;
  await S('/products', { sku: 'T1', name: 'Tornillo M8', category: 'Tornillería', list_price: 10, min_price: 9.5, stock: 1000, lead_days: 4 });
  await S('/products', { sku: 'T2', name: 'Tuerca M8', category: 'Tornillería', list_price: 4, min_price: 3.8, stock: 1000, lead_days: 4 });
  await S('/products', { sku: 'J1', name: 'Junta', category: 'Juntas', list_price: 2, min_price: 1.9, stock: 1000, lead_days: 4 });
  const B = {}; for (const n of ['Norte', 'Sur', 'Este']) { B[n] = jar(); await B[n]('/signup', { company: n, role: 'comprador', name: n, email: n + '@o.es', password: 'secreto123', invite: code }); const k = (await B[n]('/connections'))[0]; await B[n](`/connections/${k.id}/status`, { status: 'activa' }); }
  let D = await S('/ofertas'); assert.equal(D.clients.length, 3); assert.deepEqual(D.families, ['Juntas', 'Tornillería']);
  const id = n => D.clients.find(c => c.name === n).id;
  await S('/clientes/grupo', { buyer_id: id('Norte'), grupo: 'Industria' }); await S('/clientes/grupo', { buyer_id: id('Sur'), grupo: 'Industria' });
  D = await S('/ofertas'); assert.deepEqual(D.groups, ['Industria']);
  await assert.rejects(S('/ofertas', { target: 'familia', category: 'Tornillería', audience: 'grupo', grupo: 'Nadie', discount_pct: 10 }), /No hay clientes/);
  await assert.rejects(S('/ofertas', { target: 'familia', category: 'Tornillería', audience: 'todos', price_mode: 'precio', price: 1 }), /descuento/);
  // familia Tornillería −10% al grupo Industria
  const o1 = await S('/ofertas', { target: 'familia', category: 'Tornillería', audience: 'grupo', grupo: 'industria', discount_pct: 10, lead_days: 2, title: 'Otoño' }); assert.equal(o1.sent, 2);
  // artículo Junta a 1,50 € solo para Este
  const o2 = await S('/ofertas', { target: 'articulo', product_id: (await S('/products')).find(p => p.sku === 'J1').id, audience: 'cliente', buyer_id: id('Este'), price_mode: 'precio', price: 1.5 }); assert.equal(o2.sent, 1);
  assert.equal((await B.Norte('/stats')).ofertas, 1); assert.equal((await B.Este('/stats')).ofertas, 1);
  const rn = await B.Norte('/ofertas/recibidas'); assert.equal(rn.length, 1); assert.equal(rn[0].items.length, 2); assert.match(rn[0].conditions, /10% de descuento/);
  await B.Norte(`/ofertas/recibidas/${rn[0].id}/vista`, {}); assert.equal((await B.Norte('/stats')).ofertas, 0);
  // el agente aplica la oferta: Norte paga 9 € (−10%) con plazo 2 días; Este (sin la oferta de familia) no baja de 9,5
  await B.Norte('/needs', { product_name: 'Tornillo M8', qty: 10, target_price: 8, max_price: 10, max_days: 5 });
  const dn = (await B.Norte('/deals'))[0]; const vn = await B.Norte('/deals/' + dn.id); assert.equal(vn.price, 9); assert.equal(vn.lead_days, 2); assert.match(vn.special.text, /Oferta|especial/);
  await B.Este('/needs', { product_name: 'Tornillo M8', qty: 10, target_price: 8, max_price: 10, max_days: 5 });
  const ve = await B.Este('/deals/' + (await B.Este('/deals'))[0].id); assert.ok(ve.price >= 9.5);
  await B.Este('/needs', { product_name: 'Junta', qty: 10, target_price: 1, max_price: 2, max_days: 5 });
  const vj = await B.Este('/deals/' + (await B.Este('/deals'))[0].id); assert.equal(vj.price, 1.5);
  D = await S('/ofertas'); const s1 = D.offers.find(o => o.id === o1.id); assert.equal(s1.seen, 1); assert.equal(s1.recipients.length, 2);
  // retirar: deja de aplicarse
  await S(`/ofertas/${o1.id}/retirar`, {}); assert.equal((await B.Sur('/ofertas/recibidas')).length, 0);
  await B.Sur('/needs', { product_name: 'Tornillo M8', qty: 10, target_price: 8, max_price: 10, max_days: 5 });
  const vs = await B.Sur('/deals/' + (await B.Sur('/deals'))[0].id); assert.ok(vs.price >= 9.5);
  console.log('ofertas OK: grupo', o1.sent, '· cliente', o2.sent, '· precios', vn.price, vj.price, vs.price);
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
