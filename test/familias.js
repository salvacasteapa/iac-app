// Prueba de familias: tabla propia, paso de las familias antiguas, cambio de nombre, baja y estadísticas
const fs = require('fs'), os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(os.tmpdir() + '/iacf-');
const assert = require('assert');
// Simula una base antigua: artículos con la familia escrita a mano y sin family_id
{
  const { run, now } = require('../db');
  run(`INSERT INTO companies (name, code, role, plan, plan_status, plan_until, created) VALUES ('Vieja','VIE-0001','vendedor','vendedor','active',?,?)`, now() + 1e9, now());
  try { run('ALTER TABLE products ADD COLUMN category TEXT'); } catch { }
  run(`INSERT INTO products (company_id, sku, name, unit, category, list_price, min_price, cost, stock, lead_days, active) VALUES (1,'X1','A','ud','Tornillería',1,1,0,0,1,1)`);
  run(`INSERT INTO products (company_id, sku, name, unit, category, list_price, min_price, cost, stock, lead_days, active) VALUES (1,'X2','B','ud','tornillería ',1,1,0,0,1,1)`);
}
const app = require('../server'); const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}/api`;
const jar = () => { let c = ''; return async (p, body, method) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; }; };
(async () => {
  const { all } = require('../db');
  const old = all('SELECT * FROM families WHERE company_id=1'); assert.equal(old.length, 1, 'las dos formas de escribirla son la misma familia');
  assert.equal(all('SELECT * FROM products WHERE company_id=1 AND family_id=?', old[0].id).length, 2);
  const S = jar(); await S('/signup', { company: 'Prov', role: 'vendedor', name: 'S', email: 's@f.es', password: 'secreto123' });
  const code = (await S('/me')).company.code;
  const t = await S('/familias', { name: 'Tornillería', code: 'tor' });
  await assert.rejects(S('/familias', { name: 'tornillería' }), /Ya tienes/);
  await S('/products', { sku: 'T1', name: 'Tornillo', family_id: t.id, list_price: 10, min_price: 8, cost: 6, stock: 999, lead_days: 2 });
  await S('/products', { sku: 'J1', name: 'Junta', category: 'Juntas', list_price: 2, min_price: 1.5, cost: 1, stock: 999, lead_days: 2 }); // por nombre: se crea sola
  let L = await S('/familias?lista=1'); assert.deepEqual(L.map(f => f.name), ['Juntas', 'Tornillería']); assert.equal(L[1].code, 'TOR');
  await assert.rejects(S('/products', { sku: 'Z', name: 'Z', family_id: 9999, list_price: 1, min_price: 1 }), /no existe/);
  const B = jar(); await B('/signup', { company: 'Cli', role: 'comprador', name: 'B', email: 'b@f.es', password: 'secreto123', invite: code });
  const k = (await B('/connections'))[0]; await B(`/connections/${k.id}/status`, { status: 'activa' });
  await B('/needs', { product_name: 'Tornillo', qty: 100, target_price: 9, max_price: 10, max_days: 5 });
  await B('/needs', { product_name: 'Junta', qty: 50, target_price: 2, max_price: 2, max_days: 5 });
  let D = await S('/familias?dias=30'); const ft = D.families.find(f => f.name === 'Tornillería');
  assert.equal(ft.items, 1); assert.equal(ft.orders, 1); assert.equal(ft.units, 100); assert.ok(ft.revenue >= 900); assert.ok(ft.margin > 0); assert.equal(ft.clients, 1); assert.equal(ft.top_clients[0].name, 'Cli');
  assert.ok(D.totals.revenue >= ft.revenue);
  // cambio de nombre: llega a los artículos y a las ofertas
  await S('/ofertas', { target: 'familia', category: 'Tornillería', audience: 'todos', discount_pct: 5 });
  await S('/familias/' + t.id, { name: 'Tornillería inox', code: 'TOR' }, 'PUT');
  assert.equal((await S('/products')).find(p => p.sku === 'T1').category, 'Tornillería inox');
  assert.equal((await B('/ofertas/recibidas'))[0].category, 'Tornillería inox');
  // baja: no si tiene artículos
  await assert.rejects(S('/familias/' + t.id, null, 'DELETE'), /tiene 1 artículo/);
  const j = L.find(f => f.name === 'Juntas'); const pj = (await S('/products')).find(p => p.sku === 'J1');
  await S('/products/' + pj.id, { ...pj, photos: [], certs: [], video: null, family_id: t.id }, 'PUT');
  await S('/familias/' + j.id, null, 'DELETE');
  L = await S('/familias?lista=1'); assert.deepEqual(L.map(f => f.name), ['Tornillería inox']);
  D = await S('/familias'); assert.equal(D.families.find(f => f.id === j.id).active, false, 'de baja pero con sus estadísticas');
  console.log('familias OK:', D.families.map(f => `${f.name} ${f.revenue} €`).join(' · '));
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
