/* Service worker : reception des notifications Web Push et cache applicatif minimal. */
const CACHE = 'alerte-incendie-v1';
const STATIQUE = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIQUE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* Reseau d'abord pour l'API (donnees temps reel), cache de secours pour le statique. */
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.pathname.includes('/functions/v1/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && u.origin === location.origin) {
          const copie = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copie));
        }
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { titre: 'Alerte incendie', corps: e.data && e.data.text() }; }

  const critique = d.severite === 'critique';
  e.waitUntil(
    self.registration.showNotification(d.titre || 'Alerte incendie', {
      body: d.corps || '',
      tag: d.url || 'alerte',
      renotify: true,
      requireInteraction: critique,
      silent: false,
      vibrate: critique ? [300, 120, 300, 120, 300] : [200, 100, 200],
      icon: './icone-192.png',
      badge: './icone-192.png',
      data: d,
      actions: [{ action: 'ouvrir', title: 'Ouvrir la carte' }],
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const cible = new URL(e.notification.data && e.notification.data.url || './', self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((liste) => {
      for (const c of liste) if ('focus' in c) return c.focus();
      return self.clients.openWindow(cible);
    }),
  );
});
