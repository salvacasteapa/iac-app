// IAC · interfaz de cliente (sin dependencias)
const $ = s => document.querySelector(s);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => Number(n || 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const fdate = t => t ? new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
let ME = null;

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/login')) { ME = null; location.hash = '#login'; throw new Error(j.error || 'Sesión caducada'); }
  if (!r.ok) throw new Error(j.error || 'Error');
  return j;
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 2800); }
const route = () => { const [r, q] = (location.hash.slice(1) || 'inicio').split('?'); return { r, parts: r.split('/'), q: new URLSearchParams(q || '') }; };
const isSeller = () => ['vendedor', 'ambos'].includes(ME.company.role);
const isBuyer = () => ['comprador', 'ambos'].includes(ME.company.role);
const mono = (name, color, cls = 'mono-s') => `<span class="${cls}" style="background:${h(color || '#1f4fd1')}">${h((name || '?').trim().slice(0, 2).toUpperCase())}</span>`;
const clogo = c => c.logo ? `<img class="logo-s" src="${h(c.logo)}" alt="">` : mono(c.name, c.color);
const STATUS = { cerrado: ['Cerrado', 'ok'], pendiente: ['Pendiente de aprobación', 'wait'], sin_acuerdo: ['Sin acuerdo', 'no'], rechazado: ['Rechazado', 'no'], descartada: ['No elegida', 'mute'],
  activa: ['Activa', 'ok'], pausada: ['Pausada', 'wait'], rechazada: ['Rechazada', 'no'], abierta: ['Abierta', 'wait'], cerrada: ['Cerrada', 'ok'], sin_proveedor: ['Sin proveedor', 'no'], trial: ['Prueba', 'wait'], active: ['Activa', 'ok'], cancelado: ['Cancelada', 'no'], impagado: ['Impagada', 'no'] };
const pill = s => { const [t, c] = STATUS[s] || [s, 'mute']; return `<span class="pill ${c}">${h(t)}</span>`; };

function applyBrand() { document.documentElement.style.setProperty('--brand', ME?.company?.color || '#1f4fd1'); document.title = ME ? `${ME.company.name} · Compras y ventas` : 'IAC'; }

// ---------------- autenticación ----------------
async function viewAuth(mode) {
  document.documentElement.style.setProperty('--brand', '#1f4fd1');
  const qs = new URLSearchParams(location.search);
  const invite = qs.get('invita') || route().q.get('invita');
  const lado = qs.get('lado') || route().q.get('lado') || '';
  let inv = null; if (invite) inv = await api('/invite/' + encodeURIComponent(invite) + (lado ? '?lado=' + encodeURIComponent(lado) : '')).catch(() => null);
  const invBuyer = inv?.kind === 'comprador';
  if (inv) document.documentElement.style.setProperty('--brand', inv.color || '#1f4fd1');
  const side = inv
    ? `<div class="inv">${inv.logo ? `<img src="${h(inv.logo)}" alt="">` : h(inv.name)}</div>
       ${invBuyer ? `<div><h2>${h(inv.name)} te invita a <em>ser su proveedor.</em></h2><p>Su asistente de compras te enviará sus pedidos recurrentes y tu asistente de ventas negociará dentro de tus reglas. ${h(inv.name)} puede pagar tu conexión, así que puedes venderle sin contratar el plan Ventas.</p></div>`
       : `<div><h2>${h(inv.name)} te invita a <em>conectar tus compras.</em></h2><p>Recibirás sus ofertas de reposición dentro de los límites que tú marques. Tú decides qué datos compartes y puedes pausar la conexión cuando quieras.</p>${inv.promo ? `<ul><li>Plan Compras gratis durante ${inv.promo} meses, por invitación de ${h(inv.name)}</li></ul>` : ''}</div>`}`
    : `<div><h2>Tus pedidos de siempre, <em>negociados solos.</em></h2><p>Tus agentes de compras y ventas cierran los pedidos recurrentes dentro de tus reglas y te consultan solo cuando algo se sale de ellas.</p>
       <ul><li>Con tu logo y tus colores</li><li>Tú decides qué se comparte</li><li>14 días de prueba gratis</li></ul></div>`;
  $('#app').innerHTML = `<div class="auth"><div class="side"><a class="lg" href="/"><span class="mk"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg></span>IAC</a>${side}<span style="color:#8a96b4;font-size:13px">Compras y ventas recurrentes entre empresas</span></div>
    <div class="form"><div class="box">
    <h1>${mode === 'login' ? 'Bienvenido de nuevo' : 'Crea el espacio de tu empresa'}</h1><p class="muted">${mode === 'login' ? 'Entra para ver la actividad de tus agentes.' : 'En dos minutos tendrás tus agentes listos.'}</p>
    <div class="seg"><button data-m="login" class="${mode === 'login' ? 'on' : ''}">Entrar</button><button data-m="registro" class="${mode === 'registro' ? 'on' : ''}">Crear cuenta</button></div>
    <form id="f">
      ${mode === 'registro' ? `<label>Nombre de la empresa</label><input name="company" required>
        <label>Tu empresa…</label><select name="role"><option value="comprador" ${inv && !invBuyer ? 'selected' : ''}>Compra a proveedores</option><option value="vendedor" ${!inv || invBuyer ? 'selected' : ''}>Vende a clientes</option><option value="ambos">Compra y vende</option></select>
        <label>Tu nombre</label><input name="name" required>` : ''}
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Contraseña</label><input name="password" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
      <div class="btns"><button class="p big">${mode === 'login' ? 'Entrar' : 'Crear cuenta y empezar gratis'}</button></div>
      <div class="err" id="err"></div>
    </form></div></div></div>`;
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { location.hash = '#' + b.dataset.m + (invite ? '?invita=' + encodeURIComponent(invite) + (lado ? '&lado=' + encodeURIComponent(lado) : '') : ''); });
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target)); if (invite) { body.invite = invite; body.lado = lado; }
    try { await api(mode === 'login' ? '/login' : '/signup', { body }); ME = null; location.hash = '#inicio'; render(); }
    catch (x) { $('#err').textContent = x.message; }
  };
}

// ---------------- esqueleto ----------------
async function shell(active, content) {
  const c = ME.company;
  let stats = {}; try { stats = await api('/stats'); } catch { }
  const links = [
    ['inicio', 'Inicio', stats.pendientes],
    ['operaciones', 'Operaciones', 0],
    ['agenda', 'Agenda', stats.agenda],
    ['avisos', 'Avisos y seguimiento', stats.avisos],
    ['externos', 'Empresas sin agente', stats.externos],
    isBuyer() && ['comprar', 'Nueva compra', 0],
    isSeller() && ['catalogo', 'Catálogo', 0],
    isSeller() && ['especiales', 'Autorizaciones especiales', 0],
    isSeller() && ['certificados', 'Certificados', 0],
    isSeller() && ['proyectos', 'Proyectos', 0],
    ['codigos', 'Códigos de artículo', stats.codigos],
    ['conexiones', isSeller() && !isBuyer() ? 'Clientes conectados' : 'Conexiones', stats.solicitudes],
    ['politicas', 'Reglas de los agentes', 0],
    ['empresa', 'Mi empresa', 0],
    ['membresia', 'Membresía', 0],
    ME.user.is_super && ['admin', 'Administración IAC', 0]
  ].filter(Boolean);
  $('#app').innerHTML = `<div class="shell"><aside>
    <div class="brand">${c.logo ? `<img src="${h(c.logo)}" alt="${h(c.name)}">` : `${mono(c.name, c.color, 'mono')}<div class="bn">${h(c.name)}</div>`}</div>
    ${links.map(([k, t, n]) => `<a class="nav ${active === k ? 'on' : ''}" href="#${k}">${t}${n ? `<span class="badge">${n}</span>` : ''}</a>`).join('')}
    <div class="sp"></div>
    <div class="me"><b>${h(ME.user.name || ME.user.email)}</b>${h(c.name)}<br><a href="#" id="logout">Cerrar sesión</a></div>
  </aside><main id="main">${!c.active && !ME.user.is_super && active !== 'membresia' ? `<div class="banner bad">Tu membresía no está activa. <a href="#membresia">Actívala aquí</a> para que tus agentes sigan trabajando.</div>` : ''}${content}</main></div>`;
  if (typeof startAlerts === 'function') startAlerts();
  $('#logout').onclick = async e => { e.preventDefault(); await api('/logout', { body: {} }); ME = null; location.href = '/'; };
  return stats;
}

