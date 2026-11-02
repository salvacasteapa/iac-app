// Integraciones: SAP Business One, API y webhooks, importar y exportar con Excel.
const INT_TABS = [['sap', 'SAP Business One'], ['api', 'API y avisos a otros sistemas'], ['excel', 'Excel']];

async function viewIntegraciones() {
  await shell('integraciones', '<div id="c"></div>');
  if (!ME.user.is_admin) { $('#c').innerHTML = '<h1>Integraciones</h1><div class="banner info">Solo el administrador de la empresa puede configurar las integraciones.</div>'; return; }
  const tab = INT_TABS.some(([k]) => k === route().q.get('ver')) ? route().q.get('ver') : 'sap';
  const head = `<h1>Integraciones</h1><p class="lead">Conecta IAC con tu programa de gestión o tu CRM para no teclear dos veces: artículos, precios, stock y clientes entran solos, y los pedidos cerrados salen solos.</p>
    <div class="seg" style="margin-bottom:14px">${INT_TABS.map(([k, t]) => `<a class="${tab === k ? 'on' : ''}" href="#integraciones?ver=${k}">${t}</a>`).join('')}</div>`;
  return tab === 'api' ? intApi(head) : tab === 'excel' ? intExcel(head) : intSap(head);
}

async function intSap(head) {
  const D = await api('/erp/sapb1'), c = D.config, sell = isSeller(), buy = isBuyer();
  const ck = (n, t, help, on = c[n]) => `<label class="chk"><input type="checkbox" name="${n}" ${on ? 'checked' : ''}><span>${t}${help ? `<small>${help}</small>` : ''}</span></label>`;
  const st = !c.url ? '<span class="pill mute">Sin configurar</span>' : c.active ? '<span class="pill ok">Activo</span>' : '<span class="pill wait">Pausado</span>';
  $('#c').innerHTML = head + `
   <div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0">SAP Business One</h2>${st}
     ${c.last_sync ? `<span class="muted">Última sincronización: ${fdate(c.last_sync)} ${new Date(c.last_sync).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} ${c.last_status === 'ok' ? '✔' : '✖'}</span>` : ''}</div>
     ${c.last_status === 'error' && c.last_error ? `<div class="note warn" style="margin-top:10px">${h(c.last_error)}</div>` : ''}
     <p class="hint">IAC se conecta al <b>Service Layer</b> de tu SAP B1 (la API oficial de SAP). Tu partner de SAP te da la dirección y un usuario. El Service Layer tiene que ser accesible desde internet por https; si está solo en tu red, tu partner puede publicarlo de forma segura.</p>
     <form id="fs"><div class="row"><div style="flex:2"><label>Dirección del Service Layer</label><input name="url" value="${h(c.url)}" placeholder="https://miservidor.miempresa.es:50000/b1s/v1" required></div>
       <div><label>Base de datos de la empresa</label><input name="company_db" value="${h(c.company_db)}" placeholder="SBO_MIEMPRESA" required></div></div>
      <div class="row"><div><label>Usuario de SAP B1</label><input name="username" value="${h(c.username)}" autocomplete="off" required></div>
       <div><label>Contraseña</label><input name="password" type="password" autocomplete="new-password" placeholder="${c.has_password ? '•••••••• (guardada; escribe solo para cambiarla)' : ''}" ${c.has_password ? '' : 'required'}></div></div>
      <p class="hint">La contraseña se guarda cifrada y no se vuelve a mostrar. Mejor un usuario de SAP solo para IAC, con permiso para leer artículos e interlocutores y crear pedidos.</p>
      ${ck('insecure', 'Aceptar certificado propio', 'Solo si tu servidor usa un certificado hecho por tu partner y no uno de una autoridad reconocida.')}
      <h3>Qué se sincroniza</h3>
      ${sell ? ck('sync_items', 'Traer artículos de SAP a mi catálogo', 'Grupos de artículos como familias, nombre, precio, stock, unidad y código de barras. Solo artículos de venta, activos y no bloqueados.') : ''}
      ${sell ? `<div class="row"><div><label>Lista de precios de SAP</label><input name="price_list" type="number" min="1" value="${c.price_list}"></div><div><label>Precio mínimo de artículos nuevos (% bajo lista)</label><input name="min_discount" type="number" step="0.5" min="0" max="90" value="${c.min_discount}"></div><div><label>Sincronizar cada (minutos)</label><input name="sync_minutes" type="number" min="15" value="${c.sync_minutes}"></div></div>` : `<input type="hidden" name="sync_minutes" value="${c.sync_minutes}">`}
      ${ck('sync_partners', `Enlazar mis ${sell && buy ? 'clientes y proveedores' : sell ? 'clientes' : 'proveedores'} con los de SAP por el NIF`, sell ? 'También trae el grupo de cliente de SAP, que podrás usar para enviar ofertas.' : '')}
      ${sell ? ck('push_sales', 'Crear en SAP un pedido de cliente por cada venta cerrada') : ''}
      ${buy ? ck('push_purchases', 'Crear en SAP un pedido de compra por cada compra cerrada', 'Usa tu código de artículo (el de «Códigos de artículo»), que debe ser tu código de SAP.') : ''}
      <div class="btns"><button class="p">Guardar</button><button type="button" id="bt" ${c.url ? '' : 'disabled'}>Probar conexión</button><button type="button" id="bs" ${c.url ? '' : 'disabled'}>Sincronizar ahora</button>
       ${c.url ? `<button type="button" id="ba" class="${c.active ? '' : 'ok'}">${c.active ? 'Pausar conector' : 'Activar conector'}</button>` : ''}</div><div class="err" id="err"></div></form></div>
   <div class="card"><h2>Empresas conectadas y su código en SAP</h2><p class="hint">Se rellenan solos al sincronizar si la empresa tiene el NIF puesto en IAC. Si no coincide, escribe aquí su código de interlocutor (CardCode).</p>
     ${D.partners.length ? `<div style="overflow-x:auto"><table><tr><th>Empresa</th><th>Relación</th><th>NIF en IAC</th><th>Código en SAP</th></tr>${D.partners.map(o => `<tr><td>${h(o.name)}</td><td>${o.rel}</td><td>${h(o.tax_id || '—')}</td>
       <td><input data-bp="${o.id}" value="${h(o.sap?.card_code || '')}" placeholder="Sin enlazar" style="max-width:160px">${o.sap?.card_name ? ` <span class="muted">${h(o.sap.card_name)}</span>` : ''}${o.sap && !o.sap.auto ? ' <span class="muted">(manual)</span>' : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">Aún no tienes empresas conectadas.</p>'}</div>
   <div class="grid"><div class="card"><h2>Pedidos enviados a SAP</h2>${D.docs.length ? `<table><tr><th>Pedido</th><th>En SAP</th><th></th></tr>${D.docs.map(d => `<tr><td><a href="#operacion/${d.deal_id}">nº ${d.deal_id}</a><div class="muted">${eur(d.total)}</div></td>
       <td>${d.status === 'ok' ? `<span class="pill ok">${d.doc_type === 'Orders' ? 'Pedido de cliente' : 'Pedido de compra'} ${d.doc_num ?? ''}</span>` : `<span class="pill no">Error</span><div class="muted" style="font-size:12.5px;max-width:320px">${h(d.error)}</div>`}</td>
       <td>${d.status === 'ok' ? '' : `<button data-re="${d.deal_id}">Reintentar</button>`}</td></tr>`).join('')}</table>` : '<p class="muted">Todavía ninguno.</p>'}</div>
     <div class="card"><h2>Actividad</h2>${D.log.length ? `<div class="log">${D.log.map(l => `<div><span class="pill ${l.status === 'ok' ? 'ok' : 'no'}">${l.status === 'ok' ? '✔' : '✖'}</span> <span class="muted">${fdate(l.created)} ${new Date(l.created).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span> ${h(l.message)}</div>`).join('')}</div>` : '<p class="muted">Sin actividad.</p>'}</div></div>`;
  const f = $('#fs');
  const save = async () => { const d = Object.fromEntries(new FormData(f)); for (const n of ['insecure', 'sync_items', 'sync_partners', 'push_sales', 'push_purchases']) d[n] = !!f[n]?.checked; if (!sell) { d.sync_items = false; d.push_sales = false; } if (!buy) d.push_purchases = false; await api('/erp/sapb1', { method: 'PUT', body: d }); };
  f.onsubmit = async e => { e.preventDefault(); try { await save(); toast('Guardado'); render(); } catch (x) { $('#err').textContent = x.message; } };
  const run1 = (id, fn) => { const b = $(id); if (b) b.onclick = async () => { b.disabled = true; $('#err').textContent = ''; try { await fn(); } catch (x) { $('#err').textContent = x.message; } b.disabled = false; }; };
  run1('#bt', async () => { const r = await api('/erp/sapb1/probar', { body: {} }); toast(`Conexión correcta${r.articulos != null ? ` · ${r.articulos} artículos y ${r.interlocutores} interlocutores en SAP` : ''}`); render(); });
  run1('#bs', async () => { $('#err').textContent = 'Sincronizando con SAP B1…'; const r = await api('/erp/sapb1/sincronizar', { body: {} }); toast(`Sincronizado${r.articulos ? `: ${r.articulos.creados} artículos nuevos y ${r.articulos.actualizados} actualizados` : ''}`); render(); });
  run1('#ba', async () => { await api('/erp/sapb1/activar', { body: { active: !c.active } }); toast(c.active ? 'Conector pausado' : 'Conector activado'); render(); });
  document.querySelectorAll('[data-bp]').forEach(i => i.onchange = async () => { try { await api('/erp/sapb1/interlocutor', { body: { other_id: i.dataset.bp, card_code: i.value } }); toast('Guardado'); } catch (e) { toast(e.message); } });
  document.querySelectorAll('[data-re]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api('/erp/sapb1/reenviar/' + b.dataset.re, { body: {} }); toast('Enviado a SAP'); } catch (e) { toast(e.message); } render(); });
}

async function intApi(head) {
  const [keys, W] = await Promise.all([api('/integraciones/claves'), api('/integraciones/webhooks')]);
  const live = keys.filter(k => !k.revoked), base = location.origin;
  $('#c').innerHTML = head + `
   <div class="card"><h2>Claves de API</h2><p class="hint">Con una clave, otro programa (tu CRM, tu ERP, Zapier, Make…) puede trabajar con IAC en nombre de tu empresa. Trátala como una contraseña.</p>
     <div id="newkey"></div>
     ${live.length ? `<table><tr><th>Nombre</th><th>Clave</th><th>Creada</th><th>Último uso</th><th></th></tr>${live.map(k => `<tr><td>${h(k.name)}</td><td><code class="k">${h(k.prefix)}</code></td><td>${fdate(k.created)}</td><td>${k.last_used ? fdate(k.last_used) : '—'}</td><td><button data-rk="${k.id}">Anular</button></td></tr>`).join('')}</table>` : '<p class="muted">No tienes claves.</p>'}
     <form id="fk" class="row" style="align-items:flex-end"><div><label>Para qué es</label><input name="name" placeholder="Ej.: CRM, Zapier" required></div><div><button class="p">Crear clave</button></div></form></div>
   <div class="card"><h2>Avisos a otros sistemas (webhooks)</h2><p class="hint">IAC llama a la dirección que pongas cada vez que pasa algo. Sirve para Zapier o Make (disparador «Webhook»), tu CRM o un programa propio. Cada aviso va firmado con la clave secreta.</p>
     <div id="newsec"></div>
     ${W.hooks.length ? `<div style="overflow-x:auto"><table><tr><th>Dirección</th><th>Eventos</th><th>Estado</th><th></th></tr>${W.hooks.map(w => `<tr><td style="word-break:break-all">${h(w.url)}${w.log.length ? `<div class="muted" style="font-size:12.5px">${w.log.slice(0, 3).map(l => `${l.status === 'ok' ? '✔' : '✖'} ${h(l.event)} ${l.code || ''} ${h(l.error || '')}`).join('<br>')}</div>` : ''}</td>
       <td style="font-size:13px">${w.events.map(e => h(W.events[e] || e)).join('<br>')}</td><td>${w.active ? '<span class="pill ok">Activo</span>' : '<span class="pill no">Pausado</span>'}${w.fails ? `<div class="muted">${w.fails} fallos seguidos</div>` : ''}</td>
       <td style="white-space:nowrap"><button data-tw="${w.id}">Probar</button> <button data-pw="${w.id}" data-a="${w.active ? 'pausar' : 'activar'}">${w.active ? 'Pausar' : 'Activar'}</button> <button data-dw="${w.id}">Borrar</button></td></tr>`).join('')}</table></div>` : ''}
     <form id="fw"><label>Dirección que recibirá los avisos</label><input name="url" placeholder="https://hooks.zapier.com/hooks/catch/…" required>
      <label>Eventos</label><div class="evs">${Object.entries(W.events).map(([k, t]) => `<label class="chk"><input type="checkbox" name="ev" value="${k}" ${k.startsWith('pedido.') ? 'checked' : ''}><span>${h(t)}<small>${k}</small></span></label>`).join('')}</div>
      <div class="btns"><button class="p">Añadir</button></div><div class="err" id="errw"></div></form></div>
   <div class="card"><h2>Instrucciones para tu informático o tu partner</h2>
     <p>Todas las peticiones llevan la cabecera <code class="k">Authorization: Bearer iac_…</code>. Las respuestas son JSON. Las rutas más útiles para conectar un ERP o un CRM:</p>
     <table class="doc"><tr><td><code>POST /api/v1/articulos/lote</code></td><td>Crea o actualiza artículos por código: <code>[{"codigo","nombre","familia","precio_lista","precio_minimo","coste","stock","plazo","unidad","ean"}]</code>. Al actualizar solo cambia lo que envíes (por ejemplo, solo el stock).</td></tr>
       <tr><td><code>POST /api/v1/clientes/lote</code></td><td>Pone grupo y nivel de atención a tus clientes conectados, por código IAC o NIF: <code>[{"nif","grupo","nivel"}]</code>.</td></tr>
       <tr><td><code>GET /api/v1/pedidos?desde=2026-11-01</code></td><td>Pedidos cerrados (de venta y de compra) con los dos códigos de artículo, NIF de cada empresa, cantidad, precio y plazo. <code>estado=pendiente|todos</code> para ver otros.</td></tr>
       <tr><td><code>GET /api/v1/clientes</code></td><td>Clientes conectados con su NIF, grupo y nivel.</td></tr>
       <tr><td><code>POST /api/needs</code></td><td>Lanza una compra: tu asistente negocia con tus proveedores. <code>{"buyer_code","qty","target_price","max_price","max_days"}</code>. Útil para que el ERP pida solo al llegar al punto de pedido.</td></tr>
       <tr><td><code>GET /api/exportar/pedidos.csv</code></td><td>Los mismos pedidos en CSV para Excel.</td></tr></table>
     <p class="hint">Webhooks: cada aviso es un POST con <code>{"id","event","created","company_id","data"}</code> y la cabecera <code>X-IAC-Signature: t=…,v1=…</code>, que es HMAC-SHA256 de <code>t + "." + cuerpo</code> con tu clave secreta. Si tu sistema no responde 2xx, IAC lo reintenta 3 veces; tras 20 fallos seguidos lo pausa.</p>
     <p class="hint">Ejemplo: <code>curl -H "Authorization: Bearer iac_…" ${h(base)}/api/v1/pedidos</code></p></div>`;
  $('#fk').onsubmit = async e => { e.preventDefault(); const r = await api('/integraciones/claves', { body: Object.fromEntries(new FormData(e.target)) });
    $('#newkey').innerHTML = `<div class="note ok"><b>Copia tu clave ahora: no se volverá a mostrar.</b><input readonly value="${h(r.key)}" id="kv" style="margin-top:8px;font-family:ui-monospace,monospace"><div class="btns"><button id="kc">Copiar</button><button id="kok">Ya la he guardado</button></div></div>`;
    $('#kc').onclick = async () => { try { await navigator.clipboard.writeText(r.key); toast('Copiada'); } catch { $('#kv').select(); } }; $('#kok').onclick = () => render(); };
  document.querySelectorAll('[data-rk]').forEach(b => b.onclick = async () => { if (!confirm('¿Anular esta clave? Los programas que la usen dejarán de funcionar.')) return; await api('/integraciones/claves/' + b.dataset.rk, { method: 'DELETE' }); render(); });
  $('#fw').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.target);
    try { const r = await api('/integraciones/webhooks', { body: { url: fd.get('url'), events: fd.getAll('ev') } });
      $('#newsec').innerHTML = `<div class="note ok"><b>Clave secreta para comprobar la firma (no se volverá a mostrar):</b> <code class="k">${h(r.secret)}</code> <button id="sok">Hecho</button></div>`; $('#sok').onclick = () => render(); }
    catch (x) { $('#errw').textContent = x.message; } };
  document.querySelectorAll('[data-tw]').forEach(b => b.onclick = async () => { b.disabled = true; try { await api(`/integraciones/webhooks/${b.dataset.tw}/probar`, { body: {} }); toast('Ha respondido bien'); } catch (e) { toast(e.message); } render(); });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = async () => { await api(`/integraciones/webhooks/${b.dataset.pw}/${b.dataset.a}`, { body: {} }); render(); });
  document.querySelectorAll('[data-dw]').forEach(b => b.onclick = async () => { if (!confirm('¿Borrar este aviso?')) return; await api('/integraciones/webhooks/' + b.dataset.dw, { method: 'DELETE' }); render(); });
}

