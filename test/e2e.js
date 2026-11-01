// Prueba de extremo a extremo de la API: proveedor + cliente + negociación
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/iac-');
const app = require('../server');
const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}/api`;
const jar = () => { let c = ''; return async (p, body, method) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; }; };
(async () => {
  const S = jar(), B = jar();
  await S('/signup', { company: 'Suministros Casteapa', role: 'vendedor', name: 'Salvador', email: 's@x.es', password: 'secreto123' });
  const sMe = await S('/me');
  await S('/products', { name: 'Tornillo inox M8', list_price: 6.8, min_price: 5.2, cost: 4.5, stock: 1200, lead_days: 3 });
  await B('/signup', { company: 'Industrias Norte', role: 'comprador', name: 'Ana', email: 'a@x.es', password: 'secreto123', invite: sMe.company.code });
  let conns = await B('/connections'); console.log('conexión', conns[0].status, 'con', conns[0].other.name);
  await B(`/connections/${conns[0].id}/status`, { status: 'activa' });
  console.log('catálogo visible', (await B('/catalog')).length);
  const n = await B('/needs', { product_name: 'tornillo inox m8', qty: 400, target_price: 5.4, max_price: 6.3, max_days: 5, consumption: 350, forecast: 420 });
  console.log('necesidad', n);
  const deals = await S('/deals'); const d = await S('/deals/' + deals[0].id);
  console.log('trato', d.status, d.price, d.total, 'aprob. ventas', d.need_seller_ok, 'compras', d.need_buyer_ok);
  d.log.forEach(m => console.log('  ', m.who, m.text));
  if (d.status === 'pendiente') { if (d.need_seller_ok) await S(`/deals/${d.id}/aprobar`, {}); if (d.need_buyer_ok) await B(`/deals/${d.id}/aprobar`, {}); }
  console.log('final', (await S('/deals/' + d.id)).status, await S('/stats'));
  // reglas
  await S('/policy/venta', { mostrar: { costes: true }, cierre: { descuento_max_auto: 20 } }, 'PUT');
  console.log('política', JSON.stringify(await S('/policy/venta')));
  const n2 = await B('/needs', { product_name: 'Tornillo inox M8', qty: 100, target_price: 5.0, max_price: 6.0, max_days: 5 });
  console.log('necesidad 2 (libro abierto)', n2);
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
