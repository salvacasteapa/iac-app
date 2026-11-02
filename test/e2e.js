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
  await S('/products', { sku: 'tor-m8 a2', ean: '8412345678905', name: 'Tornillo inox M8', list_price: 6.8, min_price: 5.2, cost: 4.5, stock: 1200, lead_days: 3 });
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
  // Doble código: fabricante + cliente, confirmado por las dos empresas
  await assert.rejects(S('/products', { name: 'Sin código', list_price: 2, min_price: 1 }), /código del fabricante/);
  await assert.rejects(S('/products', { sku: 'TOR-M8A2', name: 'Duplicado', list_price: 2, min_price: 1 }), /Ya tienes otro/);
  await assert.rejects(S('/products', { sku: 'X1', ean: '8412345678901', name: 'EAN malo', list_price: 2, min_price: 1 }), /EAN/);
  const tor = (await S('/products')).find(p => p.name === 'Tornillo inox M8'); assert.equal(tor.sku, 'TOR-M8A2');
  const lk = await B('/codes', { product_id: tor.id, buyer_code: 'nor-4471', buyer_desc: 'Tornillo M8 inoxidable' });
  assert.equal(lk.state, 'falta_proveedor');
  await assert.rejects(B('/needs', { buyer_code: 'NOR-4471', qty: 10, target_price: 6, max_price: 6.8, max_days: 5 }), /no está vinculado/);
  await assert.rejects(B('/codes', { product_id: prods.find(p => p.id !== tor.id)?.id || tor.id, buyer_code: 'NOR4471' }));
  let pend = (await S('/codes')).find(l => l.id === lk.id); assert.ok(pend.can_confirm);
  assert.ok((await S('/stats')).codigos >= 1);
  await S(`/codes/${lk.id}/confirmar`, { mfr_code: pend.product.current_code });
  assert.equal((await B('/codes'))[0].state, 'confirmado');
  const nc = await B('/needs', { buyer_code: ' nor-4471 ', qty: 10, target_price: 6.5, max_price: 6.8, max_days: 5 });
  const dc = (await B('/deals')).find(x => x.need?.id === nc.id && x.chosen);
  const dv = await B('/deals/' + dc.id);
  assert.equal(dv.mfr_code, 'TOR-M8A2'); assert.equal(dv.buyer_code, 'NOR-4471'); assert.ok(dv.verified);
  // la descripción cambia: el vínculo sigue valiendo
  await S('/products/' + tor.id, { ...(await S('/products/' + tor.id)), name: 'Tornillo inoxidable M8 (nuevo envase)' }, 'PUT');
  assert.equal((await B('/codes'))[0].state, 'confirmado');
  // el fabricante cambia su código: hay que reconfirmar y no se puede pedir hasta entonces
  await S('/products/' + tor.id, { ...(await S('/products/' + tor.id)), sku: 'TOR-M8-A2-V2' }, 'PUT');
  assert.equal((await B('/codes'))[0].state, 'cambiado');
  await assert.rejects(B('/needs', { buyer_code: 'NOR-4471', qty: 10, target_price: 6, max_price: 6.8, max_days: 5 }), /no está vinculado/);
  await assert.rejects(B(`/codes/${lk.id}/confirmar`, { mfr_code: 'TOR-M8A2' }), /ha cambiado/);
  await B(`/codes/${lk.id}/confirmar`, { mfr_code: 'TOR-M8-A2-V2' });
  assert.equal((await B('/codes'))[0].state, 'confirmado');
  // externos: la otra parte da su código y confirma
  const e3 = await S('/ext', { side: 'venta', product_id: tor.id, qty: 5, cp_company: 'Talleres Este' });
  let v3 = await pub(e3.token); assert.equal(v3.mfr_code, 'TOR-M8-A2-V2'); assert.equal(v3.cp_code_ok, false);
  v3 = await pub(e3.token, { action: 'codigos', code: 'te-99' }); assert.equal(v3.buyer_code, 'TE-99'); assert.ok(v3.cp_code_ok);
  console.log('doble código OK:', dv.mfr_code, '=', dv.buyer_code);
  // Agenda: llamadas, visitas y reuniones con motivo, resultado y siguiente paso
  const meta = await S('/agenda/meta'); assert.ok(meta.motives.oferta && meta.motives.nuevo_producto && meta.motives.regular);
  await assert.rejects(S('/agenda', { kind: 'llamada', motive: 'oferta', start: '2026-11-10T10:00' }), /con quién/);
  const ag = await S('/agenda', { kind: 'llamada', motive: 'oferta', other_id: sMe.company.id + 1, contact_name: 'Ana', contact_phone: '600 000 000', start: '2026-11-10T10:00', product_id: tor.id, offer_price: 6.4 });
  const ga = await S('/agenda/' + ag.id); assert.equal(ga.who, 'Industrias Norte'); assert.equal(ga.minutes, 15); assert.equal(ga.product.id, tor.id);
  const rr = await S(`/agenda/${ag.id}/resultado`, { result: 'interesado', result_notes: 'Quiere 500 ud', next: { kind: 'visita', motive: 'seguimiento_oferta', start: '2026-11-13T11:00' } });
  const nx = await S('/agenda/' + rr.next); assert.equal(nx.kind, 'visita'); assert.equal(nx.parent_id, ag.id); assert.equal(nx.history[0].result, 'interesado');
  await S(`/agenda/${rr.next}/aplazar`, { start: '2026-11-14T12:00' });
  const wk = await S('/agenda?from=2026-11-09&to=2026-11-15'); assert.equal(wk.length, 2);
  await assert.rejects(B('/agenda/' + ag.id)); // otra empresa no la ve
  const ics = await (await fetch(`http://localhost:${srv.address().port}/agenda/${ag.id}.ics`, { headers: { cookie: sc } })).text();
  assert.match(ics, /BEGIN:VEVENT/); assert.match(ics, /DTSTART:20261110T100000/);
  const sg = await S('/agenda-sugerencias'); assert.ok(Array.isArray(sg));
  console.log('agenda OK:', sg.length, 'sugerencias;', sg.map(x => x.motive).join(', '));
  // Autorizaciones especiales: pedido, familia y cliente
  await assert.rejects(S('/specials', { scope: 'pedido', buyer_id: sMe.company.id + 1, price_mode: 'precio' }), /artículo/);
  await assert.rejects(S('/specials', { scope: 'familia', category: 'Tornillería', price_mode: 'precio', price: 3 }), /descuento/);
  const torP = await S('/products/' + tor.id);
  await S('/products/' + tor.id, { ...torP, category: 'Tornillería', stock: 5000, lead_days: 5 }, 'PUT');
  const bid = sMe.company.id + 1;
  // Sin autorización: plazo 5 días no cabe en 3
  await assert.rejects(B('/needs', { buyer_code: 'NOR-4471', qty: 50, target_price: 4, max_price: 5, max_days: 3 }).then(r => { if (r.status !== 'sin_acuerdo') throw 0; throw new Error('sin_acuerdo'); }), /sin_acuerdo/);
  // Familia para todos: hasta -10%
  const sf = await S('/specials', { scope: 'familia', category: 'tornillería', price_mode: 'descuento', discount_pct: 10, reason: 'Campaña' });
  // Cliente: precio especial y plazo 2 días
  const scl = await S('/specials', { scope: 'cliente', buyer_id: bid, product_id: tor.id, price_mode: 'precio', price: 4.9, lead_days: 2 });
  // Pedido: un solo uso, 1000-2000 ud, precio 4,50
  const sp1 = await S('/specials', { scope: 'pedido', buyer_id: bid, product_id: tor.id, price_mode: 'precio', price: 4.5, min_qty: 1000, max_qty: 2000, auto_close: true });
  const q1 = await B('/needs', { buyer_code: 'NOR-4471', qty: 50, target_price: 4, max_price: 5, max_days: 3 });
  const w1 = await B('/deals/' + (await B('/deals')).find(x => x.need?.id === q1.id && x.chosen).id);
  assert.equal(w1.status, 'cerrado'); assert.equal(w1.special.id, scl.id); assert.equal(w1.lead_days, 2); assert.ok(w1.price >= 4.9);
  const q2 = await B('/needs', { buyer_code: 'NOR-4471', qty: 1500, target_price: 4, max_price: 4.6, max_days: 5 });
  const w2 = await B('/deals/' + (await B('/deals')).find(x => x.need?.id === q2.id && x.chosen).id);
  assert.equal(w2.special.id, sp1.id); assert.equal(w2.need_seller_ok, false, 'pre-autorizado: ventas no tiene que aprobar'); assert.equal(w2.price, 4.5);
  const q3 = await B('/needs', { buyer_code: 'NOR-4471', qty: 1500, target_price: 4, max_price: 4.6, max_days: 5 });
  assert.equal(q3.status, 'sin_acuerdo', 'el pedido especial ya se usó');
  const lst = await S('/specials'); assert.equal(lst.find(a => a.id === sp1.id).state, 'agotada');
  await S(`/specials/${scl.id}/desactivar`, {});
  const q4 = await B('/needs', { buyer_code: 'NOR-4471', qty: 10, target_price: 5.5, max_price: 6.2, max_days: 6 });
  const w4 = await B('/deals/' + (await B('/deals')).find(x => x.need?.id === q4.id && x.chosen).id);
  assert.equal(w4.special.id, sf.id);
  console.log('autorizaciones OK:', w1.price, w2.price, w4.price);
  // Seguimiento escalado y avisos
  const al0 = await S('/alerts'); assert.ok(al0.length > 0, 'hay avisos de operaciones');
  assert.ok(al0.some(a => a.outcome === 'ganado') && al0.some(a => a.outcome === 'standby'));
  await S('/followup/client', { buyer_id: bid, level: 4, owner_id: '' });
  const fq = await B('/needs', { buyer_code: 'NOR-4471', qty: 5, target_price: 5.5, max_price: 6.2, max_days: 6 });
  const top = (await S('/alerts'))[0];
  assert.equal(top.level, 4); assert.equal(top.outcome, 'ganado'); assert.equal(top.suggest_kind, 'reunion'); assert.ok(top.for_me);
  assert.ok((await S('/alerts/unread')).some(a => a.id === top.id));
  assert.ok((await S('/stats')).avisos >= 1);
  const ct = await S('/agenda', { kind: 'reunion', motive: 'revision', other_id: bid, start: '2026-11-20T10:00' });
  await S(`/alerts/${top.id}/agendado`, { cita_id: ct.id });
  assert.equal((await S('/alerts')).find(a => a.id === top.id).status, 'agendado');
  await S('/followup/settings', { importe: { 2: 100000, 3: null, 4: null }, perdida_sube: false }, 'PUT');
  await S('/followup/client', { buyer_id: bid, level: 1 });
  await B('/needs', { buyer_code: 'NOR-4471', qty: 5, target_price: 5.5, max_price: 6.2, max_days: 6 });
  const low = (await S('/alerts'))[0]; assert.equal(low.level, 1); assert.equal(low.status, 'registrado', 'nivel 1: solo registro');
  // externos también avisan
  const e5 = await S('/ext', { side: 'venta', product_id: tor.id, qty: 5, cp_company: 'Talleres Oeste' });
  await pub(e5.token, { action: 'humano' }); await new Promise(r => setTimeout(r, 30));
  assert.ok((await S('/alerts')).some(a => a.ext_id === e5.id && a.outcome === 'standby'));
  console.log('seguimiento OK: avisos', (await S('/alerts')).length);
  srv.close();
})().catch(e => { console.error('FALLO', e); srv.close(); process.exit(1); });
