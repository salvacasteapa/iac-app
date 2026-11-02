// Familias de artículos: listado, alta, cambio de nombre, baja y estadísticas de venta por familia.
async function viewFamilias() {
  await shell('familias', '<div id="c"></div>');
  const q = route().q, dias = ['30', '90', '365', 'todo'].includes(q.get('dias')) ? q.get('dias') : '365';
  const D = await api('/familias?dias=' + dias);
  const canEdit = ME.user.is_admin, fams = D.families, live = fams.filter(f => f.active), maxRev = Math.max(1, ...live.map(f => f.revenue));
  const per = { 30: 'Últimos 30 días', 90: 'Últimos 90 días', 365: 'Último año', todo: 'Desde el principio' };
  const pct = (a, b) => String(b ? Math.round(a / b * 1000) / 10 : 0).replace('.', ',');
  const growth = f => f.growth == null ? '<span class="muted">—</span>' : `<span class="${f.growth >= 0 ? 'up' : 'down'}">${f.growth >= 0 ? '▲' : '▼'} ${String(Math.abs(f.growth)).replace('.', ',')}%</span>`;
  $('#c').innerHTML = `<h1>Familias</h1><p class="lead">Tus familias de artículos y cómo se vende cada una. Cada artículo del catálogo pertenece a una familia, y puedes usarlas para enviar ofertas y autorizaciones especiales.</p>
   <div class="seg" style="margin-bottom:14px">${Object.entries(per).map(([k, t]) => `<a class="${dias === k ? 'on' : ''}" href="#familias?dias=${k}">${t}</a>`).join('')}</div>
   <div class="kpis"><div class="kpi"><div class="v">${live.length}</div><div class="l">Familias</div></div><div class="kpi"><div class="v">${eur(D.totals.revenue)}</div><div class="l">Ventas</div></div>
     <div class="kpi"><div class="v">${D.totals.orders}</div><div class="l">Pedidos</div></div><div class="kpi"><div class="v">${eur(D.totals.margin)}</div><div class="l">Margen bruto</div></div></div>
   <div class="card"><h2>Ventas por familia</h2>${live.some(f => f.revenue) ? `<div class="bars">${[...live].sort((a, b) => b.revenue - a.revenue).map(f => `<div class="bar"><span class="bl">${h(f.name || 'Sin familia')}</span><span class="bt"><i style="width:${Math.max(1, f.revenue / maxRev * 100)}%"></i></span><span class="bv">${eur(f.revenue)} <small class="muted">${pct(f.revenue, D.totals.revenue)}%</small></span></div>`).join('')}</div>` : '<p class="muted">Todavía no hay ventas en este periodo.</p>'}</div>
   <div class="card"><h2>Detalle</h2><div style="overflow-x:auto"><table><tr><th>Familia</th><th class="n">Artículos</th><th class="n">Pedidos</th><th class="n">Unidades</th><th class="n">Ventas</th><th class="n">Vs. anterior</th><th class="n">Margen</th><th class="n">Dto. medio</th><th class="n">Éxito</th><th>Clientes</th><th></th></tr>
     ${fams.map(f => `<tr class="${f.active ? '' : 'mute'}"><td><b>${h(f.name || 'Sin familia')}</b>${f.code ? ` <code class="k">${h(f.code)}</code>` : ''}${f.active ? '' : ' <span class="pill no">De baja</span>'}${f.description ? `<div class="muted">${h(f.description)}</div>` : ''}${f.offers ? `<div><a href="#ofertas">${f.offers} oferta${f.offers > 1 ? 's' : ''} activa${f.offers > 1 ? 's' : ''}</a></div>` : ''}</td>
       <td class="n">${f.items}</td><td class="n">${f.orders}</td><td class="n">${f.units.toLocaleString('es-ES')}</td><td class="n"><b>${eur(f.revenue)}</b></td><td class="n">${growth(f)}</td><td class="n">${eur(f.margin)}<div class="muted">${pct(f.margin, f.revenue)}%</div></td>
       <td class="n">${f.orders ? String(f.avg_discount).replace('.', ',') + '%' : '—'}</td><td class="n">${f.win_rate == null ? '—' : f.win_rate + '%'}</td><td style="font-size:13px"><b>${f.clients}</b>${f.top_clients.length ? `<div class="muted">${f.top_clients.map(c => h(c.name)).join(', ')}</div>` : ''}</td>
       <td style="white-space:nowrap">${canEdit && f.id ? `<button data-ed="${f.id}">Editar</button> ${f.active ? `<button data-del="${f.id}">Baja</button>` : ''}` : ''}</td></tr>`).join('')}</table></div>
     <p class="hint" style="margin-top:8px">Éxito: pedidos cerrados frente a negociaciones sin acuerdo o perdidas. Dto. medio: rebaja media sobre el precio de lista.</p></div>
   ${canEdit ? `<div class="card" id="fcard"><h2 id="ftit">Nueva familia</h2><form id="ff"><input type="hidden" name="id"><div class="row"><div><label>Nombre</label><input name="name" required placeholder="Ej.: Tornillería"></div><div><label>Código (opcional)</label><input name="code" placeholder="Ej.: TOR"></div></div>
     <label>Descripción (opcional)</label><input name="description" placeholder="Qué artículos entran en esta familia">
     <div class="btns"><button class="p" id="fbtn">Crear familia</button><button type="button" id="fcan" class="hidden">Cancelar</button></div><div class="err" id="err"></div></form></div>` : ''}`;
  if (!canEdit) return;
  const f = $('#ff');
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => { const x = fams.find(y => y.id === +b.dataset.ed); f.id.value = x.id; f.name.value = x.name; f.code.value = x.code || ''; f.description.value = x.description || ''; $('#ftit').textContent = 'Editar familia'; $('#fbtn').textContent = 'Guardar'; $('#fcan').classList.remove('hidden'); $('#fcard').scrollIntoView({ behavior: 'smooth' }); });
  $('#fcan').onclick = () => render();
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('¿Dar de baja esta familia? Sus estadísticas se conservan.')) return; try { await api('/familias/' + b.dataset.del, { method: 'DELETE' }); toast('Familia dada de baja'); render(); } catch (e) { toast(e.message); } });
  f.onsubmit = async e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    try { await api('/familias' + (d.id ? '/' + d.id : ''), { method: d.id ? 'PUT' : 'POST', body: d }); toast(d.id ? 'Familia guardada' : 'Familia creada'); render(); } catch (x) { $('#err').textContent = x.message; }
  };
}
