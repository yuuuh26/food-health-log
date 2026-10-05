const CACHE_NAME = "food-health-log-v1.1.1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./app.js",
  "./db.js",
  "./cloud.js",
  "./cloud-snapshot.js",
  "./schema.js",
  "./import-export.js",
  "./icon-v1-192.png",
  "./icon-v1-512.png",
  "./icon-v1-maskable-192.png",
  "./icon-v1-maskable-512.png",
  "./apple-touch-icon-v1-180.png",
  "./favicon-v1-48.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("food-health-log-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith("/v1/")) return;
  const allowed = new Set(APP_SHELL.map(p => new URL(p, self.location.href).href));
  if (!allowed.has(requestUrl.href)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (!response || response.status !== 200) return response;
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match("./index.html")))
  );
});

