// Negociación con personas de empresas que no tienen agente.
// La otra parte entra por un enlace con la marca de la empresa y conversa con su asistente.
// Siempre se le informa de que habla con un asistente supervisado por una persona.
const crypto = require('crypto');
const path = require('path');
const { db, one, all, run, now, getPolicy } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS ext_negotiations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('compra','venta')),
  token TEXT UNIQUE NOT NULL,
  supervisor TEXT, cp_name TEXT, cp_company TEXT, cp_email TEXT,
  product_id INTEGER, product_name TEXT NOT NULL, unit TEXT DEFAULT 'ud', qty INTEGER NOT NULL, days INTEGER,
  open_price REAL NOT NULL, limit_price REAL NOT NULL, list_price REAL,
  our_offer REAL, their_offer REAL, price REAL, total REAL, rounds INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'abierta', agent_paused INTEGER DEFAULT 0,
  messages TEXT NOT NULL DEFAULT '[]', unread INTEGER DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, closed INTEGER
);`);

{ const have = all('PRAGMA table_info(ext_negotiations)').map(c => c.name);
  for (const [c, t] of [['mfr_code', 'TEXT'], ['buyer_code', 'TEXT'], ['cp_code_ok', 'INTEGER DEFAULT 0']]) if (!have.includes(c)) db.exec(`ALTER TABLE ext_negotiations ADD COLUMN ${c} ${t}`); }
const { norm } = require('./codes');

const RATE = { duro: 0.15, equilibrado: 0.28, flexible: 0.45 };
const MAX_ROUNDS = 6;
const r2 = n => Math.round(n * 100) / 100;
const eur = n => Number(n).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

/** Extrae un precio unitario de un texto libre: "6,20", "6.20 €", "a 6 euros". */
function parsePrice(text, ref) {
  const nums = [...String(text).matchAll(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:€|eur|euros)?/gi)].map(m => parseFloat(m[1].replace(',', '.'))).filter(n => n > 0);
  if (!nums.length) return null;
  // Se queda con el número más plausible como precio unitario (más cercano a la referencia)
  return nums.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref))[0];
}
const ASKS_HUMAN = /(hablar|habla|pasar|pásame|pasame|contactar).{0,25}(persona|humano|alguien|responsable|comercial)|persona real/i;
const ASKS_BOT = /(eres|es usted|sois|estoy hablando con).{0,25}(robot|bot|máquina|maquina|ia\b|inteligencia artificial|automátic|automatic|humano|persona)/i;
const ACCEPTS = /^(ok|vale|de acuerdo|acepto|aceptamos|aceptado|perfecto|trato|hecho|adelante|conforme)\b/i;
const REJECTS = /^(no|imposible|no podemos|lo dejamos|no nos interesa)\b/i;

function view(n) {
  return { ...n, messages: JSON.parse(n.messages || '[]'), agent_paused: !!n.agent_paused };
}
function push(n, who, text) {
  const msgs = JSON.parse(n.messages || '[]');
  msgs.push({ who, text, ts: now() });
  n.messages = JSON.stringify(msgs);
  return msgs;
}
function save(n) {
  run(`UPDATE ext_negotiations SET our_offer=?, their_offer=?, price=?, total=?, rounds=?, status=?, agent_paused=?, messages=?, unread=?, updated=?, closed=? WHERE id=?`,
    n.our_offer, n.their_offer, n.price, n.total, n.rounds, n.status, n.agent_paused ? 1 : 0, n.messages, n.unread, now(), n.closed || null, n.id);
}

/** ¿Hace falta aprobación del gestor para cerrar este precio? */
function needsApproval(n, price) {
  const pol = getPolicy(n.company_id, n.side), c = pol.cierre, total = price * n.qty;
  if (c.modo === 'aprobacion' || total > c.importe_max_auto) return true;
  if (n.side === 'venta' && n.list_price) return (1 - price / n.list_price) * 100 > c.descuento_max_auto;
  return false;
}
function close(n, price, company) {
  n.price = r2(price); n.total = r2(price * n.qty);
  if (needsApproval(n, price)) {
    n.status = 'pendiente';
    n.unread = 1;
    return `Perfecto, ${n.qty} ${n.unit} a ${eur(n.price)} por ${n.unit} (total ${eur(n.total)}). Lo confirmo con ${n.supervisor || 'mi responsable'} y le escribo por aquí en cuanto esté validado.`;
  }
  n.status = 'cerrada'; n.closed = now();
  if (n.side === 'venta' && n.product_id) run('UPDATE products SET stock=max(0, stock-?) WHERE id=?', n.qty, n.product_id);
  return `¡Cerrado! ${n.qty} ${n.unit} de ${n.product_name} a ${eur(n.price)} por ${n.unit}, total ${eur(n.total)}${n.days ? `, entrega en ${n.days} días` : ''}. Queda registrado como pedido de ${company.name}. Muchas gracias.`;
}

/**
 * Decide la respuesta del asistente ante un mensaje de la persona.
 * Compra: queremos precio bajo (abrimos en open_price, nunca pasamos de limit_price).
 * Venta: queremos precio alto (abrimos en open_price, nunca bajamos de limit_price).
 */
function decide(n, text, company) {
  const buying = n.side === 'compra';
  const pol = getPolicy(n.company_id, n.side);
  const rate = RATE[pol.estilo] ?? RATE.equilibrado;
  const better = (a, b) => buying ? a <= b : a >= b;        // a es igual o mejor que b para nosotros
  const seed = n.rounds + text.length;
  const t = text.trim();

  if (ASKS_BOT.test(t)) {
    return { reply: `Le soy sincero: soy el asistente ${buying ? 'de compras' : 'comercial'} de ${company.name}, un sistema automático que trabaja con las condiciones que me fija ${n.supervisor || 'el equipo'}, y una persona supervisa esta conversación. Si lo prefiere, pulse "Hablar con una persona" y le atenderán directamente.` };
  }
  if (ASKS_HUMAN.test(t)) {
    n.agent_paused = 1; n.status = 'humano'; n.unread = 1;
    return { reply: `Por supuesto. Aviso ahora mismo a ${n.supervisor || 'mi responsable'} para que continúe personalmente esta conversación. Le escribirá por aquí.` };
  }
  const price = parsePrice(t, n.our_offer);
  if (price == null) {
    if (ACCEPTS.test(t) && n.our_offer) return { reply: close(n, n.our_offer, company) };
    if (REJECTS.test(t)) {
      n.rounds++;
      if (n.rounds >= MAX_ROUNDS) return endNoDeal(n);
      return { reply: `Entiendo. ¿Qué precio por ${n.unit} le encajaría a usted? Si me da una cifra, veo hasta dónde puedo llegar.` };
    }
    return { reply: `Gracias. Para avanzar, ¿me indica su precio por ${n.unit} para ${n.qty} ${n.unit} de ${n.product_name}? Ahora mismo mi propuesta es ${eur(n.our_offer)}.` };
  }

  n.their_offer = price; n.rounds++;
  // Su precio ya es igual o mejor que nuestra oferta actual: aceptamos
  if (better(price, n.our_offer)) return { reply: close(n, price, company) };
  // Su precio está dentro de nuestro límite: cerramos si la diferencia es pequeña o ya llevamos varias rondas
  const within = better(price, n.limit_price);
  const gapPct = Math.abs(price - n.our_offer) / n.our_offer;
  if (within && (gapPct < 0.03 || n.rounds >= 4)) return { reply: close(n, price, company) };
  if (n.rounds >= MAX_ROUNDS) return endNoDeal(n);

  // Contraoferta: nos movemos hacia su precio, sin pasar nuestro límite ni su propia cifra
  let next = n.our_offer + rate * ((within ? price : n.limit_price) - n.our_offer);
  next = buying ? Math.min(next, n.limit_price) : Math.max(next, n.limit_price);
  next = r2(next);
  if (within && Math.abs(next - price) / price < 0.015) return { reply: close(n, price, company) };
  const moved = next !== n.our_offer;
  n.our_offer = next;
  const lines = within
    ? [`Nos acercamos. Si lo deja en ${eur(next)} por ${n.unit}, lo cerramos hoy mismo.`,
       `Estamos muy cerca. Mi propuesta es ${eur(next)} por ${n.unit} para las ${n.qty} ${n.unit}. ¿Lo cerramos?`,
       `Gracias por el esfuerzo. ¿Podemos dejarlo en ${eur(next)} por ${n.unit}?`]
    : buying
    ? [`Le agradezco la propuesta. A ${eur(price)} se nos va de presupuesto; puedo subir a ${eur(next)} por ${n.unit}.`,
       `Entiendo su posición. Haciendo un esfuerzo, podríamos llegar a ${eur(next)} por ${n.unit} para las ${n.qty} ${n.unit}.`,
       `Por volumen y continuidad, mi propuesta es ${eur(next)}. ¿Le encaja?`]
    : [`Gracias. A ${eur(price)} no me salen los números; puedo dejárselo en ${eur(next)} por ${n.unit}.`,
       `Entiendo. Por ser ${n.qty} ${n.unit}, puedo ajustar a ${eur(next)} por ${n.unit}${n.days ? ` con entrega en ${n.days} días` : ''}.`,
       `Mi mejor propuesta ahora mismo es ${eur(next)}. ¿Cerramos?`];
  return { reply: moved ? pick(lines, seed) : `Ahí ya estoy en mi límite: ${eur(next)} por ${n.unit} es lo máximo que puedo ${buying ? 'pagar' : 'ajustar'}. ¿Le encaja?` };
}
function endNoDeal(n) {
  n.status = 'sin_acuerdo'; n.closed = now(); n.unread = 1;
  return { reply: `Creo que esta vez no llegamos a un punto común: mi última propuesta es ${eur(n.our_offer)} por ${n.unit}. Le paso la conversación a ${n.supervisor || 'mi responsable'} por si puede ver otra opción. Gracias por su tiempo.` };
}

/** Redacción opcional más natural con la API de Anthropic (solo cambia la forma, nunca las cifras). */
async function polish(reply, n, company, history, key, model) {
  if (!key) return reply;
  const prompt = `Eres el asistente ${n.side === 'compra' ? 'de compras' : 'comercial'} de la empresa "${company.name}". Negocias por escrito con ${n.cp_name || 'una persona'} de ${n.cp_company || 'otra empresa'}.
