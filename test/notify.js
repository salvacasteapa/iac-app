// Prueba de avisos fuera de la app: push (contra un servidor push simulado) y WhatsApp (API de Meta simulada).
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), https = require('https'), assert = require('assert');
const { execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(os.tmpdir() + '/iacn-');
process.env.DATA_DIR = tmp;
process.env.WHATSAPP_TOKEN = 'token-prueba'; process.env.WHATSAPP_PHONE_ID = '123';

(async () => {
  // API de WhatsApp simulada
  const waCalls = [];
  const wa = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { waCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ messages: [{ id: 'wamid.1' }] })); }); }).listen(0);
  process.env.WHATSAPP_API_BASE = `http://localhost:${wa.address().port}`;
  // Servidor push simulado (HTTPS con certificado propio)
  let pushCalls = [], pushSrv = null;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp + '/k.pem', '-out', tmp + '/c.pem', '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    pushSrv = https.createServer({ key: fs.readFileSync(tmp + '/k.pem'), cert: fs.readFileSync(tmp + '/c.pem') }, (req, res) => { let n = 0; req.on('data', c => n += c.length); req.on('end', () => { pushCalls.push({ url: req.url, enc: req.headers['content-encoding'], vapid: req.headers.authorization, bytes: n }); res.statusCode = 201; res.end(); }); }).listen(0);
  } catch { console.log('(sin openssl: se omite la parte push)'); }

  const app = require('../server'); const srv = app.listen(0);
  const base = `http://localhost:${srv.address().port}/api`;
  const jar = () => { let c = ''; return async (p, body, method) => { const r = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', cookie: c }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; const j = await r.json(); if (!r.ok) throw new Error(p + ': ' + j.error); return j; }; };
  const S = jar(), B = jar();
  try {
    await S('/signup', { company: 'Prov', role: 'vendedor', name: 'Salva', email: 'p@x.es', password: 'secreto123' });
    const me = await S('/me');
    await S('/products', { sku: 'A1', name: 'Pieza', list_price: 10, min_price: 8, stock: 1000, lead_days: 2 });
    await B('/signup', { company: 'Cli', role: 'comprador', name: 'Ana', email: 'c@x.es', password: 'secreto123', invite: me.company.code });
    const k = await B('/connections'); await B(`/connections/${k[0].id}/status`, { status: 'activa' });
    await S('/followup/client', { buyer_id: me.company.id + 1, level: 4 });

    const { key } = await S('/push/key'); assert.ok(key.length > 60);
    await assert.rejects(S('/notify/prefs', { wa_phone: '12' }, 'PUT'), /prefijo/);
    await S('/notify/prefs', { push_level: 1, wa_phone: '600 123 456', wa_level: 3, wa_optin: true }, 'PUT');
    let P = await S('/notify/prefs'); assert.equal(P.wa_phone, '34600123456'); assert.equal(P.wa_platform, true); assert.equal(P.wa_company, false);
    await assert.rejects(S('/notify/test', { channel: 'whatsapp' }), /no está activado/);
    // la administración activa el extra de WhatsApp para la empresa
    const { db } = require('../db'); db.prepare('UPDATE companies SET wa_enabled=1 WHERE id=?').run(me.company.id);
    if (pushSrv) {
      const ecdh = require('crypto').createECDH('prime256v1'); ecdh.generateKeys();
      await S('/push/subscribe', { subscription: { endpoint: `https://localhost:${pushSrv.address().port}/push/abc`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: require('crypto').randomBytes(16).toString('base64url') } } });
      const t = await S('/notify/test', { channel: 'push' }); assert.equal(t.sent, 1);
    }
    await S('/notify/test', { channel: 'whatsapp' });
    // un pedido real dispara el aviso por los dos canales
    await B('/needs', { product_name: 'Pieza', qty: 10, target_price: 9, max_price: 10, max_days: 3 });
    await new Promise(r => setTimeout(r, 400));
    if (pushSrv) { assert.equal(pushCalls.length, 2); assert.equal(pushCalls[1].enc, 'aes128gcm'); assert.match(pushCalls[1].vapid, /^vapid t=/); }
    assert.equal(waCalls.length, 2); assert.equal(waCalls[1].body.to, '34600123456'); assert.equal(waCalls[1].body.template.name, 'aviso_iac');
    assert.match(waCalls[1].body.template.components[0].parameters[0].text, /N4 Ganada/); assert.equal(waCalls[1].auth, 'Bearer token-prueba');
    P = await S('/notify/prefs'); assert.equal(P.wa_month, 2, 'contador para facturar el extra');
    console.log('avisos fuera de la app OK: push', pushCalls.length, '· WhatsApp', waCalls.length);
  } catch (e) { console.error('FALLO', e); process.exitCode = 1; }
  srv.close(); wa.close(); pushSrv?.close();
})();
