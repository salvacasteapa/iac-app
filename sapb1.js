// Conector con SAP Business One a través de su Service Layer (API REST oficial de SAP B1).
// Del ERP a IAC: familias (grupos de artículos), artículos con precio de una lista, stock y unidad,
//   y la correspondencia entre empresas de IAC e interlocutores de SAP (por NIF), con su grupo de clientes.
// De IAC al ERP: cada pedido cerrado se crea como pedido de cliente (lado ventas) o pedido de compra (lado compras).
const http = require('http');
const https = require('https');
const { db, one, all, run, now } = require('./db');
const I = require('./integracion');

db.exec(`
CREATE TABLE IF NOT EXISTS erp_config (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  url TEXT, company_db TEXT, username TEXT, password_enc TEXT, insecure INTEGER DEFAULT 0,
  price_list INTEGER DEFAULT 1, min_discount REAL DEFAULT 10,
  sync_items INTEGER DEFAULT 1, sync_partners INTEGER DEFAULT 1, push_sales INTEGER DEFAULT 1, push_purchases INTEGER DEFAULT 1,
  sync_minutes INTEGER DEFAULT 60, active INTEGER DEFAULT 0, last_sync INTEGER, last_status TEXT, last_error TEXT, updated INTEGER
);
CREATE TABLE IF NOT EXISTS erp_partners (
  company_id INTEGER NOT NULL, other_id INTEGER NOT NULL, card_code TEXT NOT NULL, card_name TEXT, auto INTEGER DEFAULT 1,
  PRIMARY KEY (company_id, other_id)
);
CREATE TABLE IF NOT EXISTS erp_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, deal_id INTEGER NOT NULL, doc_type TEXT, doc_entry INTEGER, doc_num INTEGER,
  status TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, UNIQUE (company_id, deal_id)
);
CREATE TABLE IF NOT EXISTS erp_log (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, kind TEXT, status TEXT, message TEXT, created INTEGER NOT NULL);`);

const log = (cid, kind, status, message) => { run('INSERT INTO erp_log (company_id, kind, status, message, created) VALUES (?,?,?,?,?)', cid, kind, status, String(message).slice(0, 500), now()); run('DELETE FROM erp_log WHERE company_id=? AND id NOT IN (SELECT id FROM erp_log WHERE company_id=? ORDER BY id DESC LIMIT 60)', cid, cid); };
const isSeller = c => c.role === 'vendedor' || c.role === 'ambos', isBuyer = c => c.role === 'comprador' || c.role === 'ambos';

// ---------- cliente del Service Layer ----------
class ServiceLayer {
  constructor(cfg) { this.base = cfg.url.replace(/\/+$/, ''); this.cfg = cfg; this.cookie = ''; }
  req(method, p, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(/^https?:/.test(p) ? p : this.base + '/' + p.replace(/^\/+/, ''));
      const data = body ? JSON.stringify(body) : null;
      const lib = u.protocol === 'https:' ? https : http;
      const r = lib.request(u, { method, timeout: 30e3, rejectUnauthorized: !this.cfg.insecure,
        headers: { accept: 'application/json', 'content-type': 'application/json', cookie: this.cookie, Prefer: 'odata.maxpagesize=500', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
        let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
        res.on('end', () => {
          const sc = res.headers['set-cookie']; if (sc) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
          let j = null; try { j = b ? JSON.parse(b) : null; } catch { }
          if (res.statusCode >= 400) { const m = j?.error?.message; return reject(new Error(`SAP B1 respondió ${res.statusCode}: ${typeof m === 'string' ? m : m?.value || b.slice(0, 200) || 'sin detalle'}`)); }
          resolve(j);
        });
      });
      r.on('timeout', () => r.destroy(new Error('SAP B1 no responde (30 s). Revisa la dirección y que el Service Layer sea accesible desde internet.')));
      r.on('error', e => reject(new Error(/self.signed|certificate/i.test(e.message) ? 'El certificado del servidor no es de confianza. Si es un certificado propio, marca «Aceptar certificado propio».' : /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH/.test(e.code || e.message) ? `No se puede llegar al servidor (${e.code || e.message}). Revisa la dirección y el cortafuegos.` : e.message)));
      if (data) r.write(data); r.end();
    });
  }
  async login() { await this.req('POST', 'Login', { CompanyDB: this.cfg.company_db, UserName: this.cfg.username, Password: I.open(this.cfg.password_enc) }); }
  async logout() { try { await this.req('POST', 'Logout'); } catch { } }
  async list(p) { const out = []; let next = p; while (next) { const j = await this.req('GET', next); out.push(...(j?.value || [])); next = j?.['odata.nextLink'] || j?.['@odata.nextLink'] || null; if (out.length > 50000) break; } return out; }
}