// ---------------- inicio ----------------
async function viewInicio() {
  const stats = await shell('inicio', '<div id="c"></div>');
  const deals = await api('/deals');
  const pend = deals.filter(d => d.status === 'pendiente' && ((d.as === 'comprador' && !d.buyer_ok) || (d.as === 'vendedor' && !d.seller_ok)));
  const c = ME.company;
  const kp = [];
  if (isBuyer()) kp.push([stats.compras.n, 'Pedidos de compra cerrados'], [eur(stats.compras.t), 'Volumen comprado'], [eur(stats.ahorro), 'Ahorro frente a precio de lista']);
  if (isSeller()) kp.push([stats.ventas.n, 'Pedidos de venta cerrados'], [eur(stats.ventas.t), 'Volumen vendido'], [eur(stats.margen), 'Margen sobre coste']);
  kp.push([stats.conexiones, 'Conexiones activas'], [stats.automaticos, 'Cerrados sin intervención']);
  $('#c').innerHTML = `<h1>Hola, ${h(ME.user.name || '')}</h1><p class="lead">Resumen de la actividad de los agentes de ${h(c.name)}.</p>
    ${c.plan_status === 'trial' ? `<div class="banner info">Estás en periodo de prueba hasta el ${fdate(c.plan_until)}. <a href="#membresia">Ver planes</a></div>` : ''}
    <div class="kpis">${kp.map(([v, l]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
    <div class="card"><h2>Esperan tu decisión</h2><p class="hint">Acuerdos que tus agentes no pueden cerrar solos porque salen de tus reglas.</p>
    ${pend.length ? dealTable(pend) : '<p class="muted">Nada pendiente. Tus agentes están trabajando dentro de tus reglas.</p>'}</div>
    ${stats.solicitudes ? `<div class="banner warn">Tienes ${stats.solicitudes} solicitud(es) de conexión de proveedores. <a href="#conexiones">Revisar</a></div>` : ''}
    ${getStarted()}`;
  bindRows();
}
function getStarted() {
  const steps = [];
  if (!ME.company.logo) steps.push(['empresa', 'Sube tu logo y tus datos para que tus pedidos lleven tu membrete']);
  steps.push(['politicas', 'Revisa las reglas de tus agentes: qué enseñan, cómo cierran y qué priorizan']);
  if (isSeller()) steps.push(['catalogo', 'Carga tu catálogo con precios, mínimos y stock'], ['conexiones', 'Invita a tus clientes a conectarse']);
  if (isBuyer()) steps.push(['comprar', 'Lanza tu primera necesidad de compra']);
  return `<div class="card"><h2>Primeros pasos</h2><ol>${steps.map(([k, t]) => `<li><a href="#${k}">${t}</a></li>`).join('')}</ol></div>`;
}
function dealTable(deals) {
  return `<table><tr><th>Fecha</th><th>${isBuyer() && isSeller() ? 'Contraparte' : isBuyer() ? 'Proveedor' : 'Cliente'}</th><th>Producto</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Total</th><th>Estado</th></tr>
  ${deals.map(d => { const o = d.as === 'comprador' ? d.seller : d.buyer; return `<tr class="click" data-href="#operacion/${d.id}"><td>${fdate(d.created)}</td><td>${clogo(o)}${h(o.name)}</td><td>${h(d.product?.name || d.need?.product_name)}</td><td class="n">${d.qty ?? '—'}</td><td class="n">${d.price != null ? eur(d.price) : '—'}</td><td class="n">${d.total != null ? eur(d.total) : '—'}</td><td>${pill(d.status)}</td></tr>`; }).join('')}</table>`;
}
const bindRows = () => document.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = () => location.hash = tr.dataset.href);

// ---------------- operaciones ----------------
async function viewOperaciones() {
  await shell('operaciones', '<div id="c"></div>');
  const deals = await api('/deals');
  $('#c').innerHTML = `<h1>Operaciones</h1><p class="lead">Todas las negociaciones de tus agentes, cerradas o pendientes.</p>
   <div class="card">${deals.length ? dealTable(deals) : '<p class="muted">Todavía no hay operaciones.</p>'}</div>`;
  bindRows();
}
async function viewOperacion(id) {
  await shell('operaciones', '<div id="c"></div>');
  const d = await api('/deals/' + id);
  const meBuyer = d.as === 'comprador';
  const names = { buy: 'Agente de compras · ' + d.buyer.name, sell: 'Agente de ventas · ' + d.seller.name, sys: 'Registro' };
  const mustApprove = d.status === 'pendiente' && (meBuyer ? !d.buyer_ok : !d.seller_ok);
  const n = d.need || {};
  $('#c').innerHTML = `<p><a href="#operaciones">← Operaciones</a></p>
    <h1>${h(d.product?.name || n.product_name)} · ${clogo(meBuyer ? d.seller : d.buyer)}${h((meBuyer ? d.seller : d.buyer).name)}</h1>
    <p class="lead">${pill(d.status)} ${d.motivo ? h(d.motivo) : ''}</p>
    <div class="grid" style="grid-template-columns:minmax(280px,1fr) minmax(320px,1.5fr)">
      <div>
        <div class="card"><h2>Acuerdo</h2><table>
          <tr><td>Código del fabricante</td><td class="n"><code class="k">${h(d.mfr_code || d.product?.sku || '—')}</code></td></tr>
          <tr><td>Código del cliente</td><td class="n">${d.buyer_code ? `<code class="k">${h(d.buyer_code)}</code>` : '—'}</td></tr>
          <tr><td>Artículo</td><td class="n">${d.verified ? '<span class="pill ok">✔ Verificado por doble código</span>' : '<span class="pill mute">Por nombre, sin doble código</span>'}</td></tr>
          ${d.special ? `<tr><td>Condiciones</td><td class="n"><span class="pill wait">Autorización especial nº ${d.special.id}</span><div class="muted" style="font-size:12.5px;margin-top:4px">${h(d.special.by)}</div></td></tr>` : ''}
          <tr><td>Cantidad</td><td class="n">${d.qty ?? '—'} ${h(d.product?.unit || '')}${d.partial ? ' (parcial)' : ''}</td></tr>
          <tr><td>Precio unitario</td><td class="n">${d.price != null ? eur(d.price) : '—'}</td></tr>
          <tr><td>Precio de lista</td><td class="n">${d.list_price != null ? eur(d.list_price) : '—'}</td></tr>
          <tr><td>Total</td><td class="n"><b>${d.total != null ? eur(d.total) : '—'}</b></td></tr>
          <tr><td>Plazo de entrega</td><td class="n">${d.lead_days != null ? d.lead_days + ' días' : '—'}</td></tr>
          ${d.need_buyer_ok ? `<tr><td>Aprobación compras</td><td class="n">${d.buyer_ok ? pill('cerrado').replace('Cerrado', 'Aprobado') : pill('pendiente').replace('Pendiente de aprobación', 'Pendiente')}</td></tr>` : ''}
          ${d.need_seller_ok ? `<tr><td>Aprobación ventas</td><td class="n">${d.seller_ok ? pill('cerrado').replace('Cerrado', 'Aprobado') : pill('pendiente').replace('Pendiente de aprobación', 'Pendiente')}</td></tr>` : ''}
        </table>
        ${mustApprove ? `<div class="btns"><button class="ok" id="ap">Aprobar</button><button class="danger" id="re">Rechazar</button></div>` : ''}
        ${d.status === 'cerrado' ? `<div class="btns"><a class="btn p" href="/pedido/${d.id}" target="_blank">Ver pedido con membrete</a></div>` : ''}
        </div>
        ${!meBuyer ? `<div class="card"><h2>Datos que comparte el cliente</h2><table>
          <tr><td>Consumo mensual</td><td class="n">${n.consumption != null ? n.consumption : '<span class="pill mute">No compartido</span>'}</td></tr>
          <tr><td>Previsión próximo mes</td><td class="n">${n.forecast != null ? n.forecast : '<span class="pill mute">No compartido</span>'}</td></tr>
          <tr><td>Stock del cliente</td><td class="n">${n.buyer_stock != null ? n.buyer_stock : '<span class="pill mute">No compartido</span>'}</td></tr></table></div>` : ''}
      </div>
      <div class="card"><h2>Conversación entre agentes</h2><div class="log">${d.log.map(m => `<div class="msg ${m.who}"><div class="who">${h(names[m.who])}</div>${h(m.text)}</div>`).join('')}</div></div>
    </div>`;
  if (mustApprove) {
    $('#ap').onclick = async () => { try { await api(`/deals/${id}/aprobar`, { body: {} }); toast('Aprobado'); render(); } catch (e) { toast(e.message); } };
    $('#re').onclick = async () => { try { await api(`/deals/${id}/rechazar`, { body: {} }); toast('Rechazado'); render(); } catch (e) { toast(e.message); } };
  }
}

