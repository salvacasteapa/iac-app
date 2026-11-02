// Catálogo con fotos y vídeo, certificados, proyectos y escaparate del proveedor.
// Usa las utilidades globales de app.js ($, h, eur, api, shell, toast, render, ME, route).

const MAX_PHOTOS = 4, MAX_PROJECT_PHOTOS = 10;

/** Sube un archivo. Las fotos se reducen a 1600 px en el navegador para ahorrar espacio. */
async function uploadFile(file) {
  let blob = file, type = file.type;
  if (/^image\/(jpeg|png|webp)$/.test(type)) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (k < 1 || file.size > 900000) {
        const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
        const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(bmp, 0, 0, cv.width, cv.height);
        blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85)); type = 'image/jpeg';
      }
    } catch { }
  }
  const r = await fetch('/api/media', { method: 'POST', headers: { 'content-type': type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || '') }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'No se ha podido subir el archivo');
  return j;
}
function pickFiles(accept, multiple) {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = !!multiple; i.onchange = () => res([...i.files]); i.click(); });
}
const cover = p => p.photos?.[0]?.url;
const noPhoto = `<div class="nophoto"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg></div>`;
const certBadge = c => `<span class="cert">${c.file ? `<a href="${h(c.file.url)}" target="_blank" rel="noopener">` : ''}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"/><path d="M8.2 13.9 7 23l5-3 5 3-1.2-9.1"/></svg>${h(c.name)}${c.file ? '</a>' : ''}</span>`;

// ---------------- catálogo (lista) ----------------
async function viewCatalogo() {
  await shell('catalogo', '<div id="c"></div>');
  const prods = await api('/products');
  const cats = [...new Set(prods.map(p => p.category || 'Sin categoría'))];
  $('#c').innerHTML = `<div class="head"><div><h1>Catálogo</h1><p class="lead">Cada artículo puede llevar hasta 4 fotos, un vídeo y sus certificados. El agente de ventas nunca baja del precio mínimo.</p></div>
    <div class="btns" style="margin:0"><a class="btn" href="#escaparate/${ME.company.id}">Ver mi escaparate</a><a class="btn p" href="#producto/nuevo">+ Nuevo artículo</a></div></div>
    ${prods.length ? cats.map(cat => `<h3 class="cat">${h(cat)}</h3><div class="pgrid">${prods.filter(p => (p.category || 'Sin categoría') === cat).map(p => `
      <a class="pcard" href="#producto/${p.id}"><div class="pimg">${cover(p) ? `<img src="${h(cover(p))}" alt="" loading="lazy">` : noPhoto}${p.video ? '<span class="vtag">▶ Vídeo</span>' : ''}<span class="ptag">${p.photos.length}/${MAX_PHOTOS} fotos</span></div>
        <div class="pbody"><b>${h(p.name)}</b><div class="muted">${p.sku ? h(p.sku) + ' · ' : ''}stock ${p.stock} · ${p.lead_days} días</div>
        <div class="prow"><span class="price">${eur(p.list_price)}<small> /${h(p.unit)}</small></span><span class="muted">mín. ${eur(p.min_price)}</span></div>
        ${p.certs.length ? `<div class="certs">${p.certs.slice(0, 3).map(c => `<span class="cert">${h(c.name)}</span>`).join('')}</div>` : ''}</div></a>`).join('')}</div>`).join('')
      : `<div class="card empty"><h2>Aún no tienes artículos</h2><p class="muted">Añade tu primer artículo con fotos, vídeo y certificados.</p><a class="btn p" href="#producto/nuevo">+ Nuevo artículo</a></div>`}`;
}

