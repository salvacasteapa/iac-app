// Ofertas especiales: el proveedor las envía por familia o artículo a un cliente, a un grupo o a todos.
// El cliente las ve aquí y su agente de compras obtiene el precio de la oferta al negociar.
const OF_ST = { activa: ['Activa', 'ok'], caducada: ['Caducada', 'mute'], retirada: ['Retirada', 'no'] };
const OF_R = { nueva: ['Nueva', 'wait'], vista: ['Vista', 'mute'], pedida: ['Pedida', 'ok'], descartada: ['Descartada', 'no'] };

async function viewOfertas() {
  await shell('ofertas', '<div id="c"></div>');
  const sides = [isSeller() && 'enviar', isBuyer() && 'recibidas'].filter(Boolean);
  const tab = sides.includes(route().q.get('ver')) ? route().q.get('ver') : sides[0];
  const tabs = sides.length > 1 ? `<div class="seg" style="margin-bottom:14px">${sides.map(k => `<a class="${tab === k ? 'on' : ''}" href="#ofertas?ver=${k}">${k === 'enviar' ? 'Enviar ofertas' : 'Ofertas recibidas'}</a>`).join('')}</div>` : '';
  return tab === 'enviar' ? ofertasEnviar(tabs) : ofertasRecibidas(tabs);
}

