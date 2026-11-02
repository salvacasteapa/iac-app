// Autorizaciones especiales: precios y plazos fuera de las reglas generales,
// para un pedido, una familia de productos o un cliente.
const SP_SCOPE = { pedido: ['Pedido', 'Un pedido concreto de un cliente: artículo, cantidad y número de usos.'], familia: ['Familia', 'Toda una familia de productos, para un cliente o para todos.'], cliente: ['Cliente', 'Condiciones fijas para un cliente, en un artículo o en toda la gama.'] };
const SP_ST = { activa: ['Activa', 'ok'], futura: ['Aún no empieza', 'wait'], caducada: ['Caducada', 'mute'], agotada: ['Usada', 'mute'], desactivada: ['Desactivada', 'no'] };

async function viewEspeciales() {
  await shell('especiales', '<div id="c"></div>');
  const [list, conns, prods] = await Promise.all([api('/specials'), api('/connections'), api('/products')]);
  const clients = conns.filter(c => c.status === 'activa' && c.as === 'vendedor').map(c => c.other);
  const cats = [...new Set(prods.map(p => p.category).filter(Boolean))].sort();
  const q = route().q; let scope = SP_SCOPE[q.get('tipo')] ? q.get('tipo') : 'pedido', mode = scope === 'familia' ? 'descuento' : 'precio';
  const canEdit = ME.user.is_admin;
  const cond = a => `${a.price_mode === 'precio' ? `<b>${eur(a.price)}</b>/${h(a.product?.unit || 'ud')}${a.product ? ` <span class="muted">(lista ${eur(a.product.list_price)})</span>` : ''}` : `<b>hasta −${a.discount_pct}%</b>`}${a.lead_days != null ? `<br>Plazo <b>${a.lead_days} días</b>${a.product ? ` <span class="muted">(normal ${a.product.lead_days})</span>` : ''}` : ''}`;
  const target = a => `${a.scope === 'familia' ? `Familia <b>${h(a.category)}</b>` : a.product ? `<code class="k">${h(a.product.sku || '')}</code> ${h(a.product.name)}` : 'Toda la gama'}<br><span class="muted">${a.buyer ? h(a.buyer.name) : 'Todos los clientes'}</span>`;
  const limits = a => [a.min_qty || a.max_qty ? `${a.min_qty ? 'desde ' + a.min_qty : ''}${a.min_qty && a.max_qty ? ' ' : ''}${a.max_qty ? 'hasta ' + a.max_qty : ''} ud` : '', a.valid_from || a.valid_to ? `${a.valid_from ? 'del ' + a.valid_from : ''} ${a.valid_to ? 'al ' + a.valid_to : ''}` : '', a.uses_max ? `${a.uses} de ${a.uses_max} pedido${a.uses_max > 1 ? 's' : ''}` : ''].filter(Boolean).map(h).join('<br>') || '<span class="muted">Sin límite</span>';
  $('#c').innerHTML = `<h1>Autorizaciones especiales</h1><p class="lead">Condiciones fuera de tus reglas generales: un precio especial o un descuento mayor, y un plazo de entrega especial. El agente de ventas las aplica solo donde corresponden, y el pedido indica quién las autorizó.</p>
   ${canEdit ? `<div class="card"><h2>Nueva autorización</h2>
     <div class="scopes">${Object.entries(SP_SCOPE).map(([k, [t, d]]) => `<button type="button" class="scope ${k === scope ? 'on' : ''}" data-s="${k}"><b>${t}</b><span>${d}</span></button>`).join('')}</div>
     <form id="f"><div class="row">
       <div id="fcli"><label>Cliente</label><select name="buyer_id"><option value="" id="allc">Todos los clientes</option>${clients.map(c => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select></div>
       <div id="fprod"><label id="lprod">Artículo</label><select name="product_id"><option value="" id="allp">Toda la gama</option>${prods.map(p => `<option value="${p.id}" data-l="${p.list_price}" data-m="${p.min_price}" data-d="${p.lead_days}">${p.sku ? h(p.sku) + ' · ' : ''}${h(p.name)} · lista ${eur(p.list_price)}</option>`).join('')}</select></div>
       <div id="fcat"><label>Familia</label><select name="category">${cats.map(c => `<option>${h(c)}</option>`).join('')}</select>${cats.length ? '' : '<p class="err">Pon la familia a tus artículos en el catálogo.</p>'}</div></div>
      <h3>Condiciones</h3>
      <div class="seg" id="mseg"><button type="button" data-m="precio">Precio especial</button><button type="button" data-m="descuento">Descuento máximo</button></div>
      <div class="row"><div id="fprice"><label>Precio especial (€/ud)</label><input name="price" type="number" step="0.01" min="0"></div><div id="fdisc"><label>Descuento máximo sobre lista (%)</label><input name="discount_pct" type="number" step="0.1" min="0" max="90"></div>
        <div><label>Plazo de entrega especial (días)</label><input name="lead_days" type="number" min="0" placeholder="El normal"></div></div>
      <p class="hint" id="ref"></p>
      <div class="row"><div><label>Cantidad mínima</label><input name="min_qty" type="number" min="1"></div><div><label>Cantidad máxima</label><input name="max_qty" type="number" min="1"></div><div><label id="luses">Número de pedidos</label><input name="uses_max" type="number" min="1"></div></div>
      <div class="row"><div><label>Válida desde</label><input name="valid_from" type="date"></div><div><label>Válida hasta</label><input name="valid_to" type="date"></div></div>
      <label>Motivo</label><input name="reason" placeholder="Ej.: Pedido de lanzamiento, cliente estratégico, competencia en precio…">
      <label class="chk"><input type="checkbox" name="auto_close" checked><span>Cerrar sin pedir aprobación<small>Dentro de esta autorización el agente cierra solo. Si lo desmarcas, el pedido te llega para aprobar.</small></span></label>
      <div class="btns"><button class="p">Autorizar</button><span class="muted">Firmará: ${h(ME.user.name || ME.user.email)}</span></div><div class="err" id="err"></div></form></div>`
    : '<div class="banner info">Solo el administrador de la empresa puede crear autorizaciones especiales.</div>'}
   <div class="card"><h2>Autorizaciones</h2>${list.length ? `<div style="overflow-x:auto"><table><tr><th>Tipo</th><th>Para</th><th>Condiciones</th><th>Límites</th><th>Pedidos</th><th>Estado</th><th></th></tr>${list.map(a => `<tr>
      <td><span class="pill ${a.scope === 'pedido' ? 'wait' : a.scope === 'familia' ? 'ok' : 'mute'}">${SP_SCOPE[a.scope][0]}</span><div class="muted" style="margin-top:4px">nº ${a.id}</div></td><td>${target(a)}</td><td>${cond(a)}</td><td style="font-size:13.5px">${limits(a)}</td>
      <td class="n">${a.deals.n}${a.deals.n ? `<div class="muted">${eur(a.deals.t)}</div>` : ''}</td>
      <td><span class="pill ${SP_ST[a.state][1]}">${SP_ST[a.state][0]}</span><div class="muted" style="font-size:12.5px;margin-top:4px">${h(a.authorized_by)}${a.auto_close ? '' : ' · con aprobación'}</div>${a.reason ? `<div class="muted" style="font-size:12.5px">${h(a.reason)}</div>` : ''}</td>
      <td>${canEdit ? a.active ? `<button data-a="desactivar" data-id="${a.id}">Desactivar</button>` : `<button data-a="activar" data-id="${a.id}">Activar</button>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">Todavía no hay ninguna.</p>'}</div>`;
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = async () => { try { await api(`/specials/${b.dataset.id}/${b.dataset.a}`, { body: {} }); render(); } catch (e) { toast(e.message); } });
  if (!canEdit) return;
  const f = $('#f');
  const sync = () => {
    document.querySelectorAll('.scope').forEach(b => b.classList.toggle('on', b.dataset.s === scope));
    const sel = f.product_id, opt = sel.selectedOptions[0];
    if (scope === 'familia' || (scope === 'cliente' && !sel.value)) mode = 'descuento';
    $('#mseg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.m === mode); b.disabled = b.dataset.m === 'precio' && (scope === 'familia' || (scope === 'cliente' && !sel.value)); });
    $('#fcat').classList.toggle('hidden', scope !== 'familia'); $('#fprod').classList.toggle('hidden', scope === 'familia');
    $('#allp').hidden = scope === 'pedido'; if (scope === 'pedido' && !sel.value && sel.options[1]) sel.value = sel.options[1].value;
    $('#allc').hidden = scope !== 'familia'; if (scope !== 'familia' && !f.buyer_id.value && f.buyer_id.options[1]) f.buyer_id.value = f.buyer_id.options[1].value;
    $('#fprice').classList.toggle('hidden', mode !== 'precio'); $('#fdisc').classList.toggle('hidden', mode !== 'descuento');
    $('#luses').textContent = scope === 'pedido' ? 'Número de pedidos (normalmente 1)' : 'Máximo de pedidos (opcional)'; f.uses_max.placeholder = scope === 'pedido' ? '1' : 'Sin límite';
    const o = sel.selectedOptions[0];
    $('#ref').textContent = scope !== 'familia' && o && o.value ? `Referencia: lista ${eur(+o.dataset.l)}, mínimo normal ${eur(+o.dataset.m)}, plazo normal ${o.dataset.d} días.` : '';
  };
  document.querySelectorAll('.scope').forEach(b => b.onclick = () => { scope = b.dataset.s; if (scope !== 'familia') mode = 'precio'; sync(); });
  $('#mseg').querySelectorAll('button').forEach(b => b.onclick = () => { mode = b.dataset.m; sync(); });
  f.product_id.onchange = sync; sync();
  f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    const body = { ...d, scope, price_mode: mode, auto_close: !!d.auto_close, product_id: scope === 'familia' ? '' : d.product_id };
    try { await api('/specials', { body }); toast('Autorización creada'); render(); } catch (x) { $('#err').textContent = x.message; }
  };
}
