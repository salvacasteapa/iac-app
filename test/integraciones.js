// Prueba de integraciones: clave de API, webhooks firmados, lotes, CSV y conector SAP B1 (contra un Service Layer simulado)
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/iaci-');
process.env.NODE_ENV = 'test';
const assert = require('assert'), http = require('http'), crypto = require('crypto');
// ---- Service Layer de SAP B1 simulado ----
const SAP = { orders: [], purchases: [], logins: 0 };
const sap = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const send = (code, j, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(j === undefined ? '' : JSON.stringify(j)); };
    const p = req.url.replace(/^\/b1s\/v1\//, '');
    if (p === 'Login') { const j = JSON.parse(b); if (j.Password !== 'sap-secreto' || j.CompanyDB !== 'SBODEMOES') return send(401, { error: { code: -304, message: { lang: 'es', value: 'Fail to get DB Credentials' } } }); SAP.logins++; return send(200, { SessionId: 'x' }, { 'set-cookie': ['B1SESSION=abc; path=/b1s', 'ROUTEID=.node1; path=/b1s'] }); }
    if (!/B1SESSION=abc/.test(req.headers.cookie || '')) return send(401, { error: { code: 301, message: { lang: 'es', value: 'Invalid session' } } });
    if (p === 'Logout') return send(204);
    if (p.startsWith('Items/$count')) return send(200, 3);
    if (p.startsWith('BusinessPartners/$count')) return send(200, 3);
    if (p.startsWith('ItemGroups')) return send(200, { value: [{ Number: 100, GroupName: 'Tornillería' }, { Number: 101, GroupName: 'Juntas' }] });
    if (p.startsWith('Items')) {
      const all = [{ ItemCode: 'TOR-M8', ItemName: 'Tornillo inox M8', ItemsGroupCode: 100, QuantityOnStock: 5000, BarCode: '8412345678905', SalesUnit: 'ud', SalesItem: 'tYES', Valid: 'tYES', Frozen: 'tNO', ItemPrices: [{ PriceList: 1, Price: 6.8 }, { PriceList: 2, Price: 6.1 }] },
        { ItemCode: 'JUN-40', ItemName: 'Junta tórica 40', ItemsGroupCode: 101, QuantityOnStock: 900, SalesItem: 'tYES', Valid: 'tYES', Frozen: 'tNO', ItemPrices: [{ PriceList: 1, Price: 0.9 }] },
        { ItemCode: 'SIN-PRE', ItemName: 'Sin precio', ItemsGroupCode: 101, QuantityOnStock: 1, SalesItem: 'tYES', Valid: 'tYES', Frozen: 'tNO', ItemPrices: [{ PriceList: 1, Price: 0 }] }];
      return /\$skip=2/.test(p) ? send(200, { value: all.slice(2) }) : send(200, { value: all.slice(0, 2), 'odata.nextLink': 'Items?$skip=2' });
    }
    if (p.startsWith('BusinessPartnerGroups')) return send(200, { value: [{ Code: 100, Name: 'Clientes' }, { Code: 105, Name: 'Industria' }] });
    if (p.startsWith('BusinessPartners')) return send(200, { value: [{ CardCode: 'C0001', CardName: 'Industrias Norte SL', CardType: 'cCustomer', FederalTaxID: 'ESB12345678', GroupCode: 105 }, { CardCode: 'P0009', CardName: 'Prov', CardType: 'cSupplier', FederalTaxID: 'A87654321' }] });
    if (p === 'Orders' || p === 'PurchaseOrders') { const j = JSON.parse(b); (p === 'Orders' ? SAP.orders : SAP.purchases).push(j); return send(201, { DocEntry: 77, DocNum: 1077 }); }
    send(404, { error: { code: -1, message: { value: 'no' } } });
  });
}).listen(0);
// ---- receptor de webhooks ----
const hooks = [];
const recv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hooks.push({ h: req.headers, b }); res.statusCode = recv.fail ? 500 : 200; res.end(); }); }).listen(0);