async function ofertasEnviar(tabs) {
  const [D, prods] = await Promise.all([api('/ofertas'), api('/products')]);
  const canEdit = ME.user.is_admin;
  let target = route().q.get('sobre') === 'articulo' ? 'articulo' : 'familia', audience = 'todos', mode = 'descuento';
  const audT = o => o.audience === 'todos' ? 'Todos los clientes' : o.audience === 'grupo' ? `Grupo <b>${h(o.grupo)}</b>` : h(o.recipients[0]?.name || 'Cliente');
  $('#c').innerHTML = `<h1>Ofertas especiales</h1><p class="lead">Envía una oferta sobre una familia de artículos o un artículo concreto a un cliente, a un grupo de clientes o a todos. Tus clientes la reciben al momento y su agente de compras obtiene ese precio cuando negocie contigo.</p>${tabs}
   ${canEdit ? `<div class="card"><h2>Nueva oferta</h2><form id="fo">
     <h3>¿Sobre qué?</h3><div class="seg" id="tseg"><button type="button" data-t="familia">Una familia</button><button type="button" data-t="articulo">Un artículo</button></div>
     <div class="row"><div id="ffam"><label>Familia</label><select name="category">${D.families.map(f => `<option>${h(f)}</option>`).join('')}</select>${D.families.length ? '' : '<p class="err">Pon la familia a tus artículos en el catálogo.</p>'}</div>
       <div id="fart"><label>Artículo</label><select name="product_id">${prods.map(p => `<option value="${p.id}" data-l="${p.list_price}" data-u="${h(p.unit)}">${p.sku ? h(p.sku) + ' · ' : ''}${h(p.name)}${p.category ? ' · ' + h(p.category) : ''} · lista ${eur(p.list_price)}</option>`).join('')}</select></div></div>
     <h3>¿Para quién?</h3><div class="seg" id="aseg"><button type="button" data-a="cliente">Un cliente</button><button type="button" data-a="grupo">Un grupo de clientes</button><button type="button" data-a="todos">Todos mis clientes</button></div>
     <div class="row"><div id="fcli"><label>Cliente</label><select name="buyer_id">${D.clients.map(c => `<option value="${c.id}">${h(c.name)}${c.grupo ? ' · ' + h(c.grupo) : ''}</option>`).join('')}</select></div>
       <div id="fgrp"><label>Grupo de clientes</label><select name="grupo">${D.groups.map(g => `<option>${h(g)}</option>`).join('')}</select>${D.groups.length ? '' : '<p class="hint">Aún no hay grupos. Créalos abajo, en «Grupos de clientes».</p>'}</div></div>
     <p class="hint" id="who"></p>
     <h3>Condiciones</h3><div class="seg" id="mseg"><button type="button" data-m="precio">Precio de oferta</button><button type="button" data-m="descuento">Descuento</button></div>
     <div class="row"><div id="fprice"><label>Precio de oferta (€/ud)</label><input name="price" type="number" step="0.01" min="0"></div><div id="fdisc"><label>Descuento sobre lista (%)</label><input name="discount_pct" type="number" step="0.1" min="0" max="90"></div>
       <div><label>Plazo de entrega (días)</label><input name="lead_days" type="number" min="0" placeholder="El normal"></div><div><label>Cantidad mínima</label><input name="min_qty" type="number" min="1" placeholder="Sin mínimo"></div><div><label>Válida hasta</label><input name="valid_to" type="date"></div></div>
     <p class="hint" id="ref"></p>
     <label>Título</label><input name="title" placeholder="Ej.: Campaña de otoño en tornillería">
     <label>Mensaje para el cliente</label><textarea name="message" rows="3" placeholder="Ej.: Precio especial para pedidos de este mes. Tu asistente de compras ya lo tiene aplicado."></textarea>
     <div class="btns"><button class="p">Enviar oferta</button><span class="muted">Firmará: ${h(ME.user.name || ME.user.email)}</span></div><div class="err" id="err"></div></form></div>`
    : '<div class="banner info">Solo el administrador de la empresa puede enviar ofertas especiales.</div>'}
   <div class="card"><h2>Ofertas enviadas</h2>${D.offers.length ? `<div style="overflow-x:auto"><table><tr><th>Oferta</th><th>Para</th><th>Condiciones</th><th class="n">Vista</th><th class="n">Pedidos</th><th></th></tr>${D.offers.map(o => `<tr>
       <td><b>${h(o.title)}</b><div class="muted">${o.target === 'familia' ? 'Familia ' + h(o.category) : h(o.product?.name || '')} · ${fdate(o.created)}</div></td><td>${audT(o)}<div class="muted">${o.recipients.length} cliente${o.recipients.length === 1 ? '' : 's'}</div></td>
       <td style="font-size:13.5px">${h(o.conditions)}</td><td class="n">${o.seen}/${o.recipients.length}</td><td class="n">${o.orders.n}${o.orders.n ? `<div class="muted">${eur(o.orders.t)}</div>` : ''}</td>
       <td style="white-space:nowrap"><span class="pill ${OF_ST[o.state][1]}">${OF_ST[o.state][0]}</span> ${canEdit && o.state === 'activa' ? `<button data-off="${o.id}">Retirar</button>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">Todavía no has enviado ninguna.</p>'}</div>
   <div class="card"><h2>Grupos de clientes</h2><p class="hint">Agrupa a tus clientes (por zona, sector, tamaño…) para enviarles ofertas a la vez. Tus clientes no ven el grupo.</p>
     ${D.clients.length ? `<datalist id="grps">${D.groups.map(g => `<option value="${h(g)}">`).join('')}</datalist><table><tr><th>Cliente</th><th>Grupo</th></tr>${D.clients.map(c => `<tr><td>${clogo(c)}${h(c.name)}</td><td><input data-g="${c.id}" value="${h(c.grupo || '')}" list="grps" placeholder="Sin grupo" ${canEdit ? '' : 'disabled'}></td></tr>`).join('')}</table>` : '<p class="muted">Aún no tienes clientes conectados.</p>'}</div>`;
  document.querySelectorAll('[data-off]').forEach(b => b.onclick = async () => { if (!confirm('¿Retirar la oferta? Tus clientes dejarán de verla y su precio ya no se aplicará.')) return; await api(`/ofertas/${b.dataset.off}/retirar`, { body: {} }); toast('Oferta retirada'); render(); });
  document.querySelectorAll('[data-g]').forEach(i => i.onchange = async () => { try { await api('/clientes/grupo', { body: { buyer_id: i.dataset.g, grupo: i.value } }); toast('Grupo guardado'); render(); } catch (e) { toast(e.message); } });
  if (!canEdit) return;
  const f = $('#fo');
  const sync = () => {
    if (target === 'familia') mode = 'descuento';
    $('#tseg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === target));
    $('#aseg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === audience));
    $('#mseg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.m === mode); b.disabled = b.dataset.m === 'precio' && target === 'familia'; });
    $('#ffam').classList.toggle('hidden', target !== 'familia'); $('#fart').classList.toggle('hidden', target !== 'articulo');
    $('#fcli').classList.toggle('hidden', audience !== 'cliente'); $('#fgrp').classList.toggle('hidden', audience !== 'grupo');
    $('#fprice').classList.toggle('hidden', mode !== 'precio'); $('#fdisc').classList.toggle('hidden', mode !== 'descuento');
    const list = audience === 'todos' ? D.clients : audience === 'grupo' ? D.clients.filter(c => (c.grupo || '').toLowerCase() === (f.grupo.value || '').toLowerCase()) : D.clients.filter(c => String(c.id) === f.buyer_id.value);
    $('#who').innerHTML = list.length ? `Llegará a <b>${list.length} cliente${list.length === 1 ? '' : 's'}</b>: ${list.slice(0, 8).map(c => h(c.name)).join(', ')}${list.length > 8 ? '…' : ''}` : '<span class="err">Ningún cliente conectado recibirá esta oferta.</span>';
    const o = f.product_id.selectedOptions[0];
    const pct = +f.discount_pct.value, pr = +f.price.value;
    $('#ref').textContent = target === 'articulo' && o ? `Precio de lista ${eur(+o.dataset.l)}/${o.dataset.u}${mode === 'descuento' && pct ? ` → con la oferta ${eur(+o.dataset.l * (1 - pct / 100))}` : mode === 'precio' && pr ? ` → ${Math.round((1 - pr / +o.dataset.l) * 1000) / 10}% de descuento` : ''}.` : target === 'familia' && pct ? `Se aplica un ${pct}% sobre el precio de lista de cada artículo de la familia.` : '';
  };
  $('#tseg').querySelectorAll('button').forEach(b => b.onclick = () => { target = b.dataset.t; sync(); });
  $('#aseg').querySelectorAll('button').forEach(b => b.onclick = () => { audience = b.dataset.a; sync(); });
  $('#mseg').querySelectorAll('button').forEach(b => b.onclick = () => { mode = b.dataset.m; sync(); });
  f.querySelectorAll('select,input').forEach(i => i.addEventListener('input', sync)); sync();
  f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    try { const r = await api('/ofertas', { body: { ...d, target, audience, price_mode: mode } }); toast(`Oferta enviada a ${r.sent} cliente${r.sent === 1 ? '' : 's'}`); render(); } catch (x) { $('#err').textContent = x.message; }
  };
}

async function ofertasRecibidas(tabs) {
  const list = await api('/ofertas/recibidas');
  const live = list.filter(o => !o.expired && o.status !== 'descartada'), old = list.filter(o => o.expired || o.status === 'descartada');
  const card = o => `<div class="card offer${o.expired || o.status === 'descartada' ? ' off' : ''}">
     <div class="ohead">${clogo(o.seller)}<b>${h(o.seller.name)}</b><span class="pill ${OF_R[o.status][1]}">${OF_R[o.status][0]}</span></div>
     <div class="obody">${o.product?.photo ? `<img src="${h(o.product.photo)}" alt="">` : ''}<div>
       <h2>${h(o.title)}</h2>
       <div class="oc">${o.price_mode === 'precio' ? `${eur(o.price)}<small>/${h(o.product?.unit || 'ud')}</small>` : `−${o.discount_pct}%`}</div>
       <div class="muted">${o.target === 'familia' ? `Familia <b>${h(o.category)}</b>${o.items.length ? ': ' + o.items.slice(0, 6).map(h).join(', ') + (o.items.length > 6 ? '…' : '') : ''}` : `${o.product.sku ? `<code class="k">${h(o.product.sku)}</code> ` : ''}${h(o.product.name)} · lista ${eur(o.product.list_price)}`}</div>
       <div class="muted">${h(o.conditions)}</div>${o.message ? `<p>${h(o.message)}</p>` : ''}</div></div>
     ${o.expired || o.status === 'descartada' ? '' : `<div class="btns">${o.target === 'articulo' ? `<a class="btn p" data-ped="${o.id}" href="#comprar?producto=${encodeURIComponent(o.product.name)}${o.price_mode === 'precio' ? '&precio=' + o.price : '&precio=' + Math.round(o.product.list_price * (1 - o.discount_pct / 100) * 100) / 100}${o.min_qty ? '&cantidad=' + o.min_qty : ''}">Pedir</a>` : `<a class="btn p" data-ped="${o.id}" href="#escaparate/${o.seller.id}">Ver y pedir</a>`}<button data-desc="${o.id}">Descartar</button></div>`}
   </div>`;
  $('#c').innerHTML = `<h1>Ofertas especiales</h1><p class="lead">Ofertas que te envían tus proveedores. Tu agente de compras ya tiene el precio de la oferta: cuando pidas, lo conseguirá sin que tengas que decir nada.</p>${tabs}
   ${live.length ? `<div class="offers">${live.map(card).join('')}</div>` : '<div class="card"><p class="muted">No tienes ofertas activas.</p></div>'}
   ${old.length ? `<h3 style="margin-top:22px">Anteriores</h3><div class="offers">${old.map(card).join('')}</div>` : ''}`;
  for (const o of list.filter(o => o.status === 'nueva')) api(`/ofertas/recibidas/${o.id}/vista`, { body: {} }).catch(() => {});
  document.querySelectorAll('[data-ped]').forEach(a => a.addEventListener('click', () => { api(`/ofertas/recibidas/${a.dataset.ped}/pedir`, { body: {} }).catch(() => {}); }));
  document.querySelectorAll('[data-desc]').forEach(b => b.onclick = async () => { await api(`/ofertas/recibidas/${b.dataset.desc}/descartar`, { body: {} }); render(); });
}
