/* Service worker : reception des notifications Web Push et cache applicatif minimal. */
const CACHE = 'alerte-incendie-v5';
const CACHE_TUILES = 'alerte-incendie-tuiles-v1';
const MAX_TUILES = 150;
const STATIQUE = ['./', './index.html', './confidentialite.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIQUE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(
        cles.filter((k) => k !== CACHE && k !== CACHE_TUILES).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/* Reseau d'abord pour l'API (donnees temps reel), cache de secours pour le statique. */
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.pathname.includes('/functions/v1/')) return;
  if (u.hostname === 'data.geopf.fr') {
    e.respondWith(
      caches.open(CACHE_TUILES).then(async (cache) => {
        const connue = await cache.match(e.request);
        const reseau = fetch(e.request).then(async (r) => {
          if (r.ok) {
            await cache.put(e.request, r.clone());
            const cles = await cache.keys();
            await Promise.all(cles.slice(0, Math.max(0, cles.length - MAX_TUILES))
              .map((requete) => cache.delete(requete)));
          }
          return r;
        }).catch(() => connue || Response.error());
        return connue || reseau;
      }),
    );
    return;
  }
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