// ---------------- ficha de artículo ----------------
async function viewProducto(id) {
  await shell('catalogo', '<div id="c"></div>');
  const isNew = id === 'nuevo';
  const [p, certs] = await Promise.all([isNew ? Promise.resolve({ unit: 'ud', lead_days: 3, photos: [], video: null, cert_ids: [] }) : api('/products/' + id), api('/certificates')]);
  const st = { photos: p.photos.map(x => x.id), purls: Object.fromEntries(p.photos.map(x => [x.id, x.url])), video: p.video?.id || null, vurl: p.video?.url || null };
  const draw = () => {
    $('#photos').innerHTML = Array.from({ length: MAX_PHOTOS }, (_, i) => {
      const pid = st.photos[i];
      return pid ? `<div class="slot has"><img src="${h(st.purls[pid])}" alt="">${i === 0 ? '<span class="main">Principal</span>' : `<button type="button" class="mk" data-main="${i}">Hacer principal</button>`}<button type="button" class="rm" data-rm="${i}" aria-label="Quitar">×</button></div>`
        : `<button type="button" class="slot add" data-add="1"><span>+</span>Añadir foto</button>`;
    }).join('');
    $('#video').innerHTML = st.video ? `<div class="vbox"><video src="${h(st.vurl)}" controls preload="metadata"></video><button type="button" class="danger" id="vrm">Quitar vídeo</button></div>`
      : `<button type="button" class="slot add wide" id="vadd"><span>▶</span>Añadir vídeo (MP4 o MOV, máx. 60 MB)</button>`;
    document.querySelectorAll('[data-add]').forEach(b => b.onclick = addPhotos);
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.photos.splice(+b.dataset.rm, 1); draw(); });
    document.querySelectorAll('[data-main]').forEach(b => b.onclick = () => { const [x] = st.photos.splice(+b.dataset.main, 1); st.photos.unshift(x); draw(); });
    const va = $('#vadd'); if (va) va.onclick = addVideo;
    const vr = $('#vrm'); if (vr) vr.onclick = () => { st.video = null; draw(); };
  };
  const busy = (on, msg) => { $('#up').textContent = on ? msg : ''; document.querySelectorAll('#c button').forEach(b => b.disabled = on); };
  async function addPhotos() {
    const files = (await pickFiles('image/jpeg,image/png,image/webp', true)).slice(0, MAX_PHOTOS - st.photos.length);
    for (const [i, f] of files.entries()) { busy(true, `Subiendo foto ${i + 1} de ${files.length}…`); try { const r = await uploadFile(f); st.photos.push(r.id); st.purls[r.id] = r.url; } catch (e) { toast(e.message); } }
    busy(false); draw();
  }
  async function addVideo() {
    const [f] = await pickFiles('video/mp4,video/quicktime,video/webm'); if (!f) return;
    busy(true, 'Subiendo vídeo… puede tardar un poco'); try { const r = await uploadFile(f); st.video = r.id; st.vurl = r.url; } catch (e) { toast(e.message); } busy(false); draw();
  }
  $('#c').innerHTML = `<p><a href="#catalogo">← Catálogo</a></p><h1>${isNew ? 'Nuevo artículo' : h(p.name)}</h1><p class="lead">Lo que pongas aquí lo verán tus clientes conectados en tu escaparate (excepto el precio mínimo y, si no lo activas, el coste).</p>
   <form id="f"><div class="grid g2">
    <div><div class="card"><h2>Fotos</h2><p class="hint">Hasta ${MAX_PHOTOS}. La primera es la principal.</p><div class="slots" id="photos"></div></div>
      <div class="card"><h2>Vídeo</h2><div id="video"></div></div>
      <div class="card"><h2>Certificados de este artículo</h2>${certs.length ? certs.map(c => `<label class="chk"><input type="checkbox" name="cert" value="${c.id}" ${p.cert_ids.includes(c.id) ? 'checked' : ''}><span>${h(c.name)}${c.issuer ? `<small>${h(c.issuer)}${c.expires ? ' · válido hasta ' + h(c.expires) : ''}</small>` : ''}</span></label>`).join('') : '<p class="muted">Aún no tienes certificados. Súbelos en <a href="#certificados">Certificados</a> y luego márcalos aquí.</p>'}</div></div>
    <div><div class="card"><h2>Datos</h2>
      <label>Nombre</label><input name="name" value="${h(p.name)}" required>
      <div class="row"><div><label>Referencia</label><input name="sku" value="${h(p.sku)}"></div><div><label>Categoría</label><input name="category" value="${h(p.category)}" list="cats"></div></div>
      <label>Descripción</label><textarea name="description" rows="5" placeholder="Medidas, materiales, usos, ventajas…">${h(p.description)}</textarea>
      <h3>Precios y stock</h3>
      <div class="row"><div><label>Precio de lista (€)</label><input name="list_price" type="number" step="0.01" value="${p.list_price ?? ''}" required></div><div><label>Precio mínimo (€)</label><input name="min_price" type="number" step="0.01" value="${p.min_price ?? ''}" required></div><div><label>Coste (€)</label><input name="cost" type="number" step="0.01" value="${p.cost ?? ''}"></div></div>
      <div class="row"><div><label>Unidad</label><input name="unit" value="${h(p.unit)}"></div><div><label>Stock</label><input name="stock" type="number" value="${p.stock ?? 0}"></div><div><label>Plazo (días)</label><input name="lead_days" type="number" value="${p.lead_days ?? 3}"></div></div>
      <div class="btns"><button class="p">Guardar artículo</button>${isNew ? '' : '<button type="button" class="danger" id="del">Quitar del catálogo</button>'}<span class="muted" id="up"></span></div><div class="err" id="err"></div></div></div>
   </div></form>`;
  draw();
  $('#f').onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target);
    const body = Object.fromEntries([...fd].filter(([k]) => k !== 'cert')); body.certs = fd.getAll('cert').map(Number); body.photos = st.photos; body.video = st.video;
    try { const r = await api('/products' + (isNew ? '' : '/' + id), { method: isNew ? 'POST' : 'PUT', body }); toast('Artículo guardado'); location.hash = '#producto/' + r.id; if (!isNew) render(); } catch (x) { $('#err').textContent = x.message; }
  };
  const d = $('#del'); if (d) d.onclick = async () => { await api('/products/' + id, { method: 'DELETE' }); toast('Quitado'); location.hash = '#catalogo'; };
}

