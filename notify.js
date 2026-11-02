// Avisos fuera de la app: notificaciones push (gratis) y WhatsApp (de pago, como extra).
// Push: claves VAPID propias, generadas la primera vez y guardadas en el disco de datos.
// WhatsApp: API oficial de Meta (WhatsApp Cloud API). Se activa con WHATSAPP_TOKEN y WHATSAPP_PHONE_ID,
// y además la administración de IAC tiene que activarlo empresa por empresa (es un extra de pago).
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { db, one, all, run, now } = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
db.exec(`
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL, json TEXT NOT NULL, agent TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_level INTEGER DEFAULT 2, wa_phone TEXT, wa_level INTEGER DEFAULT 3, wa_optin INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, user_id INTEGER, alert_id INTEGER,
  phone TEXT, status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL
);`);
if (!all('PRAGMA table_info(companies)').some(c => c.name === 'wa_enabled')) db.exec('ALTER TABLE companies ADD COLUMN wa_enabled INTEGER DEFAULT 0');

// ----- claves VAPID -----
let VAPID = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY } : null;
if (!VAPID) {
  const f = path.join(DATA_DIR, 'vapid.json');
  try { VAPID = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { VAPID = webpush.generateVAPIDKeys(); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(VAPID)); }
}
webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'avisos@iac.app'), VAPID.publicKey, VAPID.privateKey);

