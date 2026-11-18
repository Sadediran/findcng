/* FindCNG Nigeria — service worker. Offline cache for the app shell and the
   station list, so the directory works with patchy signal at a station.
   API calls are never cached: live reports must always be fresh. */
const CACHE = "findcng-v2";
const SHELL = [
  "index.html", "admin.html", "manifest.json",
  "css/style.css", "css/leaflet.css",
  "js/leaflet.js", "js/data.js", "js/postcode.js", "js/app.js",
  "data/stations.json", "data/postcodes.json", "data/stats.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // live data: network only
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request).then((r) => {
        if (r.ok && url.origin === self.location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