const yes = v => v === 'tYES' || v === 'Y' || v === true;

/** Trae de SAP B1 familias, artículos e interlocutores. */
async function sync(cid) {
  const cfg = one('SELECT * FROM erp_config WHERE company_id=?', cid); if (!cfg?.url) throw new Error('Falta configurar la conexión con SAP B1');
  const company = one('SELECT * FROM companies WHERE id=?', cid);
  const sl = new ServiceLayer(cfg), res = { articulos: null, interlocutores: null };
  try {
    await sl.login();
    if (cfg.sync_items && isSeller(company)) {
      const groups = new Map((await sl.list('ItemGroups?$select=Number,GroupName')).map(g => [g.Number, g.GroupName]));
      const items = await sl.list(`Items?$select=ItemCode,ItemName,ItemsGroupCode,QuantityOnStock,BarCode,SalesUnit,SalesItem,Valid,Frozen,ItemPrices&$filter=SalesItem eq 'tYES'`);
      const existing = new Set(all('SELECT sku FROM products WHERE company_id=? AND active=1', cid).map(p => p.sku));
      let sinPrecio = 0;
      const rows = items.filter(it => yes(it.Valid ?? 'tYES') && !yes(it.Frozen)).map(it => {
        const price = (it.ItemPrices || []).find(p => p.PriceList === cfg.price_list)?.Price;
        if (!(price > 0)) { sinPrecio++; return null; }
        const r = { codigo: it.ItemCode, nombre: it.ItemName, familia: groups.get(it.ItemsGroupCode) || '', precio_lista: price, stock: Math.max(0, Math.floor(it.QuantityOnStock || 0)), unidad: it.SalesUnit || undefined, ean: it.BarCode || undefined };
        if (!existing.has(require('./codes').norm(it.ItemCode))) r.precio_minimo = Math.round(price * (1 - (cfg.min_discount || 0) / 100) * 100) / 100;
        return r;
      }).filter(Boolean);
      res.articulos = { ...I.upsertItems(cid, rows, 'sapb1'), sin_precio: sinPrecio };
    }
    if (cfg.sync_partners) {
      const bgroups = new Map((await sl.list('BusinessPartnerGroups?$select=Code,Name')).map(g => [g.Code, g.Name]));
      const bps = await sl.list('BusinessPartners?$select=CardCode,CardName,CardType,FederalTaxID,GroupCode');
      // Empresas conectadas en IAC: clientes (si vendo) y proveedores (si compro)
      const others = all(`SELECT c.*, CASE WHEN k.seller_id=? THEN 'cCustomer' ELSE 'cSupplier' END kind FROM connections k JOIN companies c ON c.id = CASE WHEN k.seller_id=? THEN k.buyer_id ELSE k.seller_id END
        WHERE (k.seller_id=? OR k.buyer_id=?) AND k.status IN ('activa','pausada','pendiente')`, cid, cid, cid, cid);
      let enlazados = 0, sinNif = 0; const grupos = [];
      for (const o of others) {
        const nif = I.taxNorm(o.tax_id); if (!nif) { sinNif++; continue; }
        const bp = bps.find(b => b.CardType === o.kind && I.taxNorm(b.FederalTaxID) === nif); if (!bp) continue;
        const cur = one('SELECT * FROM erp_partners WHERE company_id=? AND other_id=?', cid, o.id);
        if (!cur || cur.auto) run(`INSERT INTO erp_partners (company_id, other_id, card_code, card_name, auto) VALUES (?,?,?,?,1) ON CONFLICT(company_id, other_id) DO UPDATE SET card_code=excluded.card_code, card_name=excluded.card_name WHERE auto=1`, cid, o.id, bp.CardCode, bp.CardName);
        enlazados++;
        if (o.kind === 'cCustomer' && bgroups.get(bp.GroupCode)) grupos.push({ codigo_empresa: o.code, grupo: bgroups.get(bp.GroupCode) });
      }
      if (grupos.length) I.upsertClients(cid, grupos);
      res.interlocutores = { conectados: others.length, enlazados, sin_nif: sinNif, grupos: grupos.length };
    }
    run(`UPDATE erp_config SET last_sync=?, last_status='ok', last_error=NULL WHERE company_id=?`, now(), cid);
    log(cid, 'sincronizacion', 'ok', [res.articulos && `artículos: ${res.articulos.creados} nuevos, ${res.articulos.actualizados} actualizados${res.articulos.sin_precio ? `, ${res.articulos.sin_precio} sin precio en la lista ${cfg.price_list}` : ''}${res.articulos.errores.length ? `, ${res.articulos.errores.length} con error` : ''}`,
      res.interlocutores && `empresas enlazadas: ${res.interlocutores.enlazados} de ${res.interlocutores.conectados}${res.interlocutores.sin_nif ? ` (${res.interlocutores.sin_nif} sin NIF en IAC)` : ''}`].filter(Boolean).join(' · ') || 'nada que sincronizar');
    return res;
  } catch (e) {
    run(`UPDATE erp_config SET last_sync=?, last_status='error', last_error=? WHERE company_id=?`, now(), e.message.slice(0, 500), cid);
    log(cid, 'sincronizacion', 'error', e.message); throw e;
  } finally { await sl.logout(); }
}

