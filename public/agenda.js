// Agenda comercial: llamadas, visitas y reuniones con su motivo, resultado y siguiente paso.
// Usa las utilidades globales de app.js ($, h, eur, api, shell, toast, render, ME, route, clogo).

const KIND_IC = {
  llamada: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  visita: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  reunion: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>'
};
let AG_META = null;
const agMeta = async () => AG_META || (AG_META = await api('/agenda/meta'));
const pad = n => String(n).padStart(2, '0');
const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDT = d => `${localISO(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mondayOf = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dayName = s => new Date(s + 'T12:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const RES_CLS = { pedido: 'ok', interesado: 'ok', conexion_ok: 'ok', resuelto: 'ok', enviar_info: 'wait', volver_llamar: 'wait', visita: 'wait', no_contesta: 'mute', no_interesado: 'no' };

function gcalURL(a, M) {
  const t = s => s.replace(/[-:]/g, '') + '00';
  const end = new Date(new Date(a.start).getTime() + a.minutes * 6e4);
  const p = new URLSearchParams({ action: 'TEMPLATE', text: `${M.kinds[a.kind]} · ${a.who} · ${M.motives[a.motive].t}`, dates: `${t(a.start)}/${t(localDT(end))}`,
    details: [a.product ? `Artículo: ${a.product.name}${a.product.sku ? ' (' + a.product.sku + ')' : ''}` : '', a.offer_price != null ? `Oferta: ${a.offer_price} €` : '', a.contact_name, a.contact_phone, a.contact_email, a.notes].filter(Boolean).join('\n'), location: a.place || '' });
  return 'https://calendar.google.com/calendar/render?' + p;
}

// ---------------- agenda (semana) ----------------
async function viewAgenda() {
  await shell('agenda', '<div id="c"></div>');
  const q = route().q;
  const mon = q.get('semana') ? mondayOf(new Date(q.get('semana') + 'T12:00')) : mondayOf(new Date());
  const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
  const kind = q.get('tipo') || '', mine = q.get('quien') !== 'todos';
  const [M, items, sug] = await Promise.all([agMeta(), api(`/agenda?from=${localISO(mon)}&to=${localISO(sun)}`), api('/agenda-sugerencias')]);
  const today = localISO(new Date()), nowDT = localDT(new Date());
  const list = items.filter(a => (!kind || a.kind === kind) && (!mine || a.user_id === ME.user.id));
  const overdue = list.filter(a => a.status === 'pendiente' && a.start < nowDT && a.start.slice(0, 10) < localISO(mon));
  const week = list.filter(a => a.start.slice(0, 10) >= localISO(mon));
  const pend = week.filter(a => a.status === 'pendiente');
  const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const nav = (o = {}) => { const p = new URLSearchParams({ semana: localISO(mon), tipo: kind, quien: mine ? 'yo' : 'todos', ...o }); [...p.keys()].forEach(k => !p.get(k) && p.delete(k)); return '#agenda?' + p; };
  const prev = new Date(mon); prev.setDate(prev.getDate() - 7); const next = new Date(mon); next.setDate(next.getDate() + 7);
  const item = a => `<a class="ag ${a.status} ${a.status === 'pendiente' && a.start < nowDT ? 'late' : ''}" href="#cita/${a.id}">
      <div class="ag-t">${a.start.slice(11, 16)}<small>${a.minutes} min</small></div><div class="ag-ic ${a.kind}">${KIND_IC[a.kind]}</div>
      <div class="ag-b"><b>${h(a.who)}</b><div class="muted">${h(M.kinds[a.kind])} · ${h(M.motives[a.motive]?.t || a.motive)}${a.product ? ' · ' + h(a.product.name) : ''}${a.offer_price != null ? ' · ' + eur(a.offer_price) : ''}</div>${a.contact_name ? `<div class="muted">${h(a.contact_name)}${a.contact_phone ? ' · ' + h(a.contact_phone) : ''}</div>` : ''}</div>
      <div class="ag-s">${a.status === 'hecha' ? `<span class="pill ${RES_CLS[a.result] || 'ok'}">${h(M.results[a.result]?.t || 'Hecha')}</span>` : a.status === 'cancelada' ? '<span class="pill mute">Cancelada</span>' : a.start < nowDT ? '<span class="pill no">Atrasada</span>' : '<span class="pill wait">Pendiente</span>'}${!mine && a.user ? `<div class="muted" style="margin-top:4px">${h(a.user.name || a.user.email)}</div>` : ''}</div></a>`;
  const days = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(d.getDate() + i); return localISO(d); });
  const sugHref = s => '#cita/nueva?' + new URLSearchParams(Object.fromEntries(Object.entries({ kind: s.kind, motive: s.motive, other_id: s.other_id, contact_company: s.contact_company, contact_name: s.contact_name, contact_email: s.contact_email, product_id: s.product_id, notes: s.why }).filter(([, v]) => v != null && v !== '')));
  $('#c').innerHTML = `<div class="head"><div><h1>Agenda</h1><p class="lead">Llamadas, visitas y reuniones con su motivo. Al terminar cada una apuntas cómo ha ido y la app te propone el siguiente paso.</p></div>
     <div class="btns" style="margin:0"><a class="btn" href="#cita/nueva?kind=llamada">+ Llamada</a><a class="btn" href="#cita/nueva?kind=visita">+ Visita</a><a class="btn p" href="#cita/nueva?kind=reunion">+ Reunión</a></div></div>
   <div class="kpis">${kpi(list.filter(a => a.start.slice(0, 10) === today && a.status === 'pendiente').length, 'Pendientes hoy')}${kpi(pend.length, 'Pendientes esta semana')}${kpi(overdue.length + week.filter(a => a.status === 'pendiente' && a.start < nowDT).length, 'Atrasadas')}${kpi(week.filter(a => a.status === 'hecha').length, 'Hechas esta semana')}</div>
   <div class="ag-bar"><div class="seg">${[['', 'Todas'], ['llamada', 'Llamadas'], ['visita', 'Visitas'], ['reunion', 'Reuniones']].map(([k, t]) => `<a class="${kind === k ? 'on' : ''}" href="${nav({ tipo: k })}">${t}</a>`).join('')}</div>
     <div class="seg"><a class="${mine ? 'on' : ''}" href="${nav({ quien: 'yo' })}">Mías</a><a class="${!mine ? 'on' : ''}" href="${nav({ quien: 'todos' })}">Todo el equipo</a></div>
     <div class="wk"><a class="btn" href="${nav({ semana: localISO(prev) })}" aria-label="Semana anterior">‹</a><b>${mon.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} – ${sun.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}</b><a class="btn" href="${nav({ semana: localISO(next) })}" aria-label="Semana siguiente">›</a>${localISO(mon) !== localISO(mondayOf(new Date())) ? `<a class="btn" href="${nav({ semana: '' })}">Hoy</a>` : ''}</div></div>
   <div class="grid g2"><div>
     ${overdue.length ? `<div class="card"><h2 style="color:var(--bad)">Atrasadas de semanas anteriores</h2>${overdue.map(item).join('')}</div>` : ''}
     ${days.map(d => { const its = week.filter(a => a.start.slice(0, 10) === d); return `<div class="day ${d === today ? 'today' : ''}"><h3>${dayName(d)}${d === today ? ' · hoy' : ''}</h3>${its.length ? its.map(item).join('') : '<p class="muted free">Libre</p>'}</div>`; }).join('')}
   </div><div><div class="card"><h2>A quién contactar</h2><p class="hint">Sugerencias a partir de tus pedidos, clientes, artículos nuevos y negociaciones.</p>
     ${sug.length ? sug.map(s => `<div class="sug"><div class="ag-ic ${s.kind}">${KIND_IC[s.kind]}</div><div style="flex:1;min-width:0"><b>${h(s.who || s.contact_company || s.contact_name || '—')}</b><div class="muted">${h(M.motives[s.motive].t)}</div><div class="muted"><i>${h(s.why)}</i></div></div><a class="btn" href="${sugHref(s)}">Programar</a></div>`).join('') : '<p class="muted">Nada urgente. ¡Buen trabajo!</p>'}</div>
     <div class="card"><h2>Motivos</h2><p class="hint">Cada cita lleva uno. Así sabrás qué funciona.</p><div class="mot">${Object.values(M.motives).map(m => `<span>${h(m.t)}</span>`).join('')}</div></div></div></div>`;
}

// ---------------- cita (nueva o existente) ----------------
async function viewCita(id) {
  await shell('agenda', '<div id="c"></div>');
  const isNew = id === 'nueva', q = route().q;
  const [M, conns, users, prods] = await Promise.all([agMeta(), api('/connections'), api('/users'), isSeller() ? api('/products') : isBuyer() ? api('/catalog') : []]);
  const a = isNew ? { kind: q.get('kind') || 'llamada', motive: q.get('motive') || '', other_id: +q.get('other_id') || null, contact_company: q.get('contact_company') || '', contact_name: q.get('contact_name') || '', contact_email: q.get('contact_email') || '', product_id: +q.get('product_id') || null, notes: q.get('notes') || '', status: 'pendiente', user_id: +q.get('user') || ME.user.id, minutes: null, history: [] } : await api('/agenda/' + id);
  const others = conns.filter(c => c.status === 'activa');
  if (isNew) { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 17 ? 1 : 0)); d.setHours(d.getHours() >= 17 ? 9 : d.getHours() + 1, 0, 0, 0); a.start = q.get('start') || localDT(d); }
  let kind = a.kind;
  const motiveOpts = () => Object.entries(M.motives).filter(([, m]) => m.k.includes(kind)).map(([k, m]) => `<option value="${k}" ${a.motive === k ? 'selected' : ''}>${h(m.t)}</option>`).join('');
  const done = a.status !== 'pendiente';
  $('#c').innerHTML = `<p><a href="#agenda">← Agenda</a></p><h1>${isNew ? 'Nueva cita' : `${h(M.kinds[a.kind])} · ${h(a.who)}`}</h1>
   ${!isNew ? `<p class="lead">${dayName(a.start.slice(0, 10))}, ${a.start.slice(11, 16)} · ${h(M.motives[a.motive]?.t)} ${a.status === 'hecha' ? `<span class="pill ${RES_CLS[a.result] || 'ok'}">${h(M.results[a.result]?.t)}</span>` : a.status === 'cancelada' ? '<span class="pill mute">Cancelada</span>' : ''}</p>` : ''}
   <div class="grid g2"><div>
    <div class="card"><h2>Detalles</h2><form id="f">
     <div class="seg" id="kseg">${Object.entries(M.kinds).map(([k, t]) => `<button type="button" data-k="${k}" class="${k === kind ? 'on' : ''}">${KIND_IC[k]} ${t}</button>`).join('')}</div>
     <label>Motivo</label><select name="motive" id="motive">${motiveOpts()}</select>
     <label>Con quién</label><select name="other_id" id="other"><option value="">Otra empresa (escribir)</option>${others.map(c => `<option value="${c.other.id}" ${a.other_id === c.other.id ? 'selected' : ''}>${h(c.other.name)} · ${c.as === 'vendedor' ? 'cliente' : 'proveedor'}</option>`).join('')}</select>
     <div id="free"><label>Empresa</label><input name="contact_company" value="${h(a.contact_company)}"></div>
     <div class="row"><div><label>Persona</label><input name="contact_name" value="${h(a.contact_name)}"></div><div><label>Teléfono</label><input name="contact_phone" type="tel" value="${h(a.contact_phone)}"></div><div><label>Email</label><input name="contact_email" type="email" value="${h(a.contact_email)}"></div></div>
     <div class="row"><div><label>Día y hora</label><input name="start" type="datetime-local" value="${h(a.start)}" required></div><div><label>Duración (min)</label><input name="minutes" id="minutes" type="number" min="5" step="5" value="${a.minutes ?? ''}"></div><div><label>Responsable</label><select name="user_id">${users.map(u => `<option value="${u.id}" ${u.id === a.user_id ? 'selected' : ''}>${h(u.name || u.email)}</option>`).join('')}</select></div></div>
     <div id="place"><label id="lplace">Lugar</label><input name="place" value="${h(a.place)}"></div>
     <div id="prod"><div class="row"><div><label>Artículo</label><select name="product_id"><option value="">—</option>${prods.map(p => `<option value="${p.id}" ${a.product_id === p.id ? 'selected' : ''}>${p.sku ? h(p.sku) + ' · ' : ''}${h(p.name)}${p.seller ? ' · ' + h(p.seller) : ''}</option>`).join('')}</select></div><div id="offer"><label>Precio de la oferta (€/ud)</label><input name="offer_price" type="number" step="0.01" value="${a.offer_price ?? ''}"></div></div></div>
     <label>Notas y guion</label><textarea name="notes" rows="4" id="notes">${h(a.notes)}</textarea>
     <div class="btns"><button class="p">${isNew ? 'Guardar en la agenda' : 'Guardar cambios'}</button>${isNew ? '' : '<button type="button" class="danger" id="del">Borrar</button>'}</div><div class="err" id="err"></div></form></div>
   </div><div>
    ${isNew ? `<div class="card"><h2>Guion sugerido</h2><div id="tips"></div></div>` : `
    <div class="card"><h2>Acciones</h2><div class="btns" style="margin-top:0">
      ${a.contact_phone ? `<a class="btn p" href="tel:${h(a.contact_phone.replace(/\s/g, ''))}">${KIND_IC.llamada} Llamar</a>` : ''}${a.contact_email ? `<a class="btn" href="mailto:${h(a.contact_email)}">Email</a>` : ''}
      ${a.place && a.kind === 'visita' ? `<a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.place)}">Cómo llegar</a>` : ''}
      <a class="btn" target="_blank" rel="noopener" href="${h(gcalURL(a, M))}">Añadir a Google Calendar</a><a class="btn" href="/agenda/${a.id}.ics">Outlook / iPhone (.ics)</a></div></div>
    ${!done ? `<div class="card res"><h2>¿Cómo ha ido?</h2><div class="chips" id="rchips">${Object.entries(M.results).map(([k, r]) => `<button type="button" data-r="${k}">${h(r.t)}</button>`).join('')}</div>
      <label>Comentario</label><textarea id="rnotes" rows="3" placeholder="Qué se habló, objeciones, compromisos…"></textarea>
      <div id="nextbox" class="hidden"><label class="chk"><input type="checkbox" id="donext" checked><span>Programar el siguiente paso</span></label>
        <div class="row"><div><label>Tipo</label><select id="nkind">${Object.entries(M.kinds).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></div><div><label>Motivo</label><select id="nmotive">${Object.entries(M.motives).map(([k, m]) => `<option value="${k}">${h(m.t)}</option>`).join('')}</select></div><div><label>Cuándo</label><input id="nstart" type="datetime-local"></div></div></div>
      <div class="btns"><button class="p" id="rsave" disabled>Guardar resultado</button></div>
      <div class="row" style="margin-top:6px"><div><label>Aplazar a</label><input type="datetime-local" id="post"></div><div style="display:flex;align-items:flex-end;gap:8px"><button id="bpost">Aplazar</button><button class="danger" id="bcancel">Cancelar cita</button></div></div></div>`
      : `<div class="card"><h2>Resultado</h2><p><span class="pill ${a.status === 'cancelada' ? 'mute' : RES_CLS[a.result] || 'ok'}">${a.status === 'cancelada' ? 'Cancelada' : h(M.results[a.result]?.t)}</span></p>${a.result_notes ? `<p style="white-space:pre-wrap">${h(a.result_notes)}</p>` : ''}</div>`}
    <div class="card"><h2>Historial con ${h(a.who)}</h2>${a.history.length ? a.history.map(x => `<a class="hist" href="#cita/${x.id}"><span>${x.start.slice(0, 10)}</span><span>${h(M.kinds[x.kind])} · ${h(M.motives[x.motive]?.t)}</span>${x.status === 'hecha' ? `<span class="pill ${RES_CLS[x.result] || 'ok'}">${h(M.results[x.result]?.t)}</span>` : x.status === 'cancelada' ? '<span class="pill mute">Cancelada</span>' : '<span class="pill wait">Pendiente</span>'}</a>${x.result_notes ? `<div class="muted hnote">${h(x.result_notes)}</div>` : ''}`).join('') : '<p class="muted">Primer contacto registrado.</p>'}</div>`}
   </div></div>`;

  const TIPS = {
    oferta: ['Recuerda el último pedido y cómo fue.', 'Presenta la oferta con precio, plazo y validez.', 'Pregunta qué necesitaría para cerrarla hoy.'],
    nuevo_producto: ['Explica qué problema resuelve y para quién.', 'Envía fotos, vídeo y certificados del escaparate.', 'Propón una muestra o un primer pedido pequeño.'],
    regular: ['Pregunta cómo va su negocio y su consumo.', 'Detecta necesidades nuevas o cambios de proveedor.', 'Confirma que sus datos de contacto siguen bien.'],
    seguimiento_oferta: ['¿Ha podido revisar la oferta?', 'Resuelve dudas y objeciones.', 'Acuerda una fecha de decisión.'],
    reposicion: ['Comenta que hace tiempo que no pide.', 'Pregunta por su stock y su previsión.', 'Ofrece reponer con el plazo y precio actuales.'],
    conexion: ['Explica la ventaja: pedidos repetitivos sin llamadas ni correos.', 'Él pone los límites; el agente no puede salirse.', 'Envíale el enlace de invitación al terminar.'],
    captacion: ['Investiga la empresa antes de llamar.', 'Pregunta a quién compra y qué le gustaría mejorar.', 'Consigue una visita o una primera oferta.'],
    tarifa: ['Lleva el histórico de compras del año.', 'Prepara la tarifa nueva y el margen de negociación.', 'Cierra condiciones y fecha de entrada en vigor.'],
    demostracion: ['Confirma asistentes y material necesario.', 'Lleva muestras y fichas técnicas.', 'Acuerda próximos pasos al terminar.'],
    incidencia: ['Escucha primero y toma nota de todo.', 'Pide fotos o número de lote.', 'Comprométete con una solución y un plazo.'],
    cobro: ['Ten a mano facturas e importes.', 'Pregunta si hay algún problema con la factura.', 'Acuerda fecha y forma de pago.'],
    postventa: ['¿Llegó todo bien y a tiempo?', '¿Está contento con el producto?', 'Aprovecha para preguntar por la siguiente necesidad.'],
    certificados: ['Revisa qué certificado caduca o falta.', 'Pide los documentos o la auditoría.', 'Actualízalo en la página de Certificados.'],
    revision: ['Lleva volumen, ahorro y plazos del año.', 'Pregunta qué mejorar.', 'Propón objetivos para el año que viene.'],
    proveedor: ['Ten claro tu precio objetivo y máximo.', 'Pide alternativas de plazo o cantidad.', 'Pide que lo dejen por escrito.'],
    feria: ['Haz la lista de clientes a visitar.', 'Lleva catálogo y tarjetas.', 'Registra cada contacto en la agenda al volver.'],
    otro: ['Define el objetivo de la cita antes de empezar.']
  };
  const sync = () => {
    $('#kseg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
    const cur = $('#motive').value; $('#motive').innerHTML = motiveOpts(); if ([...$('#motive').options].some(o => o.value === cur)) $('#motive').value = cur;
    const m = M.motives[$('#motive').value];
    $('#prod').classList.toggle('hidden', !m.prod); $('#offer').classList.toggle('hidden', !['oferta', 'nuevo_producto', 'seguimiento_oferta', 'proveedor'].includes($('#motive').value));
    $('#place').classList.toggle('hidden', kind === 'llamada'); $('#lplace').textContent = kind === 'visita' ? 'Dirección' : 'Lugar o enlace de videollamada';
    $('#minutes').placeholder = m.min; $('#free').classList.toggle('hidden', !!$('#other').value);
    const t = $('#tips'); if (t) t.innerHTML = `<ol>${(TIPS[$('#motive').value] || TIPS.otro).map(x => `<li>${h(x)}</li>`).join('')}</ol>`;
  };
  $('#kseg').querySelectorAll('button').forEach(b => b.onclick = () => { kind = b.dataset.k; sync(); });
  $('#motive').onchange = sync; $('#other').onchange = sync; sync();
  $('#f').onsubmit = async e => {
    e.preventDefault(); const body = { ...Object.fromEntries(new FormData(e.target)), kind, id: isNew ? undefined : id, parent_id: q.get('parent') || undefined };
    try { const r = await api('/agenda', { body }); if (isNew && q.get('alerta')) await api(`/alerts/${q.get('alerta')}/agendado`, { body: { cita_id: r.id } }).catch(() => { }); toast('Guardado en la agenda'); location.hash = '#cita/' + r.id; if (!isNew) render(); } catch (x) { $('#err').textContent = x.message; }
  };
  const del = $('#del'); if (del) del.onclick = async () => { if (!confirm('¿Borrar esta cita?')) return; await api('/agenda/' + id, { method: 'DELETE' }); location.hash = '#agenda'; };
  if (!isNew && !done) {
    let result = null;
    document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      result = b.dataset.r; document.querySelectorAll('[data-r]').forEach(x => x.classList.toggle('on', x === b)); $('#rsave').disabled = false;
      const nx = M.results[result].next; $('#nextbox').classList.toggle('hidden', !nx);
      if (nx) { $('#nkind').value = nx[1]; $('#nmotive').value = nx[0] || a.motive; const d = new Date(); d.setDate(d.getDate() + nx[2]); d.setHours(10, 0, 0, 0); $('#nstart').value = localDT(d); }
    });
    $('#rsave').onclick = async () => {
      const body = { result, result_notes: $('#rnotes').value };
      if (!$('#nextbox').classList.contains('hidden') && $('#donext').checked) body.next = { kind: $('#nkind').value, motive: $('#nmotive').value, start: $('#nstart').value, notes: `Viene de: ${M.kinds[a.kind]} del ${a.start.slice(0, 10)} (${M.results[result].t}). ${$('#rnotes').value}`.trim() };
      try { const r = await api(`/agenda/${id}/resultado`, { body }); toast(r.next ? 'Resultado guardado y siguiente paso en la agenda' : 'Resultado guardado'); location.hash = r.next ? '#cita/' + r.next : '#agenda'; } catch (x) { toast(x.message); }
    };
    $('#bpost').onclick = async () => { try { await api(`/agenda/${id}/aplazar`, { body: { start: $('#post').value } }); toast('Aplazada'); render(); } catch (x) { toast(x.message); } };
    $('#bcancel').onclick = async () => { if (!confirm('¿Cancelar esta cita?')) return; await api(`/agenda/${id}/resultado`, { body: { status: 'cancelada', result_notes: $('#rnotes').value } }); toast('Cancelada'); location.hash = '#agenda'; };
  }
}