// ---------------- certificados ----------------
async function viewCertificados() {
  await shell('certificados', '<div id="c"></div>');
  const certs = await api('/certificates');
  let media = null;
  const today = new Date().toISOString().slice(0, 10);
  $('#c').innerHTML = `<h1>Certificados</h1><p class="lead">ISO, marcado CE, homologaciones, fichas técnicas o de seguridad. Tus clientes los verán en tu escaparate y en cada artículo al que los asignes.</p>
   <div class="grid"><div class="card"><h2>Añadir certificado</h2><form id="f">
     <label>Nombre</label><input name="name" placeholder="Ej.: ISO 9001:2015" required>
     <div class="row"><div><label>Emitido por</label><input name="issuer" placeholder="Ej.: AENOR"></div><div><label>Número</label><input name="number"></div></div>
     <label>Válido hasta</label><input name="expires" type="date">
     <label>Documento (PDF o imagen)</label><div class="btns" style="margin-top:4px"><button type="button" id="file">Elegir archivo</button><span class="muted" id="fname">Ninguno</span></div>
     <div class="btns"><button class="p">Guardar certificado</button></div><div class="err" id="err"></div></form></div>
   <div class="card"><h2>Tus certificados</h2>${certs.length ? `<div class="clist">${certs.map(c => `<div class="citem"><div class="cic">${c.file?.kind === 'image' ? `<img src="${h(c.file.url)}" alt="">` : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>'}</div>
     <div style="flex:1"><b>${h(c.name)}</b><div class="muted">${[c.issuer, c.number].filter(Boolean).map(h).join(' · ')}${c.expires ? ` · ${c.expires < today ? '<span class="pill no">Caducado</span>' : 'válido hasta ' + h(c.expires)}` : ''}</div></div>
     ${c.file ? `<a class="btn" href="${h(c.file.url)}" target="_blank" rel="noopener">Ver</a>` : ''}<button class="danger" data-del="${c.id}">Quitar</button></div>`).join('')}</div>` : '<p class="muted">Todavía no has subido ninguno.</p>'}</div></div>`;
  $('#file').onclick = async () => { const [f] = await pickFiles('application/pdf,image/jpeg,image/png,image/webp'); if (!f) return; $('#fname').textContent = 'Subiendo…'; try { media = (await uploadFile(f)).id; $('#fname').textContent = f.name; } catch (e) { $('#fname').textContent = e.message; } };
  $('#f').onsubmit = async e => { e.preventDefault(); try { await api('/certificates', { body: { ...Object.fromEntries(new FormData(e.target)), media_id: media } }); toast('Certificado guardado'); render(); } catch (x) { $('#err').textContent = x.message; } };
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api('/certificates/' + b.dataset.del, { method: 'DELETE' }); render(); });
}