/** Crea en SAP B1 el pedido de cliente o de compra de un pedido cerrado en IAC. */
async function pushDeal(cid, dealId, force = false) {
  const cfg = one('SELECT * FROM erp_config WHERE company_id=? AND active=1', cid); if (!cfg) return null;
  const d = one('SELECT * FROM deals WHERE id=?', dealId); if (!d || d.status !== 'cerrado' || (d.seller_id !== cid && d.buyer_id !== cid)) return null;
  const side = d.seller_id === cid ? 'venta' : 'compra';
  if (side === 'venta' ? !cfg.push_sales : !cfg.push_purchases) return null;
  const prev = one('SELECT * FROM erp_docs WHERE company_id=? AND deal_id=?', cid, dealId);
  if (prev && prev.status === 'ok') return prev; if (prev && !force) return prev;
  const type = side === 'venta' ? 'Orders' : 'PurchaseOrders';
  const fail = msg => { run(`INSERT INTO erp_docs (company_id, deal_id, doc_type, status, error, created) VALUES (?,?,?,'error',?,?) ON CONFLICT(company_id, deal_id) DO UPDATE SET status='error', error=excluded.error, created=excluded.created`, cid, dealId, type, msg, now()); log(cid, 'pedido', 'error', `Pedido ${dealId}: ${msg}`); return { status: 'error', error: msg }; };
  const other = side === 'venta' ? d.buyer_id : d.seller_id;
  const bp = one('SELECT * FROM erp_partners WHERE company_id=? AND other_id=?', cid, other);
  const oname = one('SELECT name FROM companies WHERE id=?', other)?.name;
  if (!bp) return fail(`${oname} no está enlazado con ningún ${side === 'venta' ? 'cliente' : 'proveedor'} de SAP B1. Pon su NIF en IAC y sincroniza, o escribe su código de SAP en Integraciones.`);
  const p = one('SELECT * FROM products WHERE id=?', d.product_id);
  const item = side === 'venta' ? (p?.erp_code || p?.sku) : d.buyer_code;
  if (!item) return fail('Falta tu código de artículo para este pedido. Vincúlalo en «Códigos de artículo»: tu código debe ser el mismo que en SAP B1.');
  const due = new Date((d.closed || now()) + (d.lead_days || 0) * 864e5).toISOString().slice(0, 10);
  const doc = { CardCode: bp.card_code, DocDueDate: due, NumAtCard: `IAC-${d.id}`, Comments: `Pedido nº ${d.id} cerrado en IAC${d.auth_id ? ' con autorización especial nº ' + d.auth_id : ''}.`,
    DocumentLines: [{ ItemCode: item, Quantity: d.qty, UnitPrice: d.price }] };
  const sl = new ServiceLayer(cfg);
  try {
    await sl.login();
    const r = await sl.req('POST', type, doc);
    run(`INSERT INTO erp_docs (company_id, deal_id, doc_type, doc_entry, doc_num, status, error, created) VALUES (?,?,?,?,?,'ok',NULL,?) ON CONFLICT(company_id, deal_id) DO UPDATE SET doc_entry=excluded.doc_entry, doc_num=excluded.doc_num, status='ok', error=NULL, created=excluded.created`, cid, dealId, type, r?.DocEntry || null, r?.DocNum || null, now());
    log(cid, 'pedido', 'ok', `Pedido ${dealId} creado en SAP B1 como ${side === 'venta' ? 'pedido de cliente' : 'pedido de compra'} nº ${r?.DocNum ?? '?'}`);
    return { status: 'ok', doc_num: r?.DocNum };
  } catch (e) { return fail(e.message); } finally { await sl.logout(); }
}

