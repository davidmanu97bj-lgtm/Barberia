const CACHE_PREFIX = "explora-shell";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX))
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// La aplicación sigue trabajando primero contra la red. Así los cambios de
// login y de caja se reciben sin quedar atrapados en una versión anterior.
self.addEventListener("fetch", () => {});