const WA = { token: process.env.WHATSAPP_TOKEN, phone: process.env.WHATSAPP_PHONE_ID, template: process.env.WHATSAPP_TEMPLATE || 'aviso_iac', lang: process.env.WHATSAPP_LANG || 'es', version: process.env.WHATSAPP_API_VERSION || 'v21.0', base: process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com' };
const waReady = () => !!(WA.token && WA.phone);
const prefs = uid => ({ push_level: 2, wa_phone: null, wa_level: 3, wa_optin: 0, ...(one('SELECT * FROM user_prefs WHERE user_id=?', uid) || {}) });
const phoneNorm = s => { const d = String(s || '').replace(/[^\d+]/g, '').replace(/^00/, '+'); const n = d.startsWith('+') ? d.slice(1) : d.length === 9 ? '34' + d : d; return /^\d{10,15}$/.test(n) ? n : null; };

async function sendPush(userId, payload) {
  let sent = 0;
  for (const s of all('SELECT * FROM push_subs WHERE user_id=?', userId)) {
    try { await webpush.sendNotification(JSON.parse(s.json), JSON.stringify(payload), { TTL: 3600 * 24 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subs WHERE id=?', s.id); }
  }
  return sent;
}
/** Envía un aviso por WhatsApp con la plantilla aprobada por Meta. Devuelve el estado. */
async function sendWhatsApp({ companyId, userId, alertId, phone, params }) {
  if (!waReady()) return 'sin_configurar';
  const body = { messaging_product: 'whatsapp', to: phone, type: 'template',
    template: { name: WA.template, language: { code: WA.lang }, components: [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t).slice(0, 900) })) }] } };
  try {
    const r = await fetch(`${WA.base}/${WA.version}/${WA.phone}/messages`, { method: 'POST', headers: { authorization: 'Bearer ' + WA.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && j.messages;
    run('INSERT INTO wa_log (company_id, user_id, alert_id, phone, status, error, created) VALUES (?,?,?,?,?,?,?)', companyId, userId, alertId || null, phone, ok ? 'enviado' : 'error', ok ? null : (j.error?.message || 'HTTP ' + r.status).slice(0, 300), now());
    return ok ? 'enviado' : 'error';
  } catch (e) {
    run('INSERT INTO wa_log (company_id, user_id, alert_id, phone, status, error, created) VALUES (?,?,?,?,?,?,?)', companyId, userId, alertId || null, phone, 'error', String(e.message).slice(0, 300), now());
    return 'error';
  }
}

/** Reparte un aviso a sus destinatarios por push y, si toca, por WhatsApp. */
async function dispatch(alertId) {
  const a = one('SELECT * FROM alerts WHERE id=?', alertId); if (!a) return;
  const company = one('SELECT * FROM companies WHERE id=?', a.company_id);
  const base = process.env.BASE_URL || '';
  const link = a.deal_id ? `/app#operacion/${a.deal_id}` : a.ext_id ? `/app#externo/${a.ext_id}` : '/app#avisos';
  const OUT = { ganado: 'Ganada', perdido: 'Perdida', standby: 'En espera' };
  for (const uid of JSON.parse(a.recipients || '[]')) {
    const p = prefs(uid);
    if (a.level >= p.push_level) await sendPush(uid, { title: `N${a.level} · ${a.title}`, body: `${OUT[a.outcome]}. ${a.summary || ''}`, url: link, tag: 'aviso-' + a.id });
    if (company.wa_enabled && p.wa_optin && p.wa_phone && a.level >= p.wa_level)
      await sendWhatsApp({ companyId: a.company_id, userId: uid, alertId: a.id, phone: p.wa_phone, params: [`N${a.level} ${OUT[a.outcome]}: ${a.title}`, a.summary || '-', base + '/app#avisos'] });
  }
}

function register(app, { auth, bad, num, str }) {
  app.get('/api/push/key', (req, res) => res.json({ key: VAPID.publicKey }));
  app.post('/api/push/subscribe', auth, (req, res) => {
    const s = req.body?.subscription; if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return bad(res, 'Suscripción no válida');
    run('INSERT INTO push_subs (user_id, endpoint, json, agent, created) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, json=excluded.json',
      req.user.id, s.endpoint, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }), str(req.headers['user-agent'], 200), now());
    res.json({ ok: true });
  });
  app.post('/api/push/unsubscribe', auth, (req, res) => { run('DELETE FROM push_subs WHERE user_id=? AND endpoint=?', req.user.id, String(req.body?.endpoint || '')); res.json({ ok: true }); });
  app.get('/api/notify/prefs', auth, (req, res) => {
    const c = one('SELECT wa_enabled FROM companies WHERE id=?', req.company.id);
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    res.json({ ...prefs(req.user.id), devices: one('SELECT count(*) n FROM push_subs WHERE user_id=?', req.user.id).n, wa_platform: waReady(), wa_company: !!c.wa_enabled,
      wa_month: one(`SELECT count(*) n FROM wa_log WHERE company_id=? AND status='enviado' AND created>=?`, req.company.id, month.getTime()).n });
  });
  app.put('/api/notify/prefs', auth, (req, res) => {
    const b = req.body || {}, lv = x => Math.min(4, Math.max(1, Math.floor(num(x) ?? 2)));
    const phone = b.wa_phone ? phoneNorm(b.wa_phone) : null; if (b.wa_phone && !phone) return bad(res, 'Escribe el móvil con prefijo, por ejemplo +34 600 123 456');
    run(`INSERT INTO user_prefs (user_id, push_level, wa_phone, wa_level, wa_optin) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET push_level=excluded.push_level, wa_phone=excluded.wa_phone, wa_level=excluded.wa_level, wa_optin=excluded.wa_optin`,
      req.user.id, lv(b.push_level), phone, lv(b.wa_level), b.wa_optin && phone ? 1 : 0);
    res.json({ ok: true });
  });
  app.post('/api/notify/test', auth, async (req, res) => {
    const ch = req.body?.channel;
    if (ch === 'push') { const n = await sendPush(req.user.id, { title: 'Prueba de avisos', body: 'Así te llegarán los avisos de pedidos.', url: '/app#avisos', tag: 'prueba' }); return res.json({ sent: n }); }
    if (ch === 'whatsapp') {
      const p = prefs(req.user.id), c = one('SELECT wa_enabled FROM companies WHERE id=?', req.company.id);
      if (!waReady()) return bad(res, 'WhatsApp aún no está conectado en la plataforma');
      if (!c.wa_enabled) return bad(res, 'WhatsApp no está activado para tu empresa');
      if (!p.wa_phone || !p.wa_optin) return bad(res, 'Guarda tu móvil y acepta recibir avisos por WhatsApp');
      const st = await sendWhatsApp({ companyId: req.company.id, userId: req.user.id, phone: p.wa_phone, params: ['Prueba de avisos', 'Así te llegarán los avisos de pedidos.', (process.env.BASE_URL || '') + '/app#avisos'] });
      return st === 'enviado' ? res.json({ ok: true }) : bad(res, 'No se ha podido enviar: ' + (one('SELECT error FROM wa_log WHERE user_id=? ORDER BY id DESC', req.user.id)?.error || st));
    }
    bad(res, 'Canal no válido');
  });
}

module.exports = { register, dispatch, waReady, phoneNorm };