// Pedidos cerrados: se envían solos
I.on((cid, event, data) => { if (event === 'pedido.cerrado') pushDeal(cid, data.id).catch(e => console.error('sapb1', e.message)); });
// Sincronización periódica
const timer = setInterval(() => {
  for (const c of all('SELECT * FROM erp_config WHERE active=1')) if (!c.last_sync || now() - c.last_sync > Math.max(15, c.sync_minutes || 60) * 60e3) sync(c.company_id).catch(() => {});
}, 5 * 60e3); timer.unref?.();

function register(app, { auth, active, bad, str, num, admin }) {
  const view = cid => {
    const c = one('SELECT * FROM erp_config WHERE company_id=?', cid) || {};
    const others = all(`SELECT c.id, c.name, c.code, c.tax_id, CASE WHEN k.seller_id=? THEN 'cliente' ELSE 'proveedor' END rel FROM connections k JOIN companies c ON c.id = CASE WHEN k.seller_id=? THEN k.buyer_id ELSE k.seller_id END
      WHERE (k.seller_id=? OR k.buyer_id=?) AND k.status IN ('activa','pausada','pendiente') ORDER BY c.name`, cid, cid, cid, cid)
      .map(o => ({ ...o, sap: one('SELECT card_code, card_name, auto FROM erp_partners WHERE company_id=? AND other_id=?', cid, o.id) || null }));
    return { config: { url: c.url || '', company_db: c.company_db || '', username: c.username || '', has_password: !!c.password_enc, insecure: !!c.insecure, price_list: c.price_list ?? 1, min_discount: c.min_discount ?? 10,
        sync_items: c.sync_items ?? 1, sync_partners: c.sync_partners ?? 1, push_sales: c.push_sales ?? 1, push_purchases: c.push_purchases ?? 1, sync_minutes: c.sync_minutes ?? 60, active: !!c.active,
        last_sync: c.last_sync || null, last_status: c.last_status || null, last_error: c.last_error || null },
      partners: others, log: all('SELECT kind, status, message, created FROM erp_log WHERE company_id=? ORDER BY id DESC LIMIT 30', cid),
      docs: all(`SELECT e.*, d.total, d.qty FROM erp_docs e JOIN deals d ON d.id=e.deal_id WHERE e.company_id=? ORDER BY e.id DESC LIMIT 50`, cid) };
  };
  app.get('/api/erp/sapb1', auth, admin, (req, res) => res.json(view(req.company.id)));
  app.put('/api/erp/sapb1', auth, active, admin, (req, res) => {
    const b = req.body || {}, cid = req.company.id, cur = one('SELECT * FROM erp_config WHERE company_id=?', cid);
    const url = str(b.url, 300).replace(/\/+$/, ''); let u; try { u = new URL(url); } catch { }
    if (!u || !/^https?:$/.test(u.protocol)) return bad(res, 'Pon la dirección del Service Layer, por ejemplo https://miservidor:50000/b1s/v1');
    if (u.protocol === 'http:' && process.env.NODE_ENV !== 'test') return bad(res, 'Por seguridad, la dirección tiene que empezar por https://');
    const company_db = str(b.company_db, 100), username = str(b.username, 100);
    if (!company_db || !username) return bad(res, 'Pon la base de datos de la empresa y el usuario de SAP B1');
    const pass = typeof b.password === 'string' && b.password ? I.seal(b.password) : cur?.password_enc; if (!pass) return bad(res, 'Pon la contraseña del usuario de SAP B1');
    const flag = (k, d) => b[k] === undefined ? d : b[k] === true || b[k] === 'true' || b[k] === 1 || b[k] === 'on' ? 1 : 0;
    const vals = [url, company_db, username, pass, flag('insecure', 0), Math.max(1, Math.floor(num(b.price_list) ?? 1)), Math.min(90, num(b.min_discount) ?? 10),
      flag('sync_items', 1), flag('sync_partners', 1), flag('push_sales', 1), flag('push_purchases', 1), Math.max(15, Math.floor(num(b.sync_minutes) ?? 60)), flag('active', cur?.active ?? 0), now()];
    run(`INSERT INTO erp_config (company_id, url, company_db, username, password_enc, insecure, price_list, min_discount, sync_items, sync_partners, push_sales, push_purchases, sync_minutes, active, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(company_id) DO UPDATE SET url=excluded.url, company_db=excluded.company_db, username=excluded.username, password_enc=excluded.password_enc, insecure=excluded.insecure, price_list=excluded.price_list, min_discount=excluded.min_discount,
      sync_items=excluded.sync_items, sync_partners=excluded.sync_partners, push_sales=excluded.push_sales, push_purchases=excluded.push_purchases, sync_minutes=excluded.sync_minutes, active=excluded.active, updated=excluded.updated`, cid, ...vals);
    res.json({ ok: true });
  });
  app.post('/api/erp/sapb1/probar', auth, admin, async (req, res) => {
    const cfg = one('SELECT * FROM erp_config WHERE company_id=?', req.company.id); if (!cfg) return bad(res, 'Guarda primero los datos de conexión');
    const sl = new ServiceLayer(cfg);
    try {
      await sl.login();
      const count = async p => { try { return +(await sl.req('GET', p + '/$count')) || 0; } catch { return null; } };
      const r = { ok: true, articulos: await count('Items'), interlocutores: await count('BusinessPartners') };
      log(req.company.id, 'prueba', 'ok', 'Conexión correcta'); res.json(r);
    } catch (e) { log(req.company.id, 'prueba', 'error', e.message); bad(res, e.message); } finally { await sl.logout(); }
  });
  app.post('/api/erp/sapb1/activar', auth, active, admin, (req, res) => {
    const on = req.body?.active ? 1 : 0;
    if (!run('UPDATE erp_config SET active=? WHERE company_id=?', on, req.company.id).changes) return bad(res, 'Guarda primero los datos de conexión');
    log(req.company.id, 'estado', 'ok', on ? 'Conector activado' : 'Conector pausado'); res.json({ ok: true });
  });
  app.post('/api/erp/sapb1/sincronizar', auth, active, admin, async (req, res) => { try { res.json(await sync(req.company.id)); } catch (e) { bad(res, e.message); } });
  app.post('/api/erp/sapb1/reenviar/:deal', auth, active, admin, async (req, res) => {
    const r = await pushDeal(req.company.id, +req.params.deal, true); if (!r) return bad(res, 'Ese pedido no se envía a SAP B1 (no está cerrado o el envío está desactivado)');
    r.status === 'ok' ? res.json(r) : bad(res, r.error);
  });
  app.post('/api/erp/sapb1/interlocutor', auth, active, admin, (req, res) => {
    const cid = req.company.id, oid = +req.body?.other_id, code = str(req.body?.card_code, 50);
    if (!one('SELECT id FROM connections WHERE (seller_id=? AND buyer_id=?) OR (buyer_id=? AND seller_id=?)', cid, oid, cid, oid)) return bad(res, 'Empresa no conectada');
    if (!code) { run('DELETE FROM erp_partners WHERE company_id=? AND other_id=?', cid, oid); return res.json({ ok: true }); }
    run(`INSERT INTO erp_partners (company_id, other_id, card_code, auto) VALUES (?,?,?,0) ON CONFLICT(company_id, other_id) DO UPDATE SET card_code=excluded.card_code, card_name=NULL, auto=0`, cid, oid, code);
    res.json({ ok: true });
  });
}

module.exports = { register, sync, pushDeal, ServiceLayer };
