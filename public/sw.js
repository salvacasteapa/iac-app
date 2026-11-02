// Service worker: recibe los avisos push aunque la app esté cerrada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Aviso', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Aviso', { body: d.body || '', tag: d.tag, data: { url: d.url || '/app#avisos' }, icon: '/icon-192.png', badge: '/icon-192.png', renotify: true }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/app#avisos', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (c.url.includes('/app')) { await c.focus(); c.navigate(url); return; }
    await self.clients.openWindow(url);
  })());
});
