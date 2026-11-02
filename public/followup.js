// Seguimiento escalado y avisos en tiempo real para el responsable y el gerente.
const LV_CLS = { 1: 'mute', 2: 'wait', 3: 'warn', 4: 'no' };
const OUT = { ganado: ['Ganada', 'ok'], perdido: ['Perdida', 'no'], standby: ['En espera', 'wait'] };
const NOTIFY_T = { nadie: 'Solo queda registrado', responsable: 'Avisa al comercial responsable', responsable_gerente: 'Avisa al responsable y al gerente' };
const ACT_T = { nada: 'Nada', llamada: 'Llamada', reunion: 'Reunión' };
const lvPill = (lv, name) => `<span class="pill lv${lv}">N${lv}${name ? ' · ' + h(name) : ''}</span>`;

/** Enlace a una cita nueva rellenada con los datos del aviso. */
function citaFromAlert(a, kind) {
  const d = new Date(); d.setDate(d.getDate() + (a.suggest_days || 0)); d.setHours(a.suggest_days ? 10 : Math.min(18, d.getHours() + 1), 0, 0, 0);
  const motive = a.outcome === 'ganado' ? (kind === 'reunion' ? 'revision' : 'postventa') : a.title.includes('persona') ? 'oferta' : 'seguimiento_oferta';
  const p = { kind, motive, start: localDT(d), notes: `${a.title}. ${a.summary || ''}`, alerta: a.id };
  if (a.other_id) p.other_id = a.other_id; else if (a.other_name) p.contact_company = a.other_name;
  if (a.product_id) p.product_id = a.product_id; if (a.owner_id) p.user = a.owner_id;
  return '#cita/nueva?' + new URLSearchParams(p);
}
const alertLink = a => a.deal_id ? '#operacion/' + a.deal_id : a.ext_id ? '#externo/' + a.ext_id : '#avisos';
function alertActions(a) {
  if (a.status === 'agendado') return `<a class="btn" href="#cita/${a.cita_id}">Ver cita</a>`;
  if (a.status === 'descartado') return '';
  const sk = a.suggest_kind;
  return `<a class="btn ${sk === 'llamada' ? 'p' : ''}" href="${citaFromAlert(a, 'llamada')}">Agendar llamada</a><a class="btn ${sk === 'reunion' ? 'p' : ''}" href="${citaFromAlert(a, 'reunion')}">Agendar reunión</a><button data-dis="${a.id}">No hace falta</button>`;
}

// ---------------- avisos en tiempo real ----------------
let ALERT_TIMER = null; const ALERT_SEEN = new Set();
function startAlerts() {
  if (ALERT_TIMER) return;
  const tick = async () => {
    if (!ME || document.hidden) return;
    let list = []; try { list = await api('/alerts/unread'); } catch { return; }
    const fresh = list.filter(a => !ALERT_SEEN.has(a.id)).reverse();
    const first = ALERT_SEEN.size === 0 && !ALERT_TIMER.started; ALERT_TIMER.started = true;
    list.forEach(a => ALERT_SEEN.add(a.id));
    const b = document.querySelector('a.nav[href="#avisos"]');
    if (b) { b.querySelector('.badge')?.remove(); if (list.length) b.insertAdjacentHTML('beforeend', `<span class="badge">${list.length}</span>`); }
    if (route().r === 'avisos') return; // ya los está viendo en la página
    if (first && fresh.length > 3) { popAlert({ id: 0, level: 2, outcome: 'standby', title: `Tienes ${fresh.length} avisos sin leer`, summary: 'Revísalos en Avisos.' }); return; }
    fresh.forEach(popAlert);
  };
  ALERT_TIMER = setInterval(tick, 15000); ALERT_TIMER.started = false; tick();
}
function popAlert(a) {
  let box = $('#pops'); if (!box) { document.body.insertAdjacentHTML('beforeend', '<div id="pops"></div>'); box = $('#pops'); }
  const el = document.createElement('div'); el.className = `pop lv${a.level}`;
  el.innerHTML = `<button class="x" aria-label="Cerrar">×</button><div class="pt">${a.id ? lvPill(a.level) + ' ' : ''}<span class="pill ${OUT[a.outcome][1]}">${OUT[a.outcome][0]}</span></div>
    <b>${h(a.title)}</b><div class="muted">${h(a.summary || '')}</div>${a.suggest_kind ? `<div class="sugg">Propuesta: ${ACT_T[a.suggest_kind].toLowerCase()} ${a.suggest_days ? `en ${a.suggest_days} día${a.suggest_days > 1 ? 's' : ''}` : 'hoy'}</div>` : ''}
    <div class="btns">${a.id ? `<a class="btn" href="${alertLink(a)}">Ver</a>${alertActions(a)}` : '<a class="btn p" href="#avisos">Ver avisos</a>'}</div>`;
  box.prepend(el);
  const close = () => { el.remove(); if (a.id) api(`/alerts/${a.id}/leido`, { body: {} }).catch(() => { }); };
  el.querySelector('.x').onclick = close;
  el.querySelectorAll('a').forEach(x => x.addEventListener('click', () => setTimeout(close, 50)));
  const dis = el.querySelector('[data-dis]'); if (dis) dis.onclick = async () => { await api(`/alerts/${a.id}/descartar`, { body: {} }); el.remove(); };
  if (a.level >= 3 && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(a.title, { body: a.summary || '' }); } catch { } }
  if (a.level < 3) setTimeout(() => el.isConnected && el.remove(), 20000);
}