// ---------------- comprar ----------------
async function viewComprar() {
  await shell('comprar', '<div id="c"></div>');
  const [cat, needs, links] = await Promise.all([api('/catalog'), api('/needs'), api('/codes')]);
  const names = [...new Set(cat.map(p => p.name))];
  const mine = {}; links.filter(l => l.ok && l.as === 'comprador').forEach(l => { (mine[l.buyer_code] ||= []).push(l); });
  $('#c').innerHTML = `<h1>Nueva compra</h1><p class="lead">Dile a tu agente qué necesitas. Negociará con todos tus proveedores conectados y elegirá la mejor oferta según tus prioridades.</p>
   <div class="grid"><div class="card"><form id="f">
     <div class="row"><div><label>Tu código de artículo</label><input name="buyer_code" id="bcode" list="bcodes" placeholder="${Object.keys(mine).length ? 'Elige tu código' : 'Sin códigos vinculados'}" autocomplete="off"><datalist id="bcodes">${Object.entries(mine).map(([k, v]) => `<option value="${h(k)}">${h(v[0].buyer_desc || v[0].product.name)}</option>`).join('')}</datalist></div>
       <div><label>Producto</label><input name="product_name" id="pname" list="prods" required placeholder="${names.length ? 'Elige o escribe' : 'Aún no tienes proveedores conectados'}"></div></div>
     <div id="codeinfo"></div><datalist id="prods">${names.map(n => `<option value="${h(n)}">`).join('')}</datalist>
     <div class="row"><div><label>Cantidad</label><input name="qty" type="number" min="1" required></div><div><label>Plazo máximo (días)</label><input name="max_days" type="number" min="1" required value="5"></div></div>
     <div class="row"><div><label>Precio objetivo (€/ud)</label><input name="target_price" type="number" step="0.01" min="0" required></div><div><label>Precio máximo (€/ud)</label><input name="max_price" type="number" step="0.01" min="0" required></div></div>
     <h3>Datos de consumo <span class="muted">(solo se comparten si lo permites en tus reglas)</span></h3>
     <div class="row"><div><label>Consumo mensual</label><input name="consumption" type="number" min="0"></div><div><label>Previsión próximo mes</label><input name="forecast" type="number" min="0"></div><div><label>Tu stock actual</label><input name="buyer_stock" type="number" min="0"></div></div>
     <div class="btns"><button class="p">Lanzar negociación</button></div><div class="err" id="err"></div></form></div>
     <div class="card"><h2>Lo que ofrecen tus proveedores</h2><p class="hint">Solo ves lo que cada proveedor decide enseñar.</p>
     ${cat.length ? `<div class="mini">${cat.map(p => `<a class="mitem" href="#escaparate/${p.seller_id}"><div class="mimg">${p.photo ? `<img src="${h(p.photo)}" alt="" loading="lazy">` : ''}</div><div style="flex:1;min-width:0"><b>${h(p.name)}</b><div class="muted">${p.sku ? h(p.sku) + (p.my_code ? ' = ' + h(p.my_code) + ' ✔' : '') + ' · ' : ''}${h(p.seller)}${p.lead_days != null ? ' · ' + p.lead_days + ' d' : ''}${p.stock != null ? ' · stock ' + p.stock : ''}${p.cost != null ? ' · coste ' + eur(p.cost) : ''}</div></div><span class="price">${eur(p.list_price)}</span></a>`).join('')}</div>
     <p class="hint" style="margin-top:10px">Pulsa un artículo para ver el escaparate del proveedor: fotos, vídeo, certificados y proyectos.</p>` : '<p class="muted">Cuando un proveedor te pida conexión y la autorices, verás aquí su catálogo.</p>'}</div></div>
   <div class="card"><h2>Necesidades recientes</h2>${needs.length ? `<table><tr><th>Fecha</th><th>Producto</th><th class="n">Cant.</th><th class="n">Objetivo / máx.</th><th>Estado</th></tr>${needs.map(n => `<tr><td>${fdate(n.created)}</td><td>${h(n.product_name)}</td><td class="n">${n.qty}</td><td class="n">${eur(n.target_price)} / ${eur(n.max_price)}</td><td>${pill(n.status)}</td></tr>`).join('')}</table>` : '<p class="muted">Aún no has lanzado ninguna.</p>'}</div>`;
  const codeInfo = () => {
    const v = $('#bcode').value.replace(/\s+/g, '').toUpperCase(), ls = mine[v];
    $('#pname').required = !v; $('#pname').readOnly = !!ls;
    if (ls) $('#pname').value = ls[0].buyer_desc || ls[0].product.name;
    $('#codeinfo').innerHTML = !v ? `<p class="hint" style="margin-top:8px">Con tu código, el agente solo negocia artículos con doble código confirmado. Sin código, busca por nombre.</p>`
      : ls ? `<div class="banner ok" style="margin-top:10px">✔ Verificado con ${ls.length} proveedor${ls.length > 1 ? 'es' : ''}: ${ls.map(l => `${h(l.seller.name)} <code class="k">${h(l.mfr_code)}</code>`).join(', ')}</div>`
      : `<div class="banner bad" style="margin-top:10px">El código ${h(v)} no está vinculado y confirmado. <a href="#codigos">Vincúlalo aquí</a>.</div>`;
  };
  $('#bcode').oninput = codeInfo; codeInfo();
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const r = await api('/needs', { body: Object.fromEntries(new FormData(e.target)) });
      if (r.status === 'sin_proveedor') { $('#err').textContent = 'Ningún proveedor conectado ofrece ese producto.'; btn.disabled = false; return; }
      const deals = await api('/deals'); const d = deals.find(x => x.chosen && x.need?.id === r.id) || deals.find(x => x.need?.id === r.id);
      toast(r.status === 'cerrado' ? 'Pedido cerrado' : r.status === 'pendiente' ? 'Acuerdo pendiente de tu aprobación' : 'No ha habido acuerdo');
      location.hash = d ? '#operacion/' + d.id : '#operaciones';
    } catch (x) { $('#err').textContent = x.message; btn.disabled = false; }
  };
}

// catálogo, fichas, certificados, proyectos y escaparate: ver catalog.js

