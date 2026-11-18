/* FindCNG Nigeria — service worker. Offline cache for the app shell and the
   station list, so the directory works with patchy signal at a station.
   API calls are never cached: live reports must always be fresh.
   BUMP CACHE ON EVERY RELEASE: the fetch handler is cache-first for the
   shell, so a returning visitor keeps the old shell until the service
   worker file itself changes. (18 Nov 2026: 2.3 shipped without a bump
   and Saheed's phone showed no updates at all until the tab was closed
   and reopened.) Station DATA (/data/*.json) is network-first instead:
   it changes on every release, and stale-while-revalidate kept serving
   the old stations.json after an update until a second reload — Saheed
   saw the old "Approximate location" badge for CNG-038 for that reason
   (18 Nov 19:59 WAT). Network-first still falls back to the cache
   offline, so the directory keeps working with no signal. */
const CACHE = "findcng-v2.4.2"; // bumped 18 Nov 2026 — refuelling gap batch: CNG-717 Rolling Energy Tamburawa newly tagged (466 on the map); all 134 refuelling stations now verified
const SHELL = [
  "index.html", "admin.html", "manifest.json",
  "css/style.css", "css/leaflet.css",
  "js/leaflet.js", "js/data.js", "js/postcode.js", "js/app.js", "js/chat.js", "js/news.js",
  "data/stations.json", "data/postcodes.json", "data/stats.json", "data/news-seed.json",
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
  // Station data changes on every release: network first, so a reload
  // always shows the newest pins and badges; cache only as the offline
  // fallback. (Stale-while-revalidate here kept showing the previous
  // release's data until a second reload — 18 Nov 2026, CNG-038.)
  if (url.pathname.startsWith("/data/") && url.pathname.endsWith(".json")) {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok && url.origin === self.location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
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
