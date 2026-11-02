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
  // Negociación con una persona sin agente (el proveedor vende)
  const pub = async (tok, body) => { const r = await fetch(base + '/public/n/' + tok, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
  const prods = await S('/products');
  const e1 = await S('/ext', { side: 'venta', product_id: prods[0].id, qty: 50, days: 3, cp_company: 'Talleres Sur', cp_name: 'Luis', supervisor: 'Salvador' });
  let v = await pub(e1.token);
  console.log('EXT venta:', v.messages[0].text);
  for (const t of ['¿Eres un robot?', 'Te pago 5 euros', 'Vale, 5,60 €', 'Hasta 5,90 y cerramos']) { v = await pub(e1.token, { text: t }); console.log('  humano:', t, '\n  agente:', v.messages.at(-1).text, '[' + v.status + ']'); if (['cerrada','pendiente'].includes(v.status)) break; }
  // El cliente compra a un proveedor humano y pide hablar con una persona
  const e2 = await B('/ext', { side: 'compra', product_name: 'Cajas cartón', unit: 'ud', qty: 1000, open_price: 0.40, limit_price: 0.55, cp_company: 'Cartonajes Paco' });
  v = await pub(e2.token, { text: 'Nuestro precio es 0,70 €' }); console.log('EXT compra agente:', v.messages.at(-1).text);
  v = await pub(e2.token, { action: 'humano' }); console.log('  pide persona ->', v.status, v.agent_paused);
  await B('/ext/' + e2.id + '/message', { text: 'Hola, soy Ana. ¿Podéis hacer 0,52?' });
  await B('/ext/' + e2.id + '/reanudar', {});
  v = await pub(e2.token, { text: 'Ok, 0,52' }); console.log('  tras reanudar:', v.messages.at(-1).text, '[' + v.status + ']');
  console.log('stats externos', (await B('/stats')).externos);
  // Catálogo completo: fotos, vídeo, certificados, proyectos y escaparate
  const assert = require('assert');
  const cookieOf = async (email) => { const r = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secreto123' }) }); return r.headers.get('set-cookie').split(';')[0]; };
  const sc = await cookieOf('s@x.es'), bc = await cookieOf('a@x.es');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = async (buf, type, cookie = sc) => { const r = await fetch(base + '/media', { method: 'POST', headers: { 'content-type': type, cookie, 'x-filename': 'f' }, body: buf }); return [r.status, await r.json()]; };
  const photos = []; for (let i = 0; i < 5; i++) { const [st, j] = await up(png, 'image/png'); assert.equal(st, 200); photos.push(j.id); }
  const [vs, vid] = await up(Buffer.from('00000018667479706d703432', 'hex'), 'video/mp4'); assert.equal(vs, 200);
  const [bs] = await up(Buffer.from('MZ'), 'application/x-msdownload'); assert.equal(bs, 400, 'tipo no permitido');
  const mr = await fetch(`http://localhost:${srv.address().port}/media/${photos[0]}`); assert.equal(mr.status, 200); assert.match(mr.headers.get('content-type'), /image\/png/);
  const [, pdf] = await up(Buffer.from('%PDF-1.4\n'), 'application/pdf');
  await S('/certificates', { name: 'ISO 9001:2015', issuer: 'AENOR', expires: '2027-05-01', media_id: pdf.id });
  const cert = (await S('/certificates'))[0]; assert.equal(cert.file.kind, 'pdf');
  await S('/products/' + prods[0].id, { ...prods[0], category: 'Tornillería', description: 'Acero A2', photos, video: vid.id, certs: [cert.id] }, 'PUT');
  const pr = await S('/products/' + prods[0].id);
  assert.equal(pr.photos.length, 4, 'máximo 4 fotos'); assert.ok(pr.video); assert.equal(pr.certs[0].name, 'ISO 9001:2015');
  // las fotos de otra empresa no se pueden usar
  const [, foreign] = await up(png, 'image/png', bc);
  await S('/products/' + prods[0].id, { ...pr, photos: [foreign.id], video: null, certs: [] }, 'PUT');
  assert.equal((await S('/products/' + prods[0].id)).photos.length, 0, 'foto ajena rechazada');
  await S('/products/' + prods[0].id, { ...pr, photos: photos.slice(0, 2), video: vid.id, certs: [cert.id] }, 'PUT');
  const pj = await S('/projects', { title: 'Nave logística Zaragoza', client: 'Industrias Norte', year: '2026', photos: photos.slice(0, 3), comments: [{ author: 'Ana', text: 'Entrega impecable' }] });
  await S('/projects', { title: 'Borrador', public: false });
  const show = await B('/showcase/' + sMe.company.id);
  assert.equal(show.products[0].photos.length, 2); assert.equal(show.products[0].min_price, undefined, 'mínimo oculto');
  assert.equal(show.projects.length, 1, 'proyecto oculto no se ve'); assert.equal(show.projects[0].comments[0].text, 'Entrega impecable');
  assert.equal(show.certificates.length, 1);
  const cat2 = await B('/catalog'); assert.ok(cat2[0].photo, 'foto en el catálogo del comprador');
  const ps = await (await fetch(base + '/public/showcase/' + e1.token)).json();
  assert.equal(ps.products.length, 1); assert.equal(ps.products[0].min_price, undefined); assert.equal(ps.projects.length, 1);
  assert.equal(await (await fetch(base + '/public/showcase/' + e2.token)).json(), null, 'compra no enseña escaparate');
  // un comprador sin conexión no ve el escaparate
  const X = jar(); await X('/signup', { company: 'Otra SA', role: 'comprador', name: 'X', email: 'x@x.es', password: 'secreto123' });
  await assert.rejects(X('/showcase/' + sMe.company.id));
  console.log('catálogo completo OK: fotos', pr.photos.length, 'vídeo', !!pr.video, 'certificado', cert.name, 'proyecto', pj.id);
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