// ---------------- conexiones ----------------
async function viewConexiones() {
  await shell('conexiones', '<div id="c"></div>');
  ME = await api('/me');
  const conns = await api('/connections');
  const asSeller = conns.filter(c => c.as === 'vendedor'), asBuyer = conns.filter(c => c.as === 'comprador');
  const link = `${location.origin}/app?invita=${encodeURIComponent(ME.company.code)}#registro`;
  const linkProv = `${location.origin}/app?invita=${encodeURIComponent(ME.company.code)}&lado=compra#registro`;
  const SH = { consumo: 'consumo', prevision: 'previsión', stock: 'stock' };
  const U = ME.usage, P = U.promo, CX = ME.conexion.price;
  if (route().q.get('ok')) toast('Pago recibido. La conexión quedará pagada en unos segundos.');
  const usage = `<div class="kpis" style="margin-bottom:16px"><div class="kpi"><div class="v">${U.conexiones}${U.max ? ` <small class="muted">de ${U.max}</small>` : ''}</div><div class="l">Conexiones${U.max ? ' de tu plan' : ' (sin tope)'}</div></div>
    ${P ? `<div class="kpi"><div class="v">${P.used} <small class="muted">de ${P.max}</small></div><div class="l">Clientes invitados con ${P.months} meses gratis</div></div>` : ''}</div>
    ${U.max && U.conexiones >= U.max ? `<div class="note warn">Has llegado al máximo de ${U.max} conexiones. <a href="#membresia">Pasa al plan Compras + Ventas</a>, que no tiene tope de conexiones.</div>` : ''}`;
  const sellerBtns = c => c.status === 'activa' ? `<button data-k="${c.id}" data-s="pausada">Pausar</button>`
    : c.status === 'pendiente' && c.requested_by === 'comprador' ? `<button class="ok" data-k="${c.id}" data-s="activa">Aceptar</button> <button data-k="${c.id}" data-s="rechazada">Rechazar</button>` : '';
  const pay = c => c.status !== 'activa' ? '' : c.sponsor_until ? `<span class="pill ok">Pagas su conexión hasta el ${fdate(c.sponsor_until)}</span> ${ME.user.is_admin ? `<button data-unpay="${c.id}">Dejar de pagar</button>` : ''}`
    : !c.seller_plan ? `<span class="pill wait">Sin plan Ventas</span> ${ME.user.is_admin ? `<button class="p" data-pay="${c.id}">Pagar su conexión · ${CX} €/mes</button>` : ''}` : '';
  const buyerBtns = c => c.status === 'pendiente' && c.requested_by === 'comprador' ? '<span class="muted">Esperando al proveedor</span>'
    : `${c.status !== 'activa' ? `<button class="ok" data-k="${c.id}" data-s="activa">Autorizar</button> ` : ''}${c.status === 'pendiente' ? `<button data-k="${c.id}" data-s="rechazada">Rechazar</button>` : ''}${c.status === 'activa' ? `<a class="btn" href="#escaparate/${c.other.id}">Ver escaparate</a> <button data-k="${c.id}" data-s="pausada">Pausar</button>` : ''}`;
  $('#c').innerHTML = `<h1>Conexiones</h1><p class="lead">Una conexión es el permiso de un cliente para que el agente de ventas de su proveedor negocie con su agente de compras.</p>
  ${usage}
  ${isSeller() ? `<div class="grid"><div class="card"><h2>Invitar a un cliente</h2><p class="hint">Envía este enlace a tu cliente. Al crear su cuenta, recibirá tu solicitud de conexión.${P && ME.company.active && P.used < P.max ? ` <b>Promoción:</b> tu cliente tendrá el plan Compras gratis durante ${P.months} meses (te quedan ${P.max - P.used}).` : ''}</p>
      <input readonly value="${h(link)}" id="lnk"><div class="btns"><button data-copy="lnk">Copiar enlace</button></div>
      <h3>¿Tu cliente ya usa IAC?</h3><form id="fc"><input type="hidden" name="as" value="vendedor"><label>Código de empresa del cliente</label><input name="code" placeholder="Ej.: NORTE-1A2B" required><label>Mensaje para el jefe de compras</label><textarea name="message">Con la conexión, nuestro agente te enviará ofertas de reposición dentro de tus límites. Puedes pausarla cuando quieras.</textarea>
      <div class="btns"><button class="p">Pedir conexión</button></div><div class="err"></div></form></div>
    <div class="card"><h2>Mis clientes</h2>${asSeller.length ? `<table><tr><th>Cliente</th><th>Comparte</th><th>Estado</th><th></th></tr>${asSeller.map(c => `<tr><td>${clogo(c.other)}${h(c.other.name)}${c.sponsor_until ? '<br><small class="muted">Este cliente paga tu conexión</small>' : ''}${c.status === 'pendiente' && c.requested_by === 'comprador' ? `<br><small class="muted">${h(c.message || 'Te pide conexión')}</small>` : ''}</td><td class="muted">${c.shared ? Object.entries(c.shared).filter(([, v]) => v).map(([k]) => SH[k]).join(', ') || 'nada' : '—'}</td><td>${pill(c.status)}</td><td style="white-space:nowrap">${sellerBtns(c)}</td></tr>`).join('')}</table>` : '<p class="muted">Aún no tienes clientes conectados.</p>'}</div></div>` : ''}
  ${isBuyer() ? `<div class="grid"><div class="card"><h2>Invitar a un proveedor</h2><p class="hint">Tu código de empresa es <code class="k">${h(ME.company.code)}</code>. Envía este enlace a un proveedor. Si no tiene plan Ventas, puedes pagar tú su conexión por ${CX} € al mes y venderá solo contigo.</p>
      <input readonly value="${h(linkProv)}" id="lnkp"><div class="btns"><button data-copy="lnkp">Copiar enlace</button></div>
      <h3>¿Tu proveedor ya usa IAC?</h3><form id="fp"><input type="hidden" name="as" value="comprador"><label>Código de empresa del proveedor</label><input name="code" placeholder="Ej.: TORNI-9F3C" required><label>Mensaje para el proveedor</label><textarea name="message">Queremos que tu asistente de ventas negocie nuestros pedidos recurrentes dentro de nuestras reglas.</textarea>
      <div class="btns"><button class="p">Pedir conexión</button></div><div class="err"></div></form></div>
    <div class="card"><h2>Mis proveedores</h2>
    ${asBuyer.length ? `<table><tr><th>Proveedor</th><th>Mensaje</th><th>Estado</th><th></th></tr>${asBuyer.map(c => `<tr><td>${clogo(c.other)}${h(c.other.name)}<div style="margin-top:4px">${pay(c)}</div></td><td class="muted">${h(c.message || '')}</td><td>${pill(c.status)}</td><td style="white-space:nowrap">${buyerBtns(c)}</td></tr>`).join('')}</table>
      <p class="muted">Lo que compartes con cada proveedor se configura en <a href="#politicas">Reglas de los agentes</a>.</p>` : '<p class="muted">Aún no tienes proveedores conectados.</p>'}</div></div>` : ''}`;
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => { const i = $('#' + b.dataset.copy); try { await navigator.clipboard.writeText(i.value); toast('Enlace copiado'); } catch { i.select(); } });
  document.querySelectorAll('#fc,#fp').forEach(f => f.onsubmit = async e => { e.preventDefault(); try { await api('/connections', { body: Object.fromEntries(new FormData(f)) }); toast('Solicitud enviada'); render(); } catch (x) { f.querySelector('.err').textContent = x.message; } });
  document.querySelectorAll('[data-k]').forEach(b => b.onclick = async () => { try { await api(`/connections/${b.dataset.k}/status`, { body: { status: b.dataset.s } }); render(); } catch (e) { toast(e.message); } });
  document.querySelectorAll('[data-pay]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('/billing/connection/' + b.dataset.pay, { body: {} }); if (r.url) location.href = r.url; else { toast('Conexión pagada'); render(); } } catch (e) { toast(e.message); b.disabled = false; } });
  document.querySelectorAll('[data-unpay]').forEach(b => b.onclick = async () => { if (!confirm('¿Dejar de pagar la conexión de este proveedor? Si no tiene plan Ventas, su asistente dejará de negociar contigo.')) return; try { await api('/billing/connection/' + b.dataset.unpay, { method: 'DELETE' }); render(); } catch (e) { toast(e.message); } });
}

