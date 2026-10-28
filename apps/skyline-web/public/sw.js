const CACHE_NAME = 'skyline-shell-v1';

self.addEventListener('install', (event) => {
  const base = self.registration.scope;
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll([base, `${base}manifest.webmanifest`, `${base}skyline-icon.svg`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(self.registration.scope, copy));
          return response;
        })
        .catch(async () => (await caches.match(self.registration.scope)) || Response.error()),
    );
    return;
  }

  if (url.pathname.includes('/assets/') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.webmanifest')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
        return cached || network;
      }),
    );
  }
});