// ---------------- proyectos ----------------
async function viewProyectos() {
  await shell('proyectos', '<div id="c"></div>');
  const ps = await api('/projects');
  $('#c').innerHTML = `<div class="head"><div><h1>Proyectos</h1><p class="lead">Enseña trabajos reales hechos con tus productos: fotos, descripción y comentarios de tus clientes.</p></div><div class="btns" style="margin:0"><a class="btn p" href="#proyecto/nuevo">+ Nuevo proyecto</a></div></div>
   ${ps.length ? `<div class="pgrid">${ps.map(p => `<a class="pcard" href="#proyecto/${p.id}"><div class="pimg">${p.photos[0] ? `<img src="${h(p.photos[0].url)}" alt="" loading="lazy">` : noPhoto}<span class="ptag">${p.photos.length} fotos</span>${p.public ? '' : '<span class="vtag">Oculto</span>'}</div>
     <div class="pbody"><b>${h(p.title)}</b><div class="muted">${[p.client, p.location, p.year].filter(Boolean).map(h).join(' · ')}</div>${p.comments.length ? `<div class="muted" style="margin-top:6px">💬 ${p.comments.length} comentario${p.comments.length > 1 ? 's' : ''}</div>` : ''}</div></a>`).join('')}</div>`
     : `<div class="card empty"><h2>Aún no tienes proyectos</h2><p class="muted">Un buen proyecto con fotos convence más que cualquier folleto.</p><a class="btn p" href="#proyecto/nuevo">+ Nuevo proyecto</a></div>`}`;
}
async function viewProyecto(id) {
  await shell('proyectos', '<div id="c"></div>');
  const isNew = id === 'nuevo';
  const p = isNew ? { photos: [], comments: [], public: true } : await api('/projects/' + id);
  const st = { photos: p.photos.map(x => x.id), purls: Object.fromEntries(p.photos.map(x => [x.id, x.url])), comments: p.comments.slice() };
  const draw = () => {
    $('#photos').innerHTML = st.photos.map((pid, i) => `<div class="slot has"><img src="${h(st.purls[pid])}" alt="">${i === 0 ? '<span class="main">Portada</span>' : `<button type="button" class="mk" data-main="${i}">Hacer portada</button>`}<button type="button" class="rm" data-rm="${i}">×</button></div>`).join('')
      + (st.photos.length < MAX_PROJECT_PHOTOS ? `<button type="button" class="slot add" id="padd"><span>+</span>Añadir fotos</button>` : '');
    $('#comments').innerHTML = st.comments.length ? st.comments.map((c, i) => `<div class="quote"><p>“${h(c.text)}”</p><div class="muted">— ${h(c.author || 'Cliente')}${c.date ? ' · ' + h(c.date) : ''} <button type="button" class="link danger" data-crm="${i}">quitar</button></div></div>`).join('') : '<p class="muted">Sin comentarios todavía.</p>';
    const pa = $('#padd'); if (pa) pa.onclick = add;
    document.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { st.photos.splice(+b.dataset.rm, 1); draw(); });
    document.querySelectorAll('[data-main]').forEach(b => b.onclick = () => { const [x] = st.photos.splice(+b.dataset.main, 1); st.photos.unshift(x); draw(); });
    document.querySelectorAll('[data-crm]').forEach(b => b.onclick = () => { st.comments.splice(+b.dataset.crm, 1); draw(); });
  };
  async function add() {
    const files = (await pickFiles('image/jpeg,image/png,image/webp', true)).slice(0, MAX_PROJECT_PHOTOS - st.photos.length);
    for (const [i, f] of files.entries()) { $('#up').textContent = `Subiendo foto ${i + 1} de ${files.length}…`; try { const r = await uploadFile(f); st.photos.push(r.id); st.purls[r.id] = r.url; } catch (e) { toast(e.message); } }
    $('#up').textContent = ''; draw();
  }
  $('#c').innerHTML = `<p><a href="#proyectos">← Proyectos</a></p><h1>${isNew ? 'Nuevo proyecto' : h(p.title)}</h1>
   <form id="f"><div class="grid g2">
    <div><div class="card"><h2>Fotos</h2><p class="hint">Hasta ${MAX_PROJECT_PHOTOS}. La primera es la portada.</p><div class="slots" id="photos"></div><div class="muted" id="up"></div></div>
     <div class="card"><h2>Comentarios</h2><p class="hint">Opiniones del cliente, notas del trabajo o resultados.</p><div id="comments"></div>
      <h3>Añadir comentario</h3><textarea id="ctext" rows="3" placeholder="Ej.: Entrega en plazo y montaje impecable."></textarea><div class="row"><div><label>Autor</label><input id="cauth" placeholder="Ej.: Ana López, Industrias Norte"></div><div><label>Fecha</label><input id="cdate" type="date"></div></div>
      <div class="btns"><button type="button" id="cadd">Añadir comentario</button></div></div></div>
    <div><div class="card"><h2>Datos</h2><label>Título</label><input name="title" value="${h(p.title)}" required>
      <div class="row"><div><label>Cliente</label><input name="client" value="${h(p.client)}"></div><div><label>Lugar</label><input name="location" value="${h(p.location)}"></div><div><label>Año</label><input name="year" value="${h(p.year)}"></div></div>
      <label>Descripción</label><textarea name="description" rows="7" placeholder="Qué se hizo, con qué productos, resultado…">${h(p.description)}</textarea>
      <label class="chk"><input type="checkbox" name="public" ${p.public ? 'checked' : ''}><span>Visible en mi escaparate<small>Si lo desmarcas, solo lo ves tú.</small></span></label>
      <div class="btns"><button class="p">Guardar proyecto</button>${isNew ? '' : '<button type="button" class="danger" id="del">Borrar</button>'}</div><div class="err" id="err"></div></div></div>
   </div></form>`;
  draw();
  $('#cadd').onclick = () => { const t = $('#ctext').value.trim(); if (!t) return; st.comments.push({ text: t, author: $('#cauth').value.trim(), date: $('#cdate').value }); $('#ctext').value = ''; $('#cauth').value = ''; draw(); toast('Comentario añadido: recuerda guardar'); };
  $('#f').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target); const body = { ...Object.fromEntries(fd), public: fd.get('public') === 'on', photos: st.photos, comments: st.comments, id: isNew ? undefined : id };
    try { const r = await api('/projects', { body }); toast('Proyecto guardado'); location.hash = '#proyecto/' + r.id; if (!isNew) render(); } catch (x) { $('#err').textContent = x.message; } };
  const d = $('#del'); if (d) d.onclick = async () => { await api('/projects/' + id, { method: 'DELETE' }); location.hash = '#proyectos'; };
}