Reescribe el MENSAJE PROPUESTO con un tono natural, cordial y profesional en español de España, como lo escribiría un buen comprador o comercial. Reglas estrictas:
- Mantén exactamente las mismas cifras, cantidades, precios y decisión. No añadas condiciones nuevas.
- Nunca afirmes ser una persona. Si el mensaje dice que eres un asistente, mantenlo.
- Máximo 3 frases. Sin saludos repetidos si la conversación ya ha empezado.
Últimos mensajes: ${JSON.stringify(history.slice(-6).map(m => ({ de: m.who, texto: m.text })))}
MENSAJE PROPUESTO: ${reply}
Responde solo con el mensaje final.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
    });
    const j = await r.json();
    const out = (j.content || []).map(c => c.text || '').join('').trim();
    // Seguridad: si cambia alguna cifra, se usa el texto original
    const digits = s => (s.match(/\d+(?:[.,]\d+)?/g) || []).map(x => x.replace('.', '').replace(',', '.')).sort().join('|');
    return out && digits(out) === digits(reply) ? out : reply;
  } catch { return reply; }
}

function register(app, { auth, active, bad, str, num, publicCompany, sellerSide, buyerSide, isActive, AGENT_KEY, AGENT_MODEL }) {
  const mine = (req, id) => one('SELECT * FROM ext_negotiations WHERE id=? AND company_id=?', id, req.company.id);

  // ----- panel interno -----
  app.get('/api/ext', auth, (req, res) => res.json(all('SELECT * FROM ext_negotiations WHERE company_id=? ORDER BY updated DESC LIMIT 200', req.company.id).map(view)));
  app.get('/api/ext/:id', auth, (req, res) => { const n = mine(req, +req.params.id); if (!n) return bad(res, 'No encontrada', 404); run('UPDATE ext_negotiations SET unread=0 WHERE id=?', n.id); res.json(view(n)); });
  app.post('/api/ext', auth, active, (req, res) => {
    const b = req.body || {}, c = req.company;
    const side = b.side === 'venta' ? 'venta' : 'compra';
    if (side === 'venta' && !sellerSide(c)) return bad(res, 'Tu empresa no tiene activado el lado de ventas');
    if (side === 'compra' && !buyerSide(c)) return bad(res, 'Tu empresa no tiene activado el lado de compras');
    const qty = Math.floor(num(b.qty, 1) ?? 0), days = Math.floor(num(b.days) ?? 0) || null;
    let product_name = str(b.product_name, 160), unit = str(b.unit, 20) || 'ud', open, limit, list = null, product_id = null;
    let mfr_code = norm(b.mfr_code) || null, buyer_code = norm(b.buyer_code) || null;
    if (side === 'venta') {
      const p = one('SELECT * FROM products WHERE id=? AND company_id=? AND active=1', +b.product_id, c.id);
      if (!p) return bad(res, 'Elige un producto de tu catálogo');
      if (qty > p.stock) return bad(res, `Solo tienes ${p.stock} en stock`);
      const pol = getPolicy(c.id, 'venta');
      const floor = Math.max(p.min_price, p.cost > 0 ? p.cost * (1 + pol.margen_min_pct / 100) : 0);
      mfr_code = norm(p.sku) || null; buyer_code = norm(b.buyer_code) || null;
      product_id = p.id; product_name = p.name; unit = p.unit || 'ud'; list = p.list_price;
      open = num(b.open_price) ?? p.list_price; limit = r2(Math.max(floor, num(b.limit_price) ?? floor));
      if (open < limit) return bad(res, 'El precio de salida no puede ser menor que tu mínimo');
    } else {
      open = num(b.open_price); limit = num(b.limit_price);
      if (open == null || limit == null || limit < open) return bad(res, 'Precio objetivo y precio máximo (mayor o igual que el objetivo)');
    }
    if (!product_name || !qty) return bad(res, 'Producto y cantidad');
    const token = crypto.randomBytes(18).toString('base64url');
    const supervisor = str(b.supervisor, 80) || req.user.name || req.user.email;
    const cp_name = str(b.cp_name, 80), cp_company = str(b.cp_company, 120);
    const first = side === 'compra'
      ? `Buenos días${cp_name ? ' ' + cp_name : ''}. Soy el asistente de compras de ${c.name}. Necesitamos ${qty} ${unit} de ${product_name}${days ? ` con entrega en ${days} días como máximo` : ''}. Nuestra propuesta es ${eur(open)} por ${unit}. ¿Qué precio nos puede ofrecer?`
      : `Buenos días${cp_name ? ' ' + cp_name : ''}. Soy el asistente comercial de ${c.name}. Le propongo ${qty} ${unit} de ${product_name} a ${eur(open)} por ${unit}${days ? `, con entrega en ${days} días` : ''}. ¿Le encaja o prefiere que lo ajustemos?`;
    const msgs = JSON.stringify([{ who: 'agent', text: first, ts: now() }]);
    const r = run(`INSERT INTO ext_negotiations (company_id, side, token, supervisor, cp_name, cp_company, cp_email, mfr_code, buyer_code, product_id, product_name, unit, qty, days, open_price, limit_price, list_price, our_offer, status, messages, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.id, side, token, supervisor, cp_name, cp_company, str(b.cp_email, 160), mfr_code, buyer_code, product_id, product_name, unit, qty, days, open, limit, list, open, 'abierta', msgs, now(), now());
    res.json({ id: Number(r.lastInsertRowid), token });
  });
  // Un miembro del equipo escribe en la conversación (el asistente queda en pausa)
  app.post('/api/ext/:id/message', auth, active, (req, res) => {
    const n = mine(req, +req.params.id); if (!n) return bad(res, 'No encontrada', 404);
    const text = str(req.body?.text, 2000); if (!text) return bad(res, 'Escribe un mensaje');
    push(n, 'staff', text); n.agent_paused = 1; n.unread = 0;
    // Si la persona del equipo propone un precio dentro de los límites, el asistente lo toma como propuesta vigente
    const p = parsePrice(text, n.our_offer);
    if (p != null && (n.side === 'compra' ? p <= n.limit_price : p >= n.limit_price)) n.our_offer = p;
    if (n.status === 'abierta') n.status = 'humano';
    save(n); res.json(view(one('SELECT * FROM ext_negotiations WHERE id=?', n.id)));
  });
  app.post('/api/ext/:id/:action', auth, active, (req, res) => {
    const n = mine(req, +req.params.id); if (!n) return bad(res, 'No encontrada', 404);
    const a = req.params.action;
    if (a === 'reanudar') { n.agent_paused = 0; if (n.status === 'humano') n.status = 'abierta'; push(n, 'sys', 'El asistente retoma la conversación.'); }
    else if (a === 'aprobar' && n.status === 'pendiente') {
      n.status = 'cerrada'; n.closed = now();
      if (n.side === 'venta' && n.product_id) run('UPDATE products SET stock=max(0, stock-?) WHERE id=?', n.qty, n.product_id);
      push(n, 'agent', `Confirmado por ${req.user.name || n.supervisor}: ${n.qty} ${n.unit} a ${eur(n.price)} por ${n.unit}, total ${eur(n.total)}. Muchas gracias.`);
    } else if (a === 'rechazar' && n.status === 'pendiente') {
      n.status = 'sin_acuerdo'; n.closed = now();
      push(n, 'agent', `Lo siento, ${req.user.name || n.supervisor} no ha podido validar estas condiciones. Si quiere, seguimos hablando para buscar otra opción.`);
    } else if (a === 'cancelar') { n.status = 'cancelada'; n.closed = now(); push(n, 'sys', 'Negociación cancelada.'); }
    else return bad(res, 'Acción no válida en este estado');
    n.unread = 0; save(n); res.json(view(one('SELECT * FROM ext_negotiations WHERE id=?', n.id)));
  });

  // ----- página pública para la otra parte -----
  const byToken = t => one('SELECT * FROM ext_negotiations WHERE token=?', String(t || '').slice(0, 60));
  const publicView = n => {
    const c = one('SELECT * FROM companies WHERE id=?', n.company_id);
    return {
      company: publicCompany(c), side: n.side, supervisor: n.supervisor, cp_name: n.cp_name, product_name: n.product_name, unit: n.unit, qty: n.qty, days: n.days,
      mfr_code: n.mfr_code, buyer_code: n.buyer_code, cp_code_ok: !!n.cp_code_ok,
      our_offer: n.our_offer, price: n.price, total: n.total, status: n.status, agent_paused: !!n.agent_paused,
      messages: JSON.parse(n.messages || '[]').filter(m => m.who !== 'sys').map(m => ({ who: m.who === 'human' ? 'you' : m.who, text: m.text, ts: m.ts }))
    };
  };
  app.get('/n/:token', (req, res) => byToken(req.params.token) ? res.sendFile(path.join(__dirname, 'public', 'n.html')) : res.status(404).send('Enlace no válido'));
  app.get('/api/public/n/:token', (req, res) => { const n = byToken(req.params.token); n ? res.json(publicView(n)) : bad(res, 'Enlace no válido', 404); });
  const hits = new Map();
  app.post('/api/public/n/:token', async (req, res) => {
    const n = byToken(req.params.token); if (!n) return bad(res, 'Enlace no válido', 404);
    const k = n.id + ':' + Math.floor(Date.now() / 60000); hits.set(k, (hits.get(k) || 0) + 1);
    if (hits.get(k) > 20) return bad(res, 'Demasiados mensajes seguidos. Espere un momento.', 429);
    if (hits.size > 5000) hits.clear();
    const company = one('SELECT * FROM companies WHERE id=?', n.company_id);
    if (['cerrada', 'cancelada'].includes(n.status)) return bad(res, 'Esta negociación ya está cerrada');
    const action = req.body?.action;
    if (action === 'codigos') { // la otra parte pone su código y confirma que los dos son el mismo artículo
      const code = norm(req.body?.code);
      const theirs = n.side === 'venta' ? 'buyer_code' : 'mfr_code';
      if (!n[theirs] && !code) return bad(res, 'Escriba su código de artículo');
      if (code && n[theirs] && n[theirs] !== code) return bad(res, `Aquí consta el código ${n[theirs]}. Si no es correcto, pida hablar con una persona.`);
      if (code) n[theirs] = code;
      run(`UPDATE ext_negotiations SET ${theirs}=?, cp_code_ok=1, unread=1, updated=? WHERE id=?`, n[theirs], now(), n.id);
      const m = JSON.parse(n.messages || '[]'); m.push({ who: 'sys', text: `La otra parte confirma los códigos: fabricante ${n.mfr_code || '—'} · cliente ${n.buyer_code || '—'}.`, ts: now() });
      run('UPDATE ext_negotiations SET messages=? WHERE id=?', JSON.stringify(m), n.id);
      return res.json(publicView(one('SELECT * FROM ext_negotiations WHERE id=?', n.id)));
    }
    let text = str(req.body?.text, 1500);
    if (action === 'humano') text = 'Me gustaría hablar con una persona.';
    if (action === 'aceptar') text = 'Acepto la propuesta.';
    if (!text) return bad(res, 'Escriba un mensaje');
    const msgs = push(n, 'human', text);
    n.unread = 1;
    if (action === 'humano') { n.agent_paused = 1; n.status = 'humano'; push(n, 'agent', `Por supuesto. Aviso ahora mismo a ${n.supervisor || 'mi responsable'} para que continúe personalmente esta conversación. Le escribirá por aquí.`); }
    else if (n.agent_paused || !isActive(company) || n.status !== 'abierta') {
      if (n.status === 'sin_acuerdo') { n.status = 'abierta'; n.closed = null; n.rounds = Math.max(0, MAX_ROUNDS - 2); n.agent_paused = 0; const d = decide(n, text, company); push(n, 'agent', await polish(d.reply, n, company, msgs, AGENT_KEY, AGENT_MODEL)); }
      // en pausa: el mensaje queda para el equipo
    } else {
      const d = action === 'aceptar' ? { reply: close(n, n.our_offer, company) } : decide(n, text, company);
      push(n, 'agent', await polish(d.reply, n, company, msgs, AGENT_KEY, AGENT_MODEL));
    }
    save(n);
    res.json(publicView(one('SELECT * FROM ext_negotiations WHERE id=?', n.id)));
  });

  // Pedido imprimible de una negociación externa
  app.get('/pedido-externo/:id', auth, (req, res) => {
    const n = mine(req, +req.params.id); if (!n || n.status !== 'cerrada') return res.status(404).send('Pedido no encontrado');
    const c = req.company, e = x => String(x ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const us = `<div class="lh" style="border-color:${e(c.color)}">${c.logo ? `<img src="${e(c.logo)}" alt="">` : ''}<b>${e(c.name)}</b><br>${e(c.tax_id)}<br>${e(c.address)}<br>${e(c.phone)} ${e(c.web)}</div>`;
    const them = `<div class="lh" style="border-color:#c5cad3"><b>${e(n.cp_company || '—')}</b><br>${e(n.cp_name)}<br>${e(n.cp_email)}</div>`;
    res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Pedido E-${n.id}</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#1d2330;max-width:820px;margin:30px auto;padding:0 24px}.top{display:flex;justify-content:space-between;border-bottom:4px solid ${e(c.color)};padding-bottom:14px}.top img{max-height:64px}h1{margin:0;font-size:22px;color:${e(c.color)}}.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:20px 0}.lh{border-left:4px solid;padding-left:12px}.lh img{max-height:36px;display:block;margin-bottom:6px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #dde1e7;text-align:left}.n{text-align:right}.tot{font-size:18px;font-weight:700;text-align:right;margin-top:12px}@media print{button{display:none}}</style></head><body>
    <div class="top"><div>${c.logo ? `<img src="${e(c.logo)}">` : `<h1>${e(c.name)}</h1>`}</div><div style="text-align:right"><h1>Pedido E-${n.id}</h1>${new Date(n.closed).toLocaleDateString('es-ES')}</div></div>
    <div class="cols"><div><small>${n.side === 'venta' ? 'PROVEEDOR' : 'CLIENTE'}</small>${us}</div><div><small>${n.side === 'venta' ? 'CLIENTE' : 'PROVEEDOR'}</small>${them}</div></div>
    <table><tr><th>Cód. fabricante</th><th>Cód. cliente</th><th>Producto</th><th class="n">Cantidad</th><th class="n">Precio</th><th class="n">Importe</th></tr><tr><td><b>${e(n.mfr_code || '—')}</b></td><td><b>${e(n.buyer_code || '—')}</b></td><td>${e(n.product_name)}</td><td class="n">${n.qty} ${e(n.unit)}</td><td class="n">${eur(n.price)}</td><td class="n">${eur(n.total)}</td></tr></table>
    <div class="tot">Total (sin impuestos): ${eur(n.total)}</div>${n.days ? `<p>Plazo de entrega: ${n.days} días.</p>` : ''}<p>${n.cp_code_ok ? '✔ Códigos de artículo confirmados por la otra parte.' : 'Códigos de artículo no confirmados por la otra parte.'}</p><button onclick="print()">Imprimir o guardar en PDF</button></body></html>`);
  });
}

module.exports = { register, decide, parsePrice };