// ---------------- reglas de los agentes ----------------
async function viewPoliticas() {
  await shell('politicas', '<div id="c"></div>');
  const sides = [isSeller() && 'venta', isBuyer() && 'compra'].filter(Boolean);
  const cur = sides.includes(route().q.get('lado')) ? route().q.get('lado') : sides[0];
  const p = await api('/policy/' + cur);
  const rng = (path, label, v) => `<div class="range"><span>${label}</span><input type="range" min="0" max="100" step="5" data-p="${path}" value="${v}"><b>${v}</b></div>`;
  const ck = (path, label, v, help) => `<label class="chk"><input type="checkbox" data-p="${path}" ${v ? 'checked' : ''}><span>${label}${help ? `<small>${help}</small>` : ''}</span></label>`;
  const nm = (path, label, v, step = 1) => `<div><label>${label}</label><input type="number" step="${step}" data-p="${path}" value="${v}"></div>`;
  const estilo = `<label>Estilo de negociación</label><select data-p="estilo">${['duro', 'equilibrado', 'flexible'].map(e => `<option value="${e}" ${p.estilo === e ? 'selected' : ''}>${e[0].toUpperCase() + e.slice(1)}</option>`).join('')}</select>`;
  const modo = `<label>Cómo cerrar</label><select data-p="cierre.modo"><option value="auto" ${p.cierre.modo === 'auto' ? 'selected' : ''}>Cerrar solo si está dentro de los límites; si no, pedirme aprobación</option><option value="aprobacion" ${p.cierre.modo === 'aprobacion' ? 'selected' : ''}>Pedirme aprobación siempre antes de cerrar</option></select>`;
  let body;
  if (cur === 'venta') body = `<div class="grid">
    <div class="card"><h2>Qué enseñar al cliente</h2><p class="hint">Lo que el agente de compras de tus clientes puede ver.</p>
      ${ck('mostrar.catalogo', 'Catálogo y precio de lista', p.mostrar.catalogo)}${ck('mostrar.stock', 'Stock disponible', p.mostrar.stock)}${ck('mostrar.plazo', 'Plazo de entrega', p.mostrar.plazo)}
      ${ck('mostrar.costes', 'Enseñar costes (libro abierto)', p.mostrar.costes, 'El cliente ve tu coste y se negocia sobre coste + margen. Genera confianza y acuerdos más rápidos, a cambio de menos margen de maniobra.')}</div>
    <div class="card"><h2>Cómo cerrar</h2>${modo}<div class="row">${nm('cierre.descuento_max_auto', 'Descuento máximo sin aprobación (%)', p.cierre.descuento_max_auto, 0.5)}${nm('cierre.importe_max_auto', 'Importe máximo sin aprobación (€)', p.cierre.importe_max_auto, 100)}</div></div>
    <div class="card"><h2>Qué priorizar</h2><p class="hint">Cuánto pesa cada objetivo cuando el agente decide si cede.</p>
      ${rng('prioridades.margen', 'Margen', p.prioridades.margen)}${rng('prioridades.volumen', 'Volumen', p.prioridades.volumen)}${rng('prioridades.rotacion', 'Rotar stock', p.prioridades.rotacion)}${estilo}</div>
    <div class="card"><h2>Precios</h2><p class="hint">Los precios de lista y mínimos de cada producto están en el <a href="#catalogo">catálogo</a>.</p>
      <div class="row">${nm('margen_min_pct', 'Margen mínimo sobre coste (%)', p.margen_min_pct, 0.5)}</div><p class="muted">El agente nunca vende por debajo del mayor de: precio mínimo del producto o coste + este margen.</p></div></div>`;
  else body = `<div class="grid">
    <div class="card"><h2>Qué enseñar a los proveedores</h2><p class="hint">Datos que tus proveedores conectados pueden ver para anticiparse a tu demanda.</p>
      ${ck('compartir.consumo', 'Consumo mensual', p.compartir.consumo)}${ck('compartir.prevision', 'Previsión de compra', p.compartir.prevision, 'Permite al proveedor planificar y suele traer mejores precios.')}${ck('compartir.stock', 'Mi stock actual', p.compartir.stock)}</div>
    <div class="card"><h2>Cómo cerrar</h2>${modo}<div class="row">${nm('cierre.importe_max_auto', 'Importe máximo sin aprobación (€)', p.cierre.importe_max_auto, 100)}</div>${ck('acepta_parciales', 'Aceptar entregas parciales', p.acepta_parciales)}</div>
    <div class="card"><h2>Qué priorizar</h2><p class="hint">Cómo elige el agente entre varias ofertas.</p>
      ${rng('prioridades.precio', 'Precio', p.prioridades.precio)}${rng('prioridades.plazo', 'Plazo', p.prioridades.plazo)}${rng('prioridades.fiabilidad', 'Proveedor habitual', p.prioridades.fiabilidad)}${estilo}</div>
    <div class="card"><h2>Precios</h2><p class="hint">El precio objetivo y el máximo se fijan en cada <a href="#comprar">compra</a>. El agente empieza por el objetivo y nunca pasa del máximo.</p></div></div>`;
  $('#c').innerHTML = `<h1>Reglas de los agentes</h1><p class="lead">Tus agentes nunca salen de estas reglas. Lo que quede fuera te llega para aprobar.</p>
    ${sides.length > 1 ? `<div class="seg" style="margin-bottom:16px">${sides.map(s => `<button data-side="${s}" class="${s === cur ? 'on' : ''}">Agente de ${s === 'venta' ? 'ventas' : 'compras'}</button>`).join('')}</div>` : ''}
    ${body}
    <div class="card"><h2>Instrucciones para el agente</h2><p class="hint">Dale una orden con tus palabras, como se la darías a tu equipo. Por ejemplo: “${cur === 'venta' ? 'este mes necesitamos mover stock, puedes ser más flexible' : 'este trimestre prioriza plazo sobre precio'}”.</p>
      <textarea id="ord">${h(p.instrucciones)}</textarea><div class="btns"><button class="p" id="ordb">Enviar instrucción</button></div><div class="muted" id="ordo"></div></div>
    <div class="btns"><button class="p" id="save">Guardar reglas</button></div>`;
  document.querySelectorAll('[data-side]').forEach(b => b.onclick = () => location.hash = '#politicas?lado=' + b.dataset.side);
  document.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => r.nextElementSibling.textContent = r.value);
  const collect = () => { const out = {}; document.querySelectorAll('[data-p]').forEach(i => { const ks = i.dataset.p.split('.'); let o = out; ks.slice(0, -1).forEach(k => o = o[k] = o[k] || {}); o[ks.at(-1)] = i.type === 'checkbox' ? i.checked : i.type === 'number' || i.type === 'range' ? Number(i.value) : i.value; }); return out; };
  $('#save').onclick = async () => { try { await api('/policy/' + cur, { method: 'PUT', body: collect() }); toast('Reglas guardadas'); } catch (e) { toast(e.message); } };
  $('#ordb').onclick = async () => {
    const b = $('#ordb'); b.disabled = true; $('#ordo').textContent = 'Aplicando…';
    try { await api('/policy/' + cur, { method: 'PUT', body: collect() }); const r = await api(`/policy/${cur}/instruct`, { body: { text: $('#ord').value } }); await viewPoliticas(); $('#ordo').textContent = r.explicacion; }
    catch (e) { $('#ordo').textContent = e.message; b.disabled = false; }
  };
}