// ---------------- escaparate del proveedor ----------------
function showcaseHTML(s, opts = {}) {
  const c = s.company;
  return `<div class="hero-sc" style="--sc:${h(c.color || '#1f4fd1')}"><div class="sc-logo">${c.logo ? `<img src="${h(c.logo)}" alt="">` : `<span>${h(c.name.slice(0, 2).toUpperCase())}</span>`}</div>
     <div><h1>${h(c.name)}</h1><div class="sc-meta">${[c.address, c.web, c.phone].filter(Boolean).map(h).join(' · ')}</div>${s.certificates.length ? `<div class="certs">${s.certificates.map(certBadge).join('')}</div>` : ''}</div></div>
   ${s.products.length ? `<h2 class="sec">Catálogo</h2><div class="pgrid">${s.products.map((p, i) => `<button type="button" class="pcard" data-p="${i}"><div class="pimg">${cover(p) ? `<img src="${h(cover(p))}" alt="" loading="lazy">` : noPhoto}${p.video ? '<span class="vtag">▶ Vídeo</span>' : ''}</div>
     <div class="pbody"><b>${h(p.name)}</b>${p.category ? `<div class="muted">${h(p.category)}</div>` : ''}<div class="prow"><span class="price">${eur(p.list_price)}<small> /${h(p.unit)}</small></span>${p.lead_days != null ? `<span class="muted">${p.lead_days} días</span>` : ''}</div></div></button>`).join('')}</div>` : ''}
   ${s.projects.length ? `<h2 class="sec">Proyectos</h2><div class="pgrid">${s.projects.map((p, i) => `<button type="button" class="pcard" data-j="${i}"><div class="pimg">${p.photos[0] ? `<img src="${h(p.photos[0].url)}" alt="" loading="lazy">` : noPhoto}</div><div class="pbody"><b>${h(p.title)}</b><div class="muted">${[p.client, p.location, p.year].filter(Boolean).map(h).join(' · ')}</div></div></button>`).join('')}</div>` : ''}
   ${!s.products.length && !s.projects.length ? '<div class="card empty"><p class="muted">Este proveedor aún no ha publicado su catálogo.</p></div>' : ''}`;
}
function openModal(html) {
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="mbox"><button type="button" class="mclose" aria-label="Cerrar">×</button>${html}</div>`;
  document.body.appendChild(m); document.body.style.overflow = 'hidden';
  const close = () => { m.remove(); document.body.style.overflow = ''; removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  m.onclick = e => { if (e.target === m || e.target.classList.contains('mclose')) close(); }; addEventListener('keydown', esc);
  m.querySelectorAll('.thumbs img').forEach(t => t.onclick = () => { m.querySelector('.bigimg').src = t.src; m.querySelectorAll('.thumbs img').forEach(x => x.classList.toggle('on', x === t)); });
  return m;
}
function productModal(p) {
  return openModal(`<div class="mgrid"><div>${p.photos.length ? `<img class="bigimg" src="${h(p.photos[0].url)}" alt="">${p.photos.length > 1 ? `<div class="thumbs">${p.photos.map((x, i) => `<img src="${h(x.url)}" class="${i ? '' : 'on'}" alt="">`).join('')}</div>` : ''}` : noPhoto}
    ${p.video ? `<video src="${h(p.video.url)}" controls preload="metadata" class="mvideo"></video>` : ''}</div>
    <div><h2 style="font-size:22px">${h(p.name)}</h2>${p.category ? `<div class="muted">${h(p.category)}${p.sku ? ' · Ref. ' + h(p.sku) : ''}</div>` : ''}
    <div class="price big">${eur(p.list_price)}<small> /${h(p.unit)}</small></div>
    <table>${p.stock != null ? `<tr><td>Stock</td><td class="n">${p.stock} ${h(p.unit)}</td></tr>` : ''}${p.lead_days != null ? `<tr><td>Plazo de entrega</td><td class="n">${p.lead_days} días</td></tr>` : ''}${p.cost != null ? `<tr><td>Coste (libro abierto)</td><td class="n">${eur(p.cost)}</td></tr>` : ''}</table>
    ${p.description ? `<p style="white-space:pre-wrap">${h(p.description)}</p>` : ''}
    ${p.certs.length ? `<h3>Certificados</h3><div class="certs">${p.certs.map(certBadge).join('')}</div>` : ''}</div></div>`);
}
function projectModal(p) {
  return openModal(`<h2 style="font-size:22px">${h(p.title)}</h2><div class="muted">${[p.client, p.location, p.year].filter(Boolean).map(h).join(' · ')}</div>
    ${p.photos.length ? `<img class="bigimg" src="${h(p.photos[0].url)}" alt="" style="margin-top:14px">${p.photos.length > 1 ? `<div class="thumbs">${p.photos.map((x, i) => `<img src="${h(x.url)}" class="${i ? '' : 'on'}" alt="">`).join('')}</div>` : ''}` : ''}
    ${p.description ? `<p style="white-space:pre-wrap">${h(p.description)}</p>` : ''}
    ${p.comments.length ? `<h3>Comentarios</h3>${p.comments.map(c => `<div class="quote"><p>“${h(c.text)}”</p><div class="muted">— ${h(c.author || 'Cliente')}${c.date ? ' · ' + h(c.date) : ''}</div></div>`).join('')}` : ''}`);
}
function bindShowcase(root, s) {
  root.querySelectorAll('[data-p]').forEach(b => b.onclick = () => productModal(s.products[+b.dataset.p]));
  root.querySelectorAll('[data-j]').forEach(b => b.onclick = () => projectModal(s.projects[+b.dataset.j]));
}
async function viewEscaparate(companyId) {
  await shell(companyId === ME.company.id ? 'catalogo' : 'conexiones', '<div id="c"></div>');
  const s = await api('/showcase/' + companyId);
  $('#c').innerHTML = (companyId === ME.company.id ? '<div class="banner info">Así ven tu escaparate tus clientes conectados. <a href="#catalogo">Volver al catálogo</a></div>' : '<p><a href="#comprar">← Nueva compra</a></p>') + showcaseHTML(s);
  bindShowcase($('#c'), s);
}
