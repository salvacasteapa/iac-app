// Catálogo enriquecido: fotos y vídeo por artículo, certificados y proyectos de la empresa.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, one, all, run, now, getPolicy } = require('./db');
const { norm, gtinOk } = require('./codes');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, name TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, issuer TEXT, number TEXT, expires TEXT, media_id TEXT, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL, client TEXT, location TEXT, year TEXT, description TEXT,
  photos TEXT DEFAULT '[]', comments TEXT DEFAULT '[]', public INTEGER DEFAULT 1, created INTEGER NOT NULL
);`);
// Columnas nuevas del catálogo
const cols = all('PRAGMA table_info(products)').map(c => c.name);
for (const [c, t] of [['description', 'TEXT'], ['category', 'TEXT'], ['photos', "TEXT DEFAULT '[]'"], ['video', 'TEXT'], ['certs', "TEXT DEFAULT '[]'"]])
  if (!cols.includes(c)) db.exec(`ALTER TABLE products ADD COLUMN ${c} ${t}`);

const TYPES = {
  'image/jpeg': ['image', 8e6, 'jpg'], 'image/png': ['image', 8e6, 'png'], 'image/webp': ['image', 8e6, 'webp'],
  'video/mp4': ['video', 60e6, 'mp4'], 'video/webm': ['video', 60e6, 'webm'], 'video/quicktime': ['video', 60e6, 'mov'],
  'application/pdf': ['pdf', 15e6, 'pdf']
};
const MAX_PHOTOS = 4, MAX_PROJECT_PHOTOS = 10;
const parse = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const url = id => id ? `/media/${id}` : null;
const ownMedia = (cid, id, kind) => !!(id && one('SELECT id FROM media WHERE id=? AND company_id=?' + (kind ? ' AND kind=?' : ''), ...(kind ? [String(id), cid, kind] : [String(id), cid])));

function productView(p, opts = {}) {
  const certIds = parse(p.certs);
  const certs = certIds.length ? all(`SELECT * FROM certificates WHERE company_id=? AND id IN (${certIds.map(() => '?').join(',')})`, p.company_id, ...certIds).map(certView) : [];
  const out = { ...p, photos: parse(p.photos).map(id => ({ id, url: url(id) })), video: p.video ? { id: p.video, url: url(p.video) } : null, certs, cert_ids: certIds };
  if (opts.hideCost) delete out.cost;
  return out;
}
const certView = c => ({ id: c.id, name: c.name, issuer: c.issuer, number: c.number, expires: c.expires, file: c.media_id ? { url: url(c.media_id), kind: one('SELECT kind FROM media WHERE id=?', c.media_id)?.kind } : null });
const projectView = p => ({ ...p, photos: parse(p.photos).map(id => ({ id, url: url(id) })), comments: parse(p.comments), public: !!p.public });

function register(app, { auth, active, bad, str, num, sellerOnly, publicCompany, isActive }) {
  // ---------- archivos ----------
  app.post('/api/media', auth, active, express.raw({ type: () => true, limit: '61mb' }), (req, res) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const t = TYPES[mime];
    if (!t) return bad(res, 'Formato no admitido. Usa JPG, PNG, WEBP, MP4, MOV, WEBM o PDF');
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return bad(res, 'Archivo vacío');
    if (buf.length > t[1]) return bad(res, `Archivo demasiado grande (máximo ${Math.round(t[1] / 1e6)} MB)`);
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(MEDIA_DIR, `${id}.${t[2]}`), buf);
    run('INSERT INTO media (id, company_id, kind, mime, size, name, created) VALUES (?,?,?,?,?,?,?)', id, req.company.id, t[0], mime, buf.length, str(decodeURIComponent(req.headers['x-filename'] || ''), 200), now());
    res.json({ id, url: url(id), kind: t[0] });
  });
  // Los archivos se sirven por un identificador imposible de adivinar (para clientes conectados y enlaces externos)
  app.get('/media/:id', (req, res) => {
    const m = one('SELECT * FROM media WHERE id=?', String(req.params.id).replace(/[^a-f0-9]/g, ''));
    if (!m) return res.status(404).end();
    const file = path.join(MEDIA_DIR, `${m.id}.${TYPES[m.mime][2]}`);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (m.kind === 'pdf') res.setHeader('Content-Disposition', `inline; filename="${(m.name || 'documento.pdf').replace(/[^\w.\- ]/g, '')}"`);
    res.type(m.mime).sendFile(file);
  });
  app.delete('/api/media/:id', auth, (req, res) => {
    const m = one('SELECT * FROM media WHERE id=? AND company_id=?', String(req.params.id), req.company.id);
    if (m) { try { fs.unlinkSync(path.join(MEDIA_DIR, `${m.id}.${TYPES[m.mime][2]}`)); } catch { } run('DELETE FROM media WHERE id=?', m.id); }
    res.json({ ok: true });
  });
  app.get('/api/media-usage', auth, (req, res) => res.json(one('SELECT count(*) n, coalesce(sum(size),0) bytes FROM media WHERE company_id=?', req.company.id)));

  // ---------- artículos (sustituye a las rutas básicas) ----------
  const productIn = (b, cid) => {
    const photos = (Array.isArray(b.photos) ? b.photos : []).map(String).filter(id => ownMedia(cid, id, 'image')).slice(0, MAX_PHOTOS);
    const video = b.video && ownMedia(cid, b.video, 'video') ? String(b.video) : null;
    const certs = (Array.isArray(b.certs) ? b.certs : []).map(Number).filter(id => one('SELECT id FROM certificates WHERE id=? AND company_id=?', id, cid));
    const fam = require('./familias').resolve(cid, b);
    return {
      family_error: fam.error, family_id: fam.family_id ?? null,
      sku: norm(b.sku), ean: String(b.ean ?? '').replace(/\D/g, '').slice(0, 14) || null, name: str(b.name, 160), unit: str(b.unit, 20) || 'ud', category: fam.category || '', description: str(b.description, 4000),
      list_price: num(b.list_price), min_price: num(b.min_price), cost: num(b.cost) ?? 0, stock: Math.floor(num(b.stock) ?? 0), lead_days: Math.floor(num(b.lead_days) ?? 3),
      photos: JSON.stringify(photos), video, certs: JSON.stringify(certs)
    };
  };
  const invalid = (p, cid, id = 0) => p.family_error ? p.family_error : !p.name ? 'Pon el nombre del artículo' : !p.sku ? 'Pon el código del fabricante: es el que identifica el artículo sin lugar a error' :
    all('SELECT sku FROM products WHERE company_id=? AND active=1 AND id<>?', cid, id).some(x => norm(x.sku) === p.sku) ? `Ya tienes otro artículo con el código ${p.sku}` :
    p.ean && !gtinOk(p.ean) ? 'El EAN no es válido (revisa las cifras: el dígito de control no cuadra)' : (p.list_price === null || p.min_price === null) ? 'Pon el precio de lista y el precio mínimo' : p.min_price > p.list_price ? 'El precio mínimo no puede ser mayor que el de lista' : null;
  app.get('/api/products', auth, sellerOnly, (req, res) => res.json(all('SELECT * FROM products WHERE company_id=? AND active=1 ORDER BY category, name', req.company.id).map(p => productView(p))));
  app.get('/api/products/:id', auth, sellerOnly, (req, res) => { const p = one('SELECT * FROM products WHERE id=? AND company_id=? AND active=1', +req.params.id, req.company.id); p ? res.json(productView(p)) : bad(res, 'No encontrado', 404); });
  app.post('/api/products', auth, active, sellerOnly, (req, res) => {
    const p = productIn(req.body || {}, req.company.id), e = invalid(p, req.company.id); if (e) return bad(res, e);
    const r = run(`INSERT INTO products (created, company_id, sku, ean, name, unit, category, family_id, description, list_price, min_price, cost, stock, lead_days, photos, video, certs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      now(), req.company.id, p.sku, p.ean, p.name, p.unit, p.category, p.family_id, p.description, p.list_price, p.min_price, p.cost, p.stock, p.lead_days, p.photos, p.video, p.certs);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });
  app.put('/api/products/:id', auth, active, sellerOnly, (req, res) => {
    const p = productIn(req.body || {}, req.company.id), e = invalid(p, req.company.id, +req.params.id); if (e) return bad(res, e);
    run(`UPDATE products SET sku=?, ean=?, name=?, unit=?, category=?, family_id=?, description=?, list_price=?, min_price=?, cost=?, stock=?, lead_days=?, photos=?, video=?, certs=? WHERE id=? AND company_id=?`,
      p.sku, p.ean, p.name, p.unit, p.category, p.family_id, p.description, p.list_price, p.min_price, p.cost, p.stock, p.lead_days, p.photos, p.video, p.certs, +req.params.id, req.company.id);
    res.json({ ok: true, id: +req.params.id });
  });

  // ---------- certificados ----------
  app.get('/api/certificates', auth, (req, res) => res.json(all('SELECT * FROM certificates WHERE company_id=? ORDER BY name', req.company.id).map(certView)));
  app.post('/api/certificates', auth, active, (req, res) => {
    const b = req.body || {}; const name = str(b.name, 160); if (!name) return bad(res, 'Pon el nombre del certificado');
    const media = b.media_id && ownMedia(req.company.id, b.media_id) ? String(b.media_id) : null;
    const vals = [name, str(b.issuer, 120), str(b.number, 80), /^\d{4}-\d{2}-\d{2}$/.test(b.expires || '') ? b.expires : null, media];
    if (b.id) run('UPDATE certificates SET name=?, issuer=?, number=?, expires=?, media_id=coalesce(?, media_id) WHERE id=? AND company_id=?', ...vals, +b.id, req.company.id);
    else run('INSERT INTO certificates (name, issuer, number, expires, media_id, company_id, created) VALUES (?,?,?,?,?,?,?)', ...vals, req.company.id, now());
    res.json({ ok: true });
  });
  app.delete('/api/certificates/:id', auth, active, (req, res) => { run('DELETE FROM certificates WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true }); });

  // ---------- proyectos ----------
  app.get('/api/projects', auth, (req, res) => res.json(all('SELECT * FROM projects WHERE company_id=? ORDER BY created DESC', req.company.id).map(projectView)));
  app.get('/api/projects/:id', auth, (req, res) => { const p = one('SELECT * FROM projects WHERE id=? AND company_id=?', +req.params.id, req.company.id); p ? res.json(projectView(p)) : bad(res, 'No encontrado', 404); });
  app.post('/api/projects', auth, active, (req, res) => {
    const b = req.body || {}, cid = req.company.id;
    const title = str(b.title, 160); if (!title) return bad(res, 'Pon el título del proyecto');
    const photos = (Array.isArray(b.photos) ? b.photos : []).map(String).filter(id => ownMedia(cid, id, 'image')).slice(0, MAX_PROJECT_PHOTOS);
    const comments = (Array.isArray(b.comments) ? b.comments : []).slice(0, 50).map(c => ({ author: str(c?.author, 120), text: str(c?.text, 1500), date: str(c?.date, 20) })).filter(c => c.text);
    const vals = [title, str(b.client, 160), str(b.location, 160), str(b.year, 10), str(b.description, 6000), JSON.stringify(photos), JSON.stringify(comments), b.public === false ? 0 : 1];
    let id = +b.id;
    if (id) run('UPDATE projects SET title=?, client=?, location=?, year=?, description=?, photos=?, comments=?, public=? WHERE id=? AND company_id=?', ...vals, id, cid);
    else id = Number(run('INSERT INTO projects (title, client, location, year, description, photos, comments, public, company_id, created) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, cid, now()).lastInsertRowid);
    res.json({ ok: true, id });
  });
  app.delete('/api/projects/:id', auth, active, (req, res) => { run('DELETE FROM projects WHERE id=? AND company_id=?', +req.params.id, req.company.id); res.json({ ok: true }); });

  // ---------- escaparate de un proveedor ----------
  function showcase(sellerId, { productIds } = {}) {
    const c = one('SELECT * FROM companies WHERE id=?', sellerId);
    const m = getPolicy(sellerId, 'venta').mostrar;
    let prods = m.catalogo || productIds ? all('SELECT * FROM products WHERE company_id=? AND active=1 ORDER BY category, name', sellerId) : [];
    if (productIds) prods = prods.filter(p => productIds.includes(p.id));
    return {
      company: publicCompany(c),
      products: prods.map(p => { const v = productView(p, { hideCost: !m.costes }); if (!m.stock) delete v.stock; if (!m.plazo) delete v.lead_days; delete v.min_price; return v; }),
      certificates: all('SELECT * FROM certificates WHERE company_id=? ORDER BY name', sellerId).map(certView),
      projects: all('SELECT * FROM projects WHERE company_id=? AND public=1 ORDER BY created DESC', sellerId).map(projectView)
    };
  }
  app.get('/api/showcase/:companyId', auth, (req, res) => {
    const sid = +req.params.companyId, me = req.company.id;
    const ok = sid === me || one(`SELECT id FROM connections WHERE seller_id=? AND buyer_id=? AND status='activa'`, sid, me);
    if (!ok) return bad(res, 'Solo puedes ver el escaparate de proveedores conectados', 403);
    res.json(showcase(sid));
  });
  // Para la página pública de una negociación de venta con una empresa sin agente
  app.get('/api/public/showcase/:token', (req, res) => {
    const n = one('SELECT * FROM ext_negotiations WHERE token=?', String(req.params.token).slice(0, 60));
    if (!n || n.side !== 'venta') return res.json(null);
    const s = showcase(n.company_id, { productIds: n.product_id ? [n.product_id] : [] });
    res.json(s);
  });
}

module.exports = { register };