// ---------------- mi empresa ----------------
async function viewEmpresa() {
  await shell('empresa', '<div id="c"></div>');
  const c = ME.company, users = await api('/users');
  let logo = c.logo;
  $('#c').innerHTML = `<h1>Mi empresa</h1><p class="lead">Tu marca aparece en tu panel, en los pedidos y en las invitaciones a tus clientes.</p>
   <div class="grid"><div class="card"><h2>Membrete</h2><form id="f">
     <label>Nombre comercial</label><input name="name" value="${h(c.name)}">
     <label>Logo (PNG, JPG o SVG, máx. 500 KB)</label>${logo ? `<img class="logo-prev" id="lp" src="${h(logo)}">` : '<img class="logo-prev hidden" id="lp">'}<input type="file" id="lf" accept="image/png,image/jpeg,image/svg+xml,image/webp">
     <label>Color de marca</label><input type="color" name="color" value="${h(c.color || '#1f4fd1')}">
     <div class="row"><div><label>CIF / NIF</label><input name="tax_id" value="${h(c.tax_id)}"></div><div><label>Teléfono</label><input name="phone" value="${h(c.phone)}"></div></div>
     <label>Dirección</label><input name="address" value="${h(c.address)}"><label>Web</label><input name="web" value="${h(c.web)}">
     <div class="btns"><button class="p">Guardar</button>${logo ? '<button type="button" id="rmlogo">Quitar logo</button>' : ''}</div></form>
     <p class="muted">Tu código de empresa: <code class="k">${h(c.code)}</code></p></div>
   <div class="card"><h2>Usuarios</h2><table><tr><th>Nombre</th><th>Email</th><th></th></tr>${users.map(u => `<tr><td>${h(u.name)}${u.is_admin ? ' <span class="pill mute">admin</span>' : ''}</td><td>${h(u.email)}</td><td>${ME.user.is_admin && u.id !== ME.user.id ? `<button class="danger" data-u="${u.id}">Quitar</button>` : ''}</td></tr>`).join('')}</table>
     ${ME.user.is_admin ? `<h3>Añadir usuario (jefe de compras, jefe de ventas, comercial…)</h3><form id="fu"><div class="row"><div><label>Nombre</label><input name="name"></div><div><label>Email</label><input name="email" type="email" required></div></div><label>Contraseña inicial</label><input name="password" type="text" minlength="8" required>
     <label class="chk"><input type="checkbox" name="is_admin" value="1"> Puede cambiar datos de la empresa y la membresía</label><div class="btns"><button>Añadir</button></div><div class="err" id="eu"></div></form>` : ''}</div></div>`;
  $('#lf').onchange = e => { const f = e.target.files[0]; if (!f) return; if (f.size > 500000) return toast('El logo debe pesar menos de 500 KB'); const r = new FileReader(); r.onload = () => { logo = r.result; $('#lp').src = logo; $('#lp').classList.remove('hidden'); }; r.readAsDataURL(f); };
  const rm = $('#rmlogo'); if (rm) rm.onclick = () => { logo = null; $('#lp').classList.add('hidden'); };
  $('#f').onsubmit = async e => { e.preventDefault(); try { await api('/company', { method: 'PUT', body: { ...Object.fromEntries(new FormData(e.target)), logo } }); ME = null; toast('Guardado'); render(); } catch (x) { toast(x.message); } };
  const fu = $('#fu'); if (fu) fu.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.is_admin = !!b.is_admin; try { await api('/users', { body: b }); toast('Usuario añadido'); render(); } catch (x) { $('#eu').textContent = x.message; } };
  document.querySelectorAll('[data-u]').forEach(b => b.onclick = async () => { await api('/users/' + b.dataset.u, { method: 'DELETE' }); render(); });
}

// ---------------- membresía ----------------
async function viewMembresia() {
  await shell('membresia', '<div id="c"></div>');
  const c = ME.company, plans = ME.plans;
  const U = ME.usage, P = U.promo, MX = plans.comprador.max_conn;
  const FEAT = { comprador: ['Agente de compras', `Hasta ${MX} conexiones con proveedores`, 'Reglas de cierre y aprobaciones', 'Pedidos con tu membrete', `Paga la conexión de un proveedor sin plan por ${ME.conexion.price} €/mes`],
    vendedor: ['Agente de ventas', `Hasta ${MX} conexiones con clientes`, 'Catálogo con precios mínimos y costes', 'Pedidos con tu membrete', `Promoción: regala ${P?.months || 6} meses del plan Compras a ${P?.max || 50} clientes`],
    empresa: ['Agente de compras y agente de ventas', 'Sin tope de conexiones', `${(plans.empresa.max_neg || 1000).toLocaleString('es-ES')} negociaciones al mes incluidas`, `A partir de ahí, ${String(plans.empresa.extra_neg ?? 0.99).replace('.', ',')} € por negociación`, 'Varios usuarios por empresa'] };
  const N = U.negociaciones;
  if (route().q.get('ok')) toast('Pago recibido. Tu membresía se activará en unos segundos.');
  $('#c').innerHTML = `<h1>Membresía</h1><p class="lead">Estado: ${pill(c.plan_status)} ${c.plan_until ? `hasta el ${fdate(c.plan_until)}` : ''}${plans[c.plan] ? ` · Plan ${h(plans[c.plan].name)}` : ''}</p>
   ${c.promo_by && c.active ? `<div class="note ok">Tienes el plan Compras gratis hasta el ${fdate(c.plan_until)} por invitación de ${h(c.promo_by)}. No tienes que pagar nada hasta entonces.</div>` : ''}
   ${c.sponsored ? '<div class="note ok">No tienes plan Ventas, pero un cliente paga tu conexión: tu asistente puede negociar con ese cliente.</div>' : ''}
   <div class="kpis" style="margin-bottom:16px"><div class="kpi"><div class="v">${U.conexiones}${U.max ? ` <small class="muted">de ${U.max}</small>` : ''}</div><div class="l">Conexiones${U.max ? '' : ' (sin tope)'}</div></div>
     <div class="kpi"><div class="v">${N.used.toLocaleString('es-ES')}${N.included ? ` <small class="muted">de ${N.included.toLocaleString('es-ES')}</small>` : ''}</div><div class="l">Negociaciones este mes${N.extra ? ` · ${N.extra} extra = ${eur(N.extra_eur)}` : ''}</div></div>${P ? `<div class="kpi"><div class="v">${P.used} <small class="muted">de ${P.max}</small></div><div class="l">Clientes con ${P.months} meses gratis</div></div>` : ''}</div>
   <div class="plans">${Object.entries(plans).filter(([, p]) => p.roles.includes(c.role)).map(([k, p]) => `<div class="plan ${c.plan === k && c.plan_status === 'active' ? 'cur' : ''}"><h2>${h(p.name)}</h2><div class="pr">${eur(p.price).replace(',00', '')}<span class="muted"> /mes</span></div><ul>${FEAT[k].map(f => `<li>${f}</li>`).join('')}</ul>
     ${ME.user.is_admin ? `<button class="p" data-plan="${k}">${c.plan === k && c.plan_status === 'active' ? 'Renovar' : 'Elegir este plan'}</button>` : ''}</div>`).join('')}</div>
   ${!ME.features.stripe ? '<p class="muted" style="margin-top:14px">Modo demostración: el pago no está conectado, al elegir un plan se activa 30 días sin cobro.</p>' : '<p class="muted" style="margin-top:14px">Pago seguro con tarjeta. Puedes cancelar cuando quieras.</p>'}`;
  document.querySelectorAll('[data-plan]').forEach(b => b.onclick = async () => { b.disabled = true; try { const r = await api('/billing/checkout', { body: { plan: b.dataset.plan } }); if (r.url) location.href = r.url; else { ME = null; toast('Plan activado'); render(); } } catch (e) { toast(e.message); b.disabled = false; } });
}