async function intExcel(head) {
  const sell = isSeller();
  const tpl = { articulos: 'codigo;nombre;familia;precio_lista;precio_minimo;coste;stock;plazo;unidad;ean\r\nTOR-M8;Tornillo inox M8;Tornillería;6,80;5,40;4,10;1000;3;ud;8412345678905\r\n', clientes: 'nif;grupo;nivel\r\nB12345678;Industria;2\r\n' };
  const dl = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name; a.click(); };
  $('#c').innerHTML = head + `<div class="grid">
   ${sell ? `<div class="card"><h2>Importar artículos</h2><p class="hint">Desde Excel: <b>Archivo › Guardar como › CSV (delimitado por punto y coma)</b>. Si el código ya existe se actualiza solo lo que traiga el archivo; si no existe, se da de alta (hacen falta nombre y precio de lista). Las familias que no existan se crean.</p>
     <div class="btns"><button data-tpl="articulos">Descargar plantilla</button><a class="btn" href="/api/exportar/articulos.csv">Exportar mi catálogo</a></div>
     <input type="file" accept=".csv,text/csv" data-imp="articulos"><div class="res" id="res-articulos"></div></div>
    <div class="card"><h2>Grupos y niveles de clientes</h2><p class="hint">Columnas <b>nif</b> (o <b>codigo_empresa</b> de IAC), <b>grupo</b> y <b>nivel</b> (1 a 4). Solo para clientes ya conectados.</p>
     <div class="btns"><button data-tpl="clientes">Descargar plantilla</button></div><input type="file" accept=".csv,text/csv" data-imp="clientes"><div class="res" id="res-clientes"></div></div>` : ''}
   <div class="card"><h2>Exportar pedidos</h2><p class="hint">Pedidos cerrados con los dos códigos, NIF, cantidades, precios y plazos. Se abre con Excel.</p>
     <label>Desde</label><input type="date" id="desde"><div class="btns"><button class="p" id="exp">Descargar pedidos</button></div></div></div>`;
  document.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => dl(`plantilla-${b.dataset.tpl}.csv`, tpl[b.dataset.tpl]));
  $('#exp').onclick = () => { const d = $('#desde').value; location.href = '/api/exportar/pedidos.csv' + (d ? '?desde=' + d : ''); };
  document.querySelectorAll('[data-imp]').forEach(i => i.onchange = async () => {
    const f = i.files[0]; if (!f) return; const out = $('#res-' + i.dataset.imp);
    const buf = await f.arrayBuffer(); let text = new TextDecoder('utf-8').decode(buf); if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
    try { const r = await api('/importar/' + i.dataset.imp, { body: { csv: text } });
      out.innerHTML = `<div class="note ${r.errores.length ? 'warn' : 'ok'}">${r.creados != null ? `${r.creados} nuevos · ` : ''}${r.actualizados} actualizados${r.errores.length ? ` · ${r.errores.length} con error:<br>${r.errores.slice(0, 15).map(e => `Fila ${e.fila}${e.codigo ? ' (' + h(e.codigo) + ')' : ''}: ${h(e.error)}`).join('<br>')}` : ''}</div>`; }
    catch (e) { out.innerHTML = `<div class="note warn">${h(e.message)}</div>`; }
    i.value = '';
  });
}