// ---------------- página de avisos y seguimiento ----------------
async function viewAvisos() {
  await shell('avisos', '<div id="c"></div>');
  const tab = route().q.get('ver') || 'avisos';
  const isAdm = ME.user.is_admin;
  document.querySelectorAll('#pops .pop').forEach(x => x.remove());
  const tabs = `<div><div class="seg" style="margin-bottom:14px">${[['avisos', 'Avisos'], isSeller() && ['clientes', 'Niveles por cliente'], ['reglas', 'Reglas de seguimiento']].filter(Boolean).map(([k, t]) => `<a class="${tab === k ? 'on' : ''}" href="#avisos?ver=${k}">${t}</a>`).join('')}</div></div>`;
  const head = `<h1>Avisos y seguimiento</h1><p class="lead">No todos los pedidos necesitan la misma atención. Cada operación recibe un nivel (por cliente y por importe) y, según el nivel y si se ha ganado, perdido o está en espera, avisa en el momento a quien corresponde y propone una llamada o una reunión.</p>${tabs}`;
  const F = await api('/followup').catch(() => null);
  const S = F?.settings;
  if (tab === 'clientes' && F) {
    $('#c').innerHTML = head + `<div class="card"><h2>Nivel de atención y responsable por cliente</h2><p class="hint">El nivel del cliente es el mínimo para todas sus operaciones. El importe puede subirlo.</p>
     ${F.clients.length ? `<div style="overflow-x:auto"><table><tr><th>Cliente</th><th class="n">Pedidos</th><th class="n">Facturado</th><th>Nivel</th><th>Responsable</th><th>Notas</th><th></th></tr>${F.clients.map(c => `<tr data-b="${c.id}">
       <td>${clogo(c)}${h(c.name)}</td><td class="n">${c.orders}</td><td class="n">${eur(c.revenue)}</td>
       <td><select name="level" ${isAdm ? '' : 'disabled'}>${[1, 2, 3, 4].map(k => `<option value="${k}" ${c.level === k ? 'selected' : ''}>N${k} · ${h(S.levels[k].name)}</option>`).join('')}</select></td>
       <td><select name="owner_id" ${isAdm ? '' : 'disabled'}><option value="">— (avisa al gerente)</option>${F.users.map(u => `<option value="${u.id}" ${c.owner_id === u.id ? 'selected' : ''}>${h(u.name || u.email)}</option>`).join('')}</select></td>
       <td><input name="notes" value="${h(c.notes)}" placeholder="Ej.: cuenta clave" ${isAdm ? '' : 'disabled'}></td><td>${isAdm ? '<button class="sv">Guardar</button>' : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">Aún no tienes clientes conectados.</p>'}</div>`;
    document.querySelectorAll('tr[data-b] .sv').forEach(b => b.onclick = async () => { const tr = b.closest('tr'); const body = { buyer_id: tr.dataset.b, ...Object.fromEntries([...tr.querySelectorAll('select,input')].map(i => [i.name, i.value])) };
      try { await api('/followup/client', { body }); toast('Guardado'); } catch (e) { toast(e.message); } });
    return;
  }
  if (tab === 'reglas' && S) {
    $('#c').innerHTML = head + `<form id="fr"><div class="card"><h2>Niveles</h2><div style="overflow-x:auto"><table class="rules"><tr><th>Nivel</th><th>Nombre</th><th>A quién avisa</th><th>Sube a este nivel desde</th></tr>
      ${[1, 2, 3, 4].map(k => `<tr><td>${lvPill(k)}</td><td><input name="name${k}" value="${h(S.levels[k].name)}"></td><td><select name="notify${k}">${Object.entries(NOTIFY_T).map(([v, t]) => `<option value="${v}" ${S.levels[k].notify === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td>${k === 1 ? '<span class="muted">Base</span>' : `<div class="inl"><input name="imp${k}" type="number" min="0" step="100" value="${S.importe[k] ?? ''}" placeholder="Sin límite"><span>€</span></div>`}</td></tr>`).join('')}</table></div>
      <label class="chk"><input type="checkbox" name="perdida_sube" ${S.perdida_sube ? 'checked' : ''}><span>Una operación perdida sube un nivel<small>Perder un pedido merece más atención que ganarlo.</small></span></label></div>
     <div class="card"><h2>Qué proponer según el resultado</h2><p class="hint">El gerente o el responsable decide con un clic si lo agenda.</p><div style="overflow-x:auto"><table class="rules"><tr><th>Nivel</th>${Object.entries(OUT).map(([, [t]]) => `<th>${t}</th>`).join('')}</tr>
      ${[1, 2, 3, 4].map(k => `<tr><td>${lvPill(k, S.levels[k].name)}</td>${Object.keys(OUT).map(o => `<td><div class="inl"><select name="a${k}${o}">${Object.entries(ACT_T).map(([v, t]) => `<option value="${v}" ${S.acciones[k][o][0] === v ? 'selected' : ''}>${t}</option>`).join('')}</select><span>en</span><input name="d${k}${o}" type="number" min="0" max="90" value="${S.acciones[k][o][1]}" style="width:64px"><span>días</span></div></td>`).join('')}</tr>`).join('')}</table></div>
      ${isAdm ? '<div class="btns"><button class="p">Guardar reglas</button></div>' : '<p class="muted">Solo el administrador puede cambiar las reglas.</p>'}</div></form>
     <div class="card"><h2>Avisos en este navegador</h2><p class="hint">Recibe una notificación del sistema cuando llegue un aviso de nivel 3 o 4, aunque estés en otra pestaña.</p><div class="btns"><button id="perm">${'Notification' in window && Notification.permission === 'granted' ? 'Activadas ✔' : 'Activar notificaciones'}</button></div></div>`;
    $('#perm').onclick = async () => { if (!('Notification' in window)) return toast('Este navegador no permite notificaciones'); const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Notificaciones activadas' : 'No se han activado'); render(); };
    $('#fr').onsubmit = async e => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const body = { levels: {}, acciones: {}, importe: {}, perdida_sube: !!f.perdida_sube };
      for (const k of [1, 2, 3, 4]) { body.levels[k] = { name: f['name' + k], notify: f['notify' + k] }; body.acciones[k] = {}; for (const o of Object.keys(OUT)) body.acciones[k][o] = [f[`a${k}${o}`], f[`d${k}${o}`]]; if (k > 1) body.importe[k] = f['imp' + k]; }
      try { await api('/followup/settings', { method: 'PUT', body }); toast('Reglas guardadas'); } catch (x) { toast(x.message); }
    };
    return;
  }
  const list = await api('/alerts');
  const filt = route().q.get('f') || 'pend';
  const shown = list.filter(a => filt === 'todos' || (filt === 'pend' ? a.status === 'nuevo' : a.outcome === filt));
  const ST = { nuevo: ['Por decidir', 'wait'], agendado: ['Agendado', 'ok'], descartado: ['Descartado', 'mute'], registrado: ['Solo registro', 'mute'] };
  $('#c').innerHTML = head + `<div><div class="seg" style="margin-bottom:14px;flex-wrap:wrap">${[['pend', 'Por decidir'], ['ganado', 'Ganadas'], ['perdido', 'Perdidas'], ['standby', 'En espera'], ['todos', 'Todos']].map(([k, t]) => `<a class="${filt === k ? 'on' : ''}" href="#avisos?f=${k}">${t}${k === 'pend' ? ` (${list.filter(a => a.status === 'nuevo').length})` : ''}</a>`).join('')}</div></div>
    ${shown.length ? shown.map(a => `<div class="alert lv${a.level} ${a.read ? '' : 'unread'}"><div class="al-h">${lvPill(a.level, S?.levels[a.level]?.name)} <span class="pill ${OUT[a.outcome][1]}">${OUT[a.outcome][0]}</span> <span class="pill ${ST[a.status][1]}">${ST[a.status][0]}</span><span class="muted" style="margin-left:auto">${new Date(a.created).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
      <a href="${alertLink(a)}" class="al-t">${h(a.title)}</a><div class="muted">${h(a.summary || '')}${a.owner ? ` · Responsable: ${h(a.owner.name || a.owner.email)}` : ''}${a.decided_by ? ` · Decidió: ${h(a.decided_by)}` : ''}</div>
      ${a.suggest_kind && a.status === 'nuevo' ? `<div class="sugg">Propuesta según el nivel: ${ACT_T[a.suggest_kind].toLowerCase()} ${a.suggest_days ? `en ${a.suggest_days} día${a.suggest_days > 1 ? 's' : ''}` : 'hoy'}</div>` : ''}
      <div class="btns">${alertActions(a)}</div></div>`).join('') : '<div class="card empty"><p class="muted">No hay avisos aquí.</p></div>'}`;
  document.querySelectorAll('[data-dis]').forEach(b => b.onclick = async () => { await api(`/alerts/${b.dataset.dis}/descartar`, { body: {} }); render(); });
  list.filter(a => !a.read && a.for_me).forEach(a => api(`/alerts/${a.id}/leido`, { body: {} }).catch(() => { }));
}