// ---------------- administración IAC ----------------
async function viewAdmin() {
  await shell('admin', '<div id="c"></div>');
  const cs = await api('/admin/companies');
  const mrr = cs.filter(c => c.plan_status === 'active' && !(c.promo_by && c.plan_until - c.created <= 181 * 864e5)).reduce((a, c) => a + (ME.plans[c.plan]?.price || 0) + (c.neg?.extra_eur || 0) + c.sponsoring * ME.conexion.price, 0);
  $('#c').innerHTML = `<h1>Administración IAC</h1><p class="lead">Todas las empresas de la plataforma.</p>
   <div class="kpis"><div class="kpi"><div class="v">${cs.length}</div><div class="l">Empresas</div></div><div class="kpi"><div class="v">${cs.filter(c => c.plan_status === 'active').length}</div><div class="l">Membresías activas</div></div><div class="kpi"><div class="v">${eur(mrr)}</div><div class="l">Ingreso mensual recurrente</div></div><div class="kpi"><div class="v">${cs.reduce((a, c) => a + c.orders, 0) / 2 | 0}</div><div class="l">Pedidos cerrados (aprox.)</div></div></div>
   <div class="card" style="overflow-x:auto"><table><tr><th>Empresa</th><th>Código</th><th>Tipo</th><th>Plan</th><th>Estado</th><th>Hasta</th><th class="n">Usuarios</th><th class="n">Pedidos</th><th class="n">Conexiones</th><th>Negociaciones mes</th><th>Promoción</th><th>WhatsApp (extra)</th><th></th></tr>
   ${cs.map(c => `<tr><td>${h(c.name)}</td><td><code class="k">${h(c.code)}</code></td><td>${h(c.role)}</td><td>${h(ME.plans[c.plan]?.name || '—')}</td><td>${pill(c.plan_status)}</td><td>${fdate(c.plan_until)}</td><td class="n">${c.users}</td><td class="n">${c.orders}</td><td class="n">${c.conns}${c.sponsoring ? ` <small class="muted">· paga ${c.sponsoring}</small>` : ''}</td>
     <td style="white-space:nowrap">${c.neg.used}${c.neg.included ? ` / ${c.neg.included}` : ''}${c.neg.extra ? ` <b>+${eur(c.neg.extra_eur)}</b>` : ''}</td>
     <td class="muted" style="white-space:nowrap">${c.promo_by ? 'Invitado por ' + h(c.promo_by) : c.promo_given ? `Regala ${c.promo_given}` : '—'}</td>
     <td style="white-space:nowrap"><label class="chk" style="margin:0"><input type="checkbox" data-wa="${c.id}" ${c.wa_enabled ? 'checked' : ''}><span>${c.wa_month} este mes</span></label></td>
     <td style="white-space:nowrap"><button data-c="${c.id}" data-s="active">+30 días</button> <button class="danger" data-c="${c.id}" data-s="cancelado">Suspender</button></td></tr>`).join('')}</table></div>`;
  document.querySelectorAll('[data-wa]').forEach(i => i.onchange = async () => { await api('/admin/companies/' + i.dataset.wa, { body: { wa_enabled: i.checked } }); toast(i.checked ? 'WhatsApp activado' : 'WhatsApp desactivado'); });
  document.querySelectorAll('[data-c]').forEach(b => b.onclick = async () => { await api('/admin/companies/' + b.dataset.c, { body: { plan_status: b.dataset.s, days: b.dataset.s === 'active' ? 30 : 0 } }); render(); });
}