const app = require('../server'); const srv = app.listen(0);
const base = `http://localhost:${srv.address().port}/api`;
const jar = () => { let c = ''; return async (p, body, method, hdr) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c, ...hdr }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) throw new Error(p + ': ' + (j.error || t)); return j; }; };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const S = jar(); await S('/signup', { company: 'Prov', role: 'vendedor', name: 'S', email: 's@i.es', password: 'secreto123' });
  await S('/company', { name: 'Prov', tax_id: 'A87654321' }, 'PUT');
  const code = (await S('/me')).company.code;
  // clave de API
  const { key } = await S('/integraciones/claves', { name: 'ERP' }); assert.match(key, /^iac_/);
  const K = jar(); const H = { authorization: 'Bearer ' + key };
  assert.equal((await K('/me', null, 'GET', H)).company.code, code);
  await assert.rejects(K('/me', null, 'GET', { authorization: 'Bearer iac_noexisteXXXXXXXXXXXXXXXXXX' }), /Clave de API no válida/);
  // lote de artículos por API
  let r = await K('/v1/articulos/lote', [{ codigo: 'a 1', nombre: 'Arandela', familia: 'Tornillería', precio_lista: '1,20', precio_minimo: 1, stock: 10 }, { codigo: 'X', nombre: 'Sin precio' }], 'POST', H);
  assert.deepEqual([r.creados, r.actualizados, r.errores.length], [1, 0, 1]);
  r = await K('/v1/articulos/lote', [{ codigo: 'A1', stock: 99 }], 'POST', H); assert.equal(r.actualizados, 1);
  assert.equal((await S('/products')).find(p => p.sku === 'A1').stock, 99);
  // CSV de Excel (punto y coma, coma decimal, comillas)
  r = await S('/importar/articulos', { csv: '﻿Código;Nombre;Familia;Precio lista;Precio mínimo;Stock\r\nTOR-M8;"Tornillo; inox M8";Tornillería;6,50;5,20;100\r\n' });
  assert.equal(r.creados, 1); assert.equal((await S('/products')).find(p => p.sku === 'TOR-M8').name, 'Tornillo; inox M8');
  assert.match(await S('/exportar/articulos.csv'), /codigo;nombre;familia/);
  // webhook firmado
  const wh = await S('/integraciones/webhooks', { url: `http://localhost:${recv.address().port}/h`, events: ['pedido.cerrado', 'cita.creada'] });
  await S(`/integraciones/webhooks/${wh.id}/probar`, {}); assert.equal(hooks.at(-1).h['x-iac-event'], 'prueba');
  const verify = x => { const [t, v] = x.h['x-iac-signature'].split(',').map(s => s.split('=')[1]); return crypto.createHmac('sha256', wh.secret).update(`${t}.${x.b}`).digest('hex') === v; };
  assert.ok(verify(hooks.at(-1)), 'firma válida');
  // cliente con NIF que coincide con SAP
  const B = jar(); await B('/signup', { company: 'Industrias Norte', role: 'comprador', name: 'B', email: 'b@i.es', password: 'secreto123', invite: code });
  await B('/company', { name: 'Industrias Norte', tax_id: 'B-12345678' }, 'PUT');
  const k = (await B('/connections'))[0]; await B(`/connections/${k.id}/status`, { status: 'activa' });
  // SAP B1
  await assert.rejects(S('/erp/sapb1', { url: 'nada', company_db: 'X', username: 'u', password: 'p' }, 'PUT'), /dirección/);
  await S('/erp/sapb1', { url: `http://localhost:${sap.address().port}/b1s/v1`, company_db: 'SBODEMOES', username: 'manager', password: 'mal' }, 'PUT');
  await assert.rejects(S('/erp/sapb1/probar', {}), /401.*DB Credentials/);
  await S('/erp/sapb1', { url: `http://localhost:${sap.address().port}/b1s/v1`, company_db: 'SBODEMOES', username: 'manager', password: 'sap-secreto', min_discount: 10 }, 'PUT');
  const cfg = await S('/erp/sapb1'); assert.equal(cfg.config.has_password, true); assert.ok(!JSON.stringify(cfg).includes('sap-secreto'), 'la contraseña nunca se devuelve');
  assert.equal((await S('/erp/sapb1/probar', {})).articulos, 3);
  const sy = await S('/erp/sapb1/sincronizar', {});
  assert.equal(sy.articulos.creados, 1); assert.equal(sy.articulos.actualizados, 1); assert.equal(sy.articulos.sin_precio, 1);
  const tor = (await S('/products')).find(p => p.sku === 'TOR-M8'); assert.equal(tor.list_price, 6.8); assert.equal(tor.min_price, 5.2, 'el mínimo de un artículo existente no se toca'); assert.equal(tor.stock, 5000);
  const jun = (await S('/products')).find(p => p.sku === 'JUN-40'); assert.equal(jun.min_price, 0.81); assert.equal(jun.category, 'Juntas');
  assert.equal(sy.interlocutores.enlazados, 1);
  assert.equal((await S('/ofertas')).clients[0].grupo, 'Industria', 'grupo de cliente desde SAP');
  // pedido cerrado → pedido de cliente en SAP (solo con el conector activo)
  await S('/erp/sapb1/activar', { active: true });
  await B('/needs', { product_name: 'Tornillo inox M8', qty: 100, target_price: 6.8, max_price: 7, max_days: 5 });
  await wait(300);
  const d = (await S('/deals'))[0]; assert.equal(d.status, 'cerrado');
  assert.equal(SAP.orders.length, 1); assert.equal(SAP.orders[0].CardCode, 'C0001'); assert.equal(SAP.orders[0].DocumentLines[0].ItemCode, 'TOR-M8'); assert.equal(SAP.orders[0].NumAtCard, 'IAC-' + d.id);
  assert.equal((await S('/erp/sapb1')).docs[0].doc_num, 1077);
  assert.ok(hooks.some(x => x.h['x-iac-event'] === 'pedido.cerrado' && JSON.parse(x.b).data.cliente.nif === 'B-12345678'));
  // lado compras: sin código propio del cliente no se puede crear el pedido de compra
  const C = jar(); await C('/signup', { company: 'Cli2', role: 'comprador', name: 'C', email: 'c@i.es', password: 'secreto123', invite: code });
  await C('/erp/sapb1', { url: `http://localhost:${sap.address().port}/b1s/v1`, company_db: 'SBODEMOES', username: 'manager', password: 'sap-secreto', active: true }, 'PUT');
  const kc = (await C('/connections'))[0]; await C(`/connections/${kc.id}/status`, { status: 'activa' });
  await C('/erp/sapb1/interlocutor', { other_id: kc.other.id, card_code: 'P0009' });
  await C('/needs', { product_name: 'Junta tórica 40', qty: 100, target_price: 0.85, max_price: 0.9, max_days: 5 });
  await wait(300);
  const cd = (await C('/erp/sapb1')).docs[0]; assert.equal(cd.status, 'error'); assert.match(cd.error, /código de artículo/);
  // exportación y API de pedidos
  assert.match(await S('/exportar/pedidos.csv'), /IAC|pedido;fecha;lado/);
  assert.equal((await K('/v1/pedidos', null, 'GET', H))[0].cliente.nombre, 'Industrias Norte');
  // revocar la clave
  const ks = await S('/integraciones/claves'); await S('/integraciones/claves/' + ks[0].id, null, 'DELETE');
  await assert.rejects(K('/me', null, 'GET', H), /no válida/);
  console.log('integraciones OK: API, webhooks', hooks.length, '· SAP B1 pedidos', SAP.orders.length, '· logins', SAP.logins);
  srv.close(); sap.close(); recv.close(); process.exit(0);
})().catch(e => { console.error('FALLO', e); process.exit(1); });