// ---------------- empresas sin agente ----------------
const EXT_ST = { abierta: ['Negociando', 'wait'], humano: ['Atiende una persona', 'wait'], pendiente: ['Pendiente de aprobación', 'wait'], cerrada: ['Cerrada', 'ok'], sin_acuerdo: ['Sin acuerdo', 'no'], cancelada: ['Cancelada', 'mute'] };
const extPill = s => { const [t, c] = EXT_ST[s] || [s, 'mute']; return `<span class="pill ${c}">${h(t)}</span>`; };
async function viewExternos() {
  await shell('externos', '<div id="c"></div>');
  const [list, prods] = await Promise.all([api('/ext'), isSeller() ? api('/products') : Promise.resolve([])]);
  const sides = [isBuyer() && 'compra', isSeller() && 'venta'].filter(Boolean);
  const side = sides.includes(route().q.get('lado')) ? route().q.get('lado') : sides[0];
  $('#c').innerHTML = `<h1>Empresas sin agente</h1><p class="lead">Tu asistente negocia por escrito con proveedores o clientes que no usan IAC. Les envías un enlace con tu marca, responden con sus palabras y el asistente negocia dentro de tus reglas.</p>
   <div class="grid"><div class="card"><h2>Nueva negociación</h2>
     ${sides.length > 1 ? `<div class="seg" style="margin:6px 0 4px">${sides.map(x => `<button type="button" data-side="${x}" class="${x === side ? 'on' : ''}">${x === 'compra' ? 'Quiero comprar' : 'Quiero vender'}</button>`).join('')}</div>` : ''}
     <form id="f">
     ${side === 'venta' ? `<label>Producto de tu catálogo</label><select name="product_id" required>${prods.map(p => `<option value="${p.id}" data-l="${p.list_price}" data-m="${p.min_price}">${h(p.name)} · lista ${eur(p.list_price)} · stock ${p.stock}</option>`).join('')}</select>
        ${prods.length ? '' : '<p class="err">Primero añade productos en el <a href="#catalogo">catálogo</a>.</p>'}
        <label>Código del artículo del cliente <span class="muted">(si lo sabes; si no, se lo pediremos)</span></label><input name="buyer_code" placeholder="Opcional">
        <div class="row"><div><label>Precio de salida (€/ud)</label><input name="open_price" type="number" step="0.01" placeholder="Por defecto, el de lista"></div><div><label>Precio mínimo (€/ud)</label><input name="limit_price" type="number" step="0.01" placeholder="Por defecto, tu mínimo"></div></div>`
      : `<label>Producto</label><input name="product_name" required><div class="row"><div><label>Tu código de artículo</label><input name="buyer_code" placeholder="Opcional"></div><div><label>Código del fabricante</label><input name="mfr_code" placeholder="Si lo sabes; si no, se lo pediremos"></div></div><div class="row"><div><label>Unidad</label><input name="unit" value="ud"></div><div><label>Precio objetivo (€/ud)</label><input name="open_price" type="number" step="0.01" required></div><div><label>Precio máximo (€/ud)</label><input name="limit_price" type="number" step="0.01" required></div></div>`}
     <div class="row"><div><label>Cantidad</label><input name="qty" type="number" min="1" required></div><div><label>Plazo de entrega (días)</label><input name="days" type="number" min="0"></div></div>
     <h3>${side === 'compra' ? 'Proveedor' : 'Cliente'}</h3>
     <div class="row"><div><label>Empresa</label><input name="cp_company"></div><div><label>Persona de contacto</label><input name="cp_name"></div></div>
     <label>Email</label><input name="cp_email" type="email">
     <label>Supervisa la conversación</label><input name="supervisor" value="${h(ME.user.name || '')}">
     <p class="muted">La otra persona verá siempre que conversa con tu asistente, supervisado por esta persona, y podrá pedir hablar con ella.</p>
     <div class="btns"><button class="p">Crear enlace de negociación</button></div><div class="err" id="err"></div></form></div>
   <div class="card"><h2>Negociaciones</h2>${list.length ? `<table><tr><th>Fecha</th><th>Con</th><th>Producto</th><th class="n">Precio</th><th>Estado</th></tr>${list.map(n => `<tr class="click" data-href="#externo/${n.id}"><td>${fdate(n.updated)}</td><td>${n.side === 'compra' ? 'Compra a ' : 'Venta a '}${h(n.cp_company || n.cp_name || '—')}${n.unread ? ' <span class="badge">nuevo</span>' : ''}</td><td>${h(n.product_name)}</td><td class="n">${eur(n.price ?? n.our_offer)}</td><td>${extPill(n.status)}</td></tr>`).join('')}</table>` : '<p class="muted">Todavía no has creado ninguna.</p>'}</div></div>`;
  bindRows();
  document.querySelectorAll('[data-side]').forEach(b => b.onclick = () => location.hash = '#externos?lado=' + b.dataset.side);
  $('#f').onsubmit = async e => {
    e.preventDefault(); const body = Object.fromEntries(new FormData(e.target)); body.side = side;
    for (const k of ['open_price', 'limit_price', 'days']) if (body[k] === '') delete body[k];
    try { const r = await api('/ext', { body }); location.hash = '#externo/' + r.id; } catch (x) { $('#err').textContent = x.message; }
  };
}
async function viewExterno(id) {
  await shell('externos', '<div id="c"></div>');
  const n = await api('/ext/' + id);
  const link = `${location.origin}/n/${n.token}`;
  const c = ME.company;
  const subject = n.side === 'compra' ? `Solicitud de precio: ${n.product_name}` : `Propuesta: ${n.product_name}`;
  const mail = `Hola${n.cp_name ? ' ' + n.cp_name : ''},\n\n${n.side === 'compra' ? `En ${c.name} necesitamos ${n.qty} ${n.unit} de ${n.product_name}.` : `En ${c.name} tenemos una propuesta para usted: ${n.qty} ${n.unit} de ${n.product_name}.`} Puede ver los detalles y responder aquí, a cualquier hora:\n${link}\n\nLe atenderá nuestro asistente ${n.side === 'compra' ? 'de compras' : 'comercial'}, supervisado por ${n.supervisor}.\n\nUn saludo,\n${n.supervisor}\n${c.name}`;
  const WHO = { agent: 'Tu asistente', human: n.cp_company || n.cp_name || 'La otra empresa', staff: n.supervisor || 'Tu equipo', sys: 'Registro' };
  const CLS = { agent: n.side === 'compra' ? 'buy' : 'sell', human: n.side === 'compra' ? 'sell' : 'buy', staff: n.side === 'compra' ? 'buy' : 'sell', sys: 'sys' };
  $('#c').innerHTML = `<p><a href="#externos">← Empresas sin agente</a></p>
   <h1>${n.side === 'compra' ? 'Compra' : 'Venta'} · ${h(n.product_name)}</h1><p class="lead">${extPill(n.status)} ${h(n.cp_company || '')} ${n.cp_name ? '· ' + h(n.cp_name) : ''}</p>
   <div class="grid" style="grid-template-columns:minmax(290px,1fr) minmax(320px,1.5fr)"><div>
     <div class="card"><h2>Enlace para ${n.side === 'compra' ? 'el proveedor' : 'el cliente'}</h2><input readonly value="${h(link)}" id="lnk"><div class="btns"><button id="cpl">Copiar enlace</button><button id="cpm">Copiar email listo para enviar</button></div>
       ${n.cp_email ? `<p class="muted">Envíalo a ${h(n.cp_email)} desde tu correo.</p>` : ''}</div>
     <div class="card"><h2>Condiciones</h2><table>
       <tr><td>Código del fabricante</td><td class="n">${n.mfr_code ? `<code class="k">${h(n.mfr_code)}</code>` : '—'}</td></tr>
       <tr><td>Código del cliente</td><td class="n">${n.buyer_code ? `<code class="k">${h(n.buyer_code)}</code>` : '—'}</td></tr>
       <tr><td>Códigos confirmados por la otra parte</td><td class="n">${n.cp_code_ok ? '<span class="pill ok">✔ Sí</span>' : '<span class="pill wait">Aún no</span>'}</td></tr>
       <tr><td>Cantidad</td><td class="n">${n.qty} ${h(n.unit)}</td></tr>
       <tr><td>${n.side === 'compra' ? 'Objetivo / máximo' : 'Salida / mínimo'}</td><td class="n">${eur(n.open_price)} / ${eur(n.limit_price)}</td></tr>
       <tr><td>Última propuesta tuya</td><td class="n">${eur(n.our_offer)}</td></tr>
       <tr><td>Última cifra suya</td><td class="n">${n.their_offer != null ? eur(n.their_offer) : '—'}</td></tr>
       ${n.price != null ? `<tr><td>Acordado</td><td class="n"><b>${eur(n.price)} · total ${eur(n.total)}</b></td></tr>` : ''}</table>
       <div class="btns">${n.status === 'pendiente' ? '<button class="ok" data-a="aprobar">Aprobar acuerdo</button><button class="danger" data-a="rechazar">Rechazar</button>' : ''}
       ${n.agent_paused && !['cerrada', 'cancelada'].includes(n.status) ? '<button data-a="reanudar">Devolver al asistente</button>' : ''}
       ${n.status === 'cerrada' ? `<a class="btn p" href="/pedido-externo/${n.id}" target="_blank">Ver pedido con membrete</a>` : ''}
       ${['abierta', 'humano', 'sin_acuerdo'].includes(n.status) ? '<button class="danger" data-a="cancelar">Cancelar</button>' : ''}</div></div></div>
     <div class="card"><h2>Conversación</h2>${n.agent_paused ? '<div class="banner warn">El asistente está en pausa: respondes tú.</div>' : ''}
       <div class="log">${n.messages.map(m => `<div class="msg ${CLS[m.who]}"><div class="who">${h(WHO[m.who])}</div>${h(m.text)}</div>`).join('')}</div>
       ${['cerrada', 'cancelada'].includes(n.status) ? '' : `<form id="fm" style="margin-top:14px"><textarea name="text" placeholder="Escribe tú personalmente (el asistente se pondrá en pausa)"></textarea><div class="btns"><button class="p">Enviar como ${h(n.supervisor || 'yo')}</button></div></form>`}</div></div>`;
  const copy = async (txt, ok) => { try { await navigator.clipboard.writeText(txt); toast(ok); } catch { $('#lnk').select(); } };
  $('#cpl').onclick = () => copy(link, 'Enlace copiado');
  $('#cpm').onclick = () => copy(`Asunto: ${subject}\n\n${mail}`, 'Email copiado: pégalo en tu correo');
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => { try { await api(`/ext/${id}/${b.dataset.a}`, { body: {} }); render(); } catch (e) { toast(e.message); } });
  const fm = $('#fm'); if (fm) fm.onsubmit = async e => { e.preventDefault(); try { await api(`/ext/${id}/message`, { body: { text: new FormData(fm).get('text') } }); render(); } catch (x) { toast(x.message); } };
}

// ---------------- router ----------------
async function render() {
  const { r, parts } = route();
  if (r === 'login' || r === 'registro') return viewAuth(r);
  if (!ME) { try { ME = await api('/me'); } catch { return; } }
  applyBrand();
  try {
    if (parts[0] === 'operacion') return await viewOperacion(+parts[1]);
    if (parts[0] === 'externo') return await viewExterno(+parts[1]);
    if (parts[0] === 'producto') return await viewProducto(parts[1] === 'nuevo' ? 'nuevo' : +parts[1]);
    if (parts[0] === 'proyecto') return await viewProyecto(parts[1] === 'nuevo' ? 'nuevo' : +parts[1]);
    if (parts[0] === 'cita') return await viewCita(parts[1] === 'nueva' ? 'nueva' : +parts[1]);
    if (parts[0] === 'escaparate') return await viewEscaparate(+parts[1]);
    const V = { externos: viewExternos, inicio: viewInicio, operaciones: viewOperaciones, comprar: viewComprar, agenda: viewAgenda, avisos: viewAvisos, especiales: viewEspeciales, catalogo: viewCatalogo, codigos: viewCodigos, certificados: viewCertificados, proyectos: viewProyectos, conexiones: viewConexiones, politicas: viewPoliticas, empresa: viewEmpresa, membresia: viewMembresia, admin: viewAdmin };
    await (V[r] || viewInicio)();
  } catch (e) { const m = $('#main'); if (m) m.insertAdjacentHTML('afterbegin', `<div class="banner bad">${h(e.message)}</div>`); }
}
addEventListener('hashchange', render);
if (new URLSearchParams(location.search).get('invita') && !location.hash) location.hash = '#registro';
render();
