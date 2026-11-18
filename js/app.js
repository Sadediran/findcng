/* FindCNG Nigeria — 2.0 app logic. Plain JS, no framework.
   Data: data/stations.json + data/stats.json (build-time, computed from the
   master dataset — never hardcoded).
   Reports: /api/reports (Supabase). NO demo mode: if the backend is
   unreachable the app says so honestly and saves nothing locally — a report
   the user thinks is shared must actually be shared. */
(function () {
  "use strict";
  const F = window.FINDCNG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  // "City, State" — or just "State" when the city is unknown (2.5: the
  // Pi-CNG API has no city field, so 14 API entries carry city null;
  // without this the render showed a dangling ", State").
  const locLabel = (s) => (s.city ? `${s.city}, ${s.state}` : `${s.state}`);

  // ---------------- state ----------------
  let stations = [];            // all entries from data/stations.json
  let stats = null;             // data/stats.json (build-time, computed)
  let dataLoaded = false;
  let reports = new Map();      // stationId -> latest fresh report {id,status,queue,pressure,compressor,ts}
  let reportsLive = false;      // true once /api/reports has answered OK
  let userLoc = null;           // { lat, lng, label }
  let map = null, clusterLayer = null, userMarker = null;
  let baseLayers = null;        // { satellite, street } tile layers for the main map
  let mapLayer = "satellite";   // current base layer kind; persisted as findcng_maplayer
  let tileFallbackArmed = true; // false once a tile-failure fallback has fired (re-armed by a manual switch)
  let currentStation = null;    // id open in the detail view
  let prevView = "map";
  let reportStatus = null;      // status picked in the report sheet
  let listingStation = null;    // id open in the listing-report sheet
  let listShown = 50, centresShown = 50;
  let sortMode = "nearest";
  let filters = { availableOnly: false, outagesOnly: false, types: new Set(), operators: new Set(), categories: new Set() };
  let favs = new Set();
  try { favs = new Set(JSON.parse(localStorage.getItem("findcng_favs") || "[]")); } catch { favs = new Set(); }
  let confirmCache = new Map(); // reportId -> {yes,unsure,no} | "not_open"
  let historyCache = new Map(); // stationId -> rows | null
  let safetyLang = "en";
  const safetyEn = {};          // English innerHTML, captured at init
  const FAV_KEY = "findcng_favs";
  const VEHICLE_KEY = "findcng_vehicle";

  // ---------------- helpers ----------------
  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtKm(km) { return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(1) + " km"; }
  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    return Math.floor(m / 60) + " hr " + (m % 60) + " min ago";
  }
  function naira(n) { return "₦" + Math.round(n).toLocaleString("en-NG"); }
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add("hidden"), 4200);
  }
  function statusOf(id) {
    const r = reports.get(id);
    if (!r) return "unconfirmed";
    return (Date.now() - r.ts <= F.REPORT_TTL_MS) ? r.status : "unconfirmed";
  }
  function statusBadge(id, withTime) {
    const st = statusOf(id);
    const s = F.STATUS[st];
    const r = reports.get(id);
    const t = (withTime && r && st !== "unconfirmed") ? " · " + timeAgo(r.ts) : "";
    return `<span class="badge ${st}"><span class="dot ${st}"></span>${s.label}${t}</span>`;
  }
  function typeBadge(t) { return `<span class="badge type">${F.TYPE_LABEL[t] || t}</span>`; }
  // DISTINCT data-driven badges — never one green badge for all. These
  // describe the DATASET (Pi-CNG register match / stale 2024 list), not a
  // submission: centre self-registration was removed in 2.5 (18 Nov 2026).
  function verifyBadge(s) {
    if (s.acc) {
      return `<span class="badge acc">✓ Officially accredited · Pi-CNG register ${F.REGISTER_DATES.centres}</span>`;
    }
    if (s.refReg) {
      return `<span class="badge acc">✓ On Pi-CNG refuelling register · ${F.REGISTER_DATES.refuel}</span>`;
    }
    if (s.confidence === "stale-2024-list") {
      return `<span class="badge stale">⚠ Needs re-verification</span>`;
    }
    if (s.confidence === "single-source") {
      return `<span class="badge unver">Single source — needs a second check</span>`;
    }
    return `<span class="badge unver">Not on Pi-CNG register</span>`;
  }
  // Coordinate precision (2.1 data contract): entry.coord_precision is
  // "exact" | "approximate" | "town". Town-level pins are locality
  // centroids, NOT exact locations — the UI must say so plainly, never
  // present them as precise. Fallback for entries that predate the field:
  // infer from coord_note; when nothing says, say nothing (never guess).
  function coordPrecision(s) {
    if (s.coord_precision === "exact" || s.coord_precision === "approximate" || s.coord_precision === "town") return s.coord_precision;
    if (!s.lat || !s.lng) return null;
    const note = String(s.coord_note || "").toLowerCase();
    if (!note) return null;
    if (note.includes("town") || note.includes("locality") || note.includes("centroid")) return "town";
    if (note.includes("approximate") || note.includes("geocoded")) return "approximate";
    if (note.includes("coordinates embedded")) return "exact";
    return null;
  }
  function precisionChip(s) {
    const p = coordPrecision(s);
    if (p === "exact") return `<span class="badge exact-pin">✓ Exact location</span>`;
    if (p === "approximate") return `<span class="badge approx-pin">≈ Approximate location</span>`;
    if (p === "town") return `<span class="badge area-pin">◉ Area pin</span>`;
    return "";
  }
  function precisionNoteHtml(s) {
    const p = coordPrecision(s);
    if (p === "exact") return `<div class="precision-note exact"><span class="pn-ico">✓</span><div><b>Exact location</b>The pin marks this station's exact spot.</div></div>`;
    if (p === "approximate") return `<div class="precision-note approx"><span class="pn-ico">≈</span><div><b>Approximate location</b>The pin is near this station, but the exact forecourt may be a short distance away — use the address and landmarks, and ask locally.</div></div>`;
    if (p === "town") return `<div class="precision-note town"><span class="pn-ico">◉</span><div><b>Area pin — shows the neighbourhood, not the exact spot</b>This station is somewhere in this area; the pin is the town centre, not the station. Call ahead or ask locally for directions.</div></div>`;
    return "";
  }
  // Typical-fill estimate — ALWAYS labelled as an estimate from the national
  // price, never as that station's price.
  function fillEstimateHtml() {
    const cost = F.FILL.scm * F.PRICES.cngPerScmCar;
    return `<p class="small">Typical fill ≈ <b>${naira(cost)}</b> (${F.FILL.note} at the national price ` +
      `₦${F.PRICES.cngPerScmCar}/SCM, ${F.PRICES.priceDate}) — an estimate, not this station's price.</p>`;
  }
  function normalizeNgPhone(p) {
    const d = String(p || "").replace(/[\s()-]/g, "");
    if (/^0\d{10}$/.test(d)) return "234" + d.slice(1);
    if (/^234\d{10}$/.test(d)) return d;
    if (/^\+234\d{10}$/.test(d)) return d.slice(1);
    return null;
  }
  function directionsUrl(s) {
    if (s.lat && s.lng) return `https://www.google.com/maps?q=${s.lat},${s.lng}`;
    return `https://www.google.com/maps?q=${encodeURIComponent((s.name || "") + " " + (s.address || "") + " " + (s.city || "") + " Nigeria")}`;
  }
  function stationUrl(id) { return location.origin + location.pathname + "?station=" + encodeURIComponent(id); }

  // ---------------- tabs ----------------
  const VIEWS = ["map", "stations", "centres", "station", "outages",
    "safety", "calculator", "news", "help", "privacy", "about", "more", "chat"];
  function showView(name) {
    if (!VIEWS.includes(name)) name = "map";
    if (name !== "station") prevView = name;
    VIEWS.forEach((v) => {
      const el = $("view-" + v);
      if (el) el.classList.toggle("active", v === name);
    });
    document.querySelectorAll(".bottomnav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === name ||
        (name === "station" && b.dataset.view === prevView));
    });
    window.scrollTo({ top: 0 });
    if (history.replaceState) {
      const url = name === "map" ? location.pathname
        : name === "station" && currentStation ? "?station=" + encodeURIComponent(currentStation)
        : "?view=" + name;
      history.replaceState(null, "", url);
    }
    if (name === "map" && map) setTimeout(() => { map.invalidateSize(); renderMapMarkers(); }, 60);
    if (name === "outages") renderOutages();
    if (name === "more") renderFavs();
  }
  window.showView = showView;
  document.querySelectorAll(".bottomnav button").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });

  // ---------------- data loading ----------------
  // Single source of truth for the "on the map" figure (2.4): counted from
  // the loaded stations data, never from stats.json. The hero stat, the
  // "With coordinates" tile and the map caption all read onMapCount(), so
  // they can never disagree. Before 2.4 the hero read stats.json (build
  // time) while the caption counted stations.json at runtime, and the two
  // files skew across cached versions — Saheed's screenshot showed 438 vs
  // 439 at once. A pin needs both coordinates, so entries with only one
  // (none today) do not count.
  function onMapCount() {
    return stations.filter((s) => s.lat && s.lng).length;
  }
  function renderMapCount() {
    const el = $("map-count");
    if (!el) return;
    el.textContent = stations.length + " stations & centres nationwide · " +
      onMapCount() + " on the map (only these have coordinates so far)";
  }
  function loadStations() {
    return Promise.all([
      fetch("data/stations.json").then((r) => r.json()),
      fetch("data/stats.json").then((r) => r.json()).catch(() => null),
    ])
      .then(([list, st]) => {
        stations = list;
        stats = st;
        dataLoaded = true;
        populateStateFilters();
        buildFilterPanel();
        renderStats();
        renderStations();
        renderCentres();
        renderMapMarkers();
        renderNearest();
        renderMapCount();
        handleDeepLink();
      })
      .catch(() => {
        $("map-count").textContent = "Could not load the station list. Check your connection and reload.";
      });
  }
  // ---------------- honest statistics ----------------
  function statTile(num, label, meaning, live) {
    return `<div class="stat-tile${live ? " live" : ""}"><div class="num">${num}</div><div class="lbl">${esc(label)}</div><div class="mean">${esc(meaning)}</div></div>`;
  }
  function renderStats() {
    if (!stats) return;
    const tiles =
      statTile(stats.total_records.toLocaleString(), "Directory records", stats.total_records_label) +
      statTile(stats.refuelling_locations.toLocaleString(), "Refuelling locations", stats.refuelling_label) +
      statTile(stats.conversion_centres.toLocaleString(), "Conversion centres", stats.conversion_label) +
      statTile(stats.picng_register_matched.toLocaleString(), "Officially accredited", stats.picng_register_label) +
      statTile(stats.picng_refuel_register_matched.toLocaleString(), "On the Pi-CNG refuelling register", stats.picng_refuel_register_label) +
      statTile(stats.needs_reverification.toLocaleString(), "Need re-verification", stats.needs_reverification_label) +
      statTile(stats.states_with_data + " / 37", "States + FCT with data", stats.states_with_data_label) +
      statTile(onMapCount().toLocaleString(), "With coordinates", stats.with_coordinates_label);
    const grid = `<div class="stat-grid">${tiles}</div>` +
      `<p class="tiny" style="margin:8px 0 0">Directory numbers computed from the dataset on ${esc(stats.generated)}.</p>`;
    const home = $("home-stats");
    if (home) home.innerHTML = grid;
    const about = $("about-stats");
    if (about) about.innerHTML = grid;
    // Hero stats — same source, three headline numbers.
    const hero = $("hero-stats");
    if (hero) hero.innerHTML =
      `<div class="hero-stat"><b>${stats.total_records.toLocaleString()}</b><span>stations &amp; centres</span></div>` +
      `<div class="hero-stat"><b>${stats.states_with_data} / 37</b><span>states + FCT</span></div>` +
      `<div class="hero-stat"><b>${onMapCount().toLocaleString()}</b><span>on the map</span></div>`;
    const lede = $("stations-lede");
    if (lede) lede.textContent = `Every CNG refuelling station and conversion centre in the dataset — ${stats.total_records} entries across ${stats.states_with_data} states. Search by name, town or operator.`;
    const nodata = $("nodata-note");
    if (nodata) {
      nodata.textContent = stats.no_data_states.length
        ? `${stats.no_data_states.length} states have no data yet: ${stats.no_data_states.join(", ")}. New entries come from official government and agency lists as they are published.`
        : "Every state now has at least one entry.";
    }
    const cs = $("centre-stats");
    if (cs) cs.textContent = `${stats.picng_register_matched} of ${stats.conversion_centres} conversion centres are matched on the Pi-CNG accredited list; ${stats.needs_reverification} entries need re-verification.`;
  }

  // ---------------- reports (live only — no demo mode) ----------------
  function loadReports() {
    return fetch("/api/reports")
      .then((r) => r.json())
      .then((j) => {
        if (!j || j.configured === false) { reportsLive = false; refreshStatuses(); return; }
        reportsLive = true;
        const fresh = new Map();
        (j.reports || []).forEach((r) => {
          const ts = new Date(r.reported_at).getTime();
          if (Date.now() - ts <= F.REPORT_TTL_MS) {
            const prev = fresh.get(r.station_id);
            if (!prev || ts > prev.ts) {
              fresh.set(r.station_id, { id: r.id, status: r.status, queue: r.queue_minutes,
                pressure: r.pressure_ok, compressor: r.compressor_ok, ts });
            }
          }
        });
        reports = fresh;
        refreshStatuses();
      })
      .catch(() => { reportsLive = false; refreshStatuses(); });
  }
  function refreshStatuses() {
    renderMapMarkers();
    renderStations();
    renderCentres();
    renderNearest();
    renderOutages();
    if (currentStation && $("view-station").classList.contains("active")) renderDetail(currentStation);
  }

  // ---------------- map ----------------
  function leafletReady() { return typeof L !== "undefined"; }
  function mapFallback(msg) {
    const el = $("map");
    if (el) el.innerHTML = `<div class="empty" style="padding:60px 16px"><div class="big">🗺️</div><p><b>The map could not load.</b></p><p>${msg}</p><p>The station list, directory, safety hub and calculator still work — use the tabs at the bottom.</p></div>`;
  }
  // ---------------- map layers (2.3; dark removed in 2.4) ----------------
  // Two base layers; satellite (Esri World Imagery) is the default, like the
  // NIPOST postcode finder. Choice persisted as findcng_maplayer.
  // Dark was removed 18 Nov 2026: CARTO's keyless dark endpoint died — it
  // still returns HTTP 200, but the image is a 2.5 KB "API KEY REQUIRED"
  // watermark PNG instead of map tiles, so the dark layer tiled the
  // watermark across the map. A stored "dark" choice now maps to satellite.
  const MAP_LAYERS = {
    satellite: {
      // Esri World Imagery — note the {z}/{y}/{x} order (unlike OSM).
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: 'Imagery &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      label: "Satellite",
    },
    street: {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      label: "Street",
    },
  };
  const MAP_LAYER_KEY = "findcng_maplayer";
  function storedMapLayer() {
    try {
      const v = localStorage.getItem(MAP_LAYER_KEY);
      if (v && MAP_LAYERS[v]) return v;
      // Migration (2.4): the dark layer is gone — a stored "dark" choice, or
      // the old findcng_darkmap toggle from 2.3, now means satellite.
      if (v === "dark" || localStorage.getItem("findcng_darkmap") === "1") return "satellite";
    } catch { /* ignore */ }
    return "satellite";
  }
  // Fresh layer instance per map (one L.tileLayer cannot live on two maps).
  function createBaseLayer(kind) {
    const def = MAP_LAYERS[kind] || MAP_LAYERS.street;
    return L.tileLayer(def.url, { maxZoom: 19, attribution: def.attribution });
  }
  function updateLayerSwitcher() {
    document.querySelectorAll("[data-map-layer]").forEach((b) => {
      const on = b.dataset.mapLayer === mapLayer;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  function setMapLayer(kind, opts = {}) {
    if (!map || !baseLayers || !MAP_LAYERS[kind]) return;
    if (mapLayer === kind && map.hasLayer(baseLayers[kind])) { updateLayerSwitcher(); return; }
    Object.values(baseLayers).forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); });
    mapLayer = kind;
    baseLayers[kind].addTo(map);
    try { localStorage.setItem(MAP_LAYER_KEY, kind); } catch { /* ignore */ }
    // A deliberate manual switch re-arms the fallback; a fallback disarms it
    // so the street layer's own errors can never re-trigger it (no loop).
    if (opts.fallbackFrom) tileFallbackArmed = false;
    else if (kind !== "street") tileFallbackArmed = true;
    updateLayerSwitcher();
    if (opts.fallbackFrom) toast(MAP_LAYERS[opts.fallbackFrom].label + " map couldn't load — showing street map.");
  }
  // Tile-failure fallback: 3+ tile errors within 10 seconds on the satellite
  // layer means the provider is failing, not one bad tile — switch to
  // the street layer so the map is never left broken or blank. The street
  // layer itself is never watched, so the fallback cannot loop.
  function watchTileErrors(layer, kind) {
    let errors = [];
    layer.on("tileerror", () => {
      if (!tileFallbackArmed || mapLayer !== kind || !map || !map.hasLayer(layer)) return;
      const now = Date.now();
      errors = errors.filter((t) => now - t < 10000);
      errors.push(now);
      if (errors.length >= 3) setMapLayer("street", { fallbackFrom: kind });
    });
  }
  function initMap() {
    if (map) return;
    if (!leafletReady()) {
      mapFallback("Check your connection and reload the page. The map needs to download its mapping library.");
      return;
    }
    map = L.map("map", { zoomControl: true }).setView(F.NIGERIA_CENTRE, F.NIGERIA_ZOOM);
    baseLayers = {
      satellite: createBaseLayer("satellite"),
      street: createBaseLayer("street"),
    };
    watchTileErrors(baseLayers.satellite, "satellite");
    mapLayer = storedMapLayer();
    baseLayers[mapLayer].addTo(map);
    try { localStorage.setItem(MAP_LAYER_KEY, mapLayer); } catch { /* ignore */ }
    updateLayerSwitcher();
    map.on("click", (e) => setUserLoc(e.latlng.lat, e.latlng.lng, "Dropped pin"));
    map.on("moveend", renderMapMarkers);
    clusterLayer = L.layerGroup().addTo(map);
  }
  function passesFilters(s) {
    if (filters.availableOnly && statusOf(s.id) !== "available") return false;
    if (filters.outagesOnly && !(statusOf(s.id) === "finished" || statusOf(s.id) === "closed")) return false;
    if (filters.types.size && !filters.types.has(s.type)) return false;
    if (filters.operators.size && !filters.operators.has(s.operator || "")) return false;
    if (filters.categories.size && !filters.categories.has(s.category || "")) return false;
    return true;
  }
  function filteredForMap() {
    return stations.filter((s) => s.lat && s.lng && passesFilters(s));
  }
  function markerIcon(st, type, precision) {
    const letter = type === "refuelling" ? "R" : type === "conversion" ? "C" : "B";
    // Town pins are dashed circles, never precise teardrops; approximate
    // pins carry a dashed halo. Exact pins are the plain teardrop.
    const pCls = precision === "town" ? " town" : precision === "approximate" ? " approx" : "";
    return L.divIcon({
      className: "",
      html: `<div class="marker-pin ${st}${pCls}"><b>${letter}</b></div>`,
      iconSize: [28, 28],
      iconAnchor: precision === "town" ? [14, 14] : [14, 27],
      popupAnchor: [0, -24],
    });
  }
  function popupHtml(s) {
    const st = statusOf(s.id);
    const d = (userLoc && s.lat && s.lng) ? ` · ${fmtKm(haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng))} away` : "";
    const prec = coordPrecision(s);
    const precLine = prec === "town" ? `<br><span class="badge area-pin">◉ Area pin — neighbourhood, not exact spot</span>`
      : prec === "approximate" ? `<br><span class="small">≈ Approximate location — near this spot, not exact</span>` : "";
    return `<b>${esc(s.name)}</b><br>${esc(s.address || "")}<br>${esc(locLabel(s))}${d}<br>` +
      `${F.STATUS[st].label}${st !== "unconfirmed" ? " · " + timeAgo(reports.get(s.id).ts) : ""}${precLine}<br>` +
      `<button class="btn small" style="margin-top:8px" onclick="openStation('${s.id}')">Details &amp; report</button>`;
  }
  // Lightweight grid clustering (plain JS, no library): group markers into
  // 70px cells below zoom 14; tap a bubble to zoom in.
  function renderMapMarkers() {
    if (!map || !clusterLayer) return;
    clusterLayer.clearLayers();
    const visible = filteredForMap();
    const zoom = map.getZoom();
    if (zoom >= 14) {
      visible.forEach((s) => {
        L.marker([s.lat, s.lng], { icon: markerIcon(statusOf(s.id), s.type, coordPrecision(s)) })
          .bindPopup(popupHtml(s)).addTo(clusterLayer);
      });
      updateViewStats(visible);
      return;
    }
    const cells = new Map();
    visible.forEach((s) => {
      const pt = map.latLngToContainerPoint([s.lat, s.lng]);
      const key = Math.floor(pt.x / 70) + ":" + Math.floor(pt.y / 70);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(s);
    });
    cells.forEach((list) => {
      if (list.length === 1) {
        const s = list[0];
        L.marker([s.lat, s.lng], { icon: markerIcon(statusOf(s.id), s.type, coordPrecision(s)) })
          .bindPopup(popupHtml(s)).addTo(clusterLayer);
        return;
      }
      const lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
      const lng = list.reduce((a, s) => a + s.lng, 0) / list.length;
      const worst = list.some((s) => statusOf(s.id) === "finished" || statusOf(s.id) === "closed") ? "bad"
        : list.some((s) => statusOf(s.id) === "low") ? "warn" : "";
      const size = list.length < 10 ? 36 : list.length < 100 ? 44 : 52;
      const m = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "",
          html: `<div class="cluster-bubble ${worst}" style="width:${size}px;height:${size}px">${list.length}</div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2],
        }),
      }).addTo(clusterLayer);
      m.on("click", () => map.setView([lat, lng], Math.min(map.getZoom() + 2, 16)));
    });
    updateViewStats(visible);
  }
  // Visible-area stats strip (image 23): counts in the current map view.
  function updateViewStats(visible) {
    const box = $("view-stats");
    if (!box || !map) return;
    const b = map.getBounds();
    const inView = visible.filter((s) => b.contains([s.lat, s.lng]));
    const c = { available: 0, low: 0, finished: 0, unconfirmed: 0 };
    inView.forEach((s) => {
      const st = statusOf(s.id);
      if (st === "closed") c.finished++;
      else c[st]++;
    });
    box.innerHTML =
      `<span class="vs">In this area: <b>${inView.length}</b></span>` +
      `<span class="vs"><span class="dot available"></span> ${c.available} available</span>` +
      `<span class="vs"><span class="dot low"></span> ${c.low} low</span>` +
      `<span class="vs"><span class="dot finished"></span> ${c.finished} finished</span>` +
      `<span class="vs"><span class="dot unconfirmed"></span> ${c.unconfirmed} unconfirmed</span>`;
  }
  function buildFilterPanel() {
    // Operator checklist — built from the data (top 12 operators).
    const ops = stats ? stats.operators : [];
    const box = $("operator-list");
    if (box) {
      box.innerHTML = ops.length
        ? ops.map((o) => `<label><input type="checkbox" data-operator="${esc(o.name)}"> ${esc(o.name)} <span class="cnt">${o.count}</span></label>`).join("")
        : `<p class="small">No operator data yet.</p>`;
      box.querySelectorAll("input[data-operator]").forEach((cb) =>
        cb.addEventListener("change", () => {
          if (cb.checked) filters.operators.add(cb.dataset.operator);
          else filters.operators.delete(cb.dataset.operator);
        }));
    }
    // CNG station-type chips — ONLY where the register gives the category.
    const cats = stats ? stats.categories : [];
    const field = $("category-field");
    const chips = $("category-chips");
    if (!cats.length) {
      if (field) field.classList.add("hidden");
    } else if (chips) {
      chips.innerHTML = cats.map((c) =>
        `<button class="chip" data-category="${esc(c.name)}">${esc(c.name)} (${c.count})</button>`).join("");
      chips.querySelectorAll(".chip").forEach((ch) =>
        ch.addEventListener("click", () => {
          const on = ch.classList.toggle("on");
          if (on) filters.categories.add(ch.dataset.category);
          else filters.categories.delete(ch.dataset.category);
        }));
    }
  }
  function setUserLoc(lat, lng, label) {
    userLoc = { lat, lng, label };
    if (map) {
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.circleMarker([lat, lng], {
        radius: 9, color: "#fff", weight: 2, fillColor: "#ffc61a", fillOpacity: 1,
      }).addTo(map).bindPopup(esc(label)).openPopup();
      map.setView([lat, lng], Math.max(map.getZoom(), 12));
    }
    $("loc-status").textContent = "Your spot: " + label + " (" + lat.toFixed(4) + ", " + lng.toFixed(4) + ")";
    renderNearest();
    renderStations();
  }
  function etaRing(mins) {
    const cls = mins < 15 ? "" : mins < 30 ? "amber" : "red";
    if (mins < 60) return `<div class="eta-ring ${cls}">${Math.max(1, Math.round(mins))}<small>min</small></div>`;
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return `<div class="eta-ring ${cls}">${h}h<small>${m ? m + " min" : "drive"}</small></div>`;
  }
  function renderNearest() {
    const box = $("nearest-list");
    if (!userLoc) {
      box.innerHTML = `<div class="empty"><div class="big">📍</div><p><b>Where is gas near me?</b></p>` +
        `<p>Enter your postcode, use your location, or tap the map — and the nearest stations with coordinates will appear here.</p></div>`;
      return;
    }
    const near = stations
      .filter((s) => s.lat && s.lng && passesFilters(s))
      .map((s) => ({ s, d: haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
    if (!near.length) {
      box.innerHTML = `<div class="empty"><p>No mapped stations near you yet — only ${onMapCount()} of ${stations.length} entries have coordinates so far. Use the Stations tab to browse the full list by state.</p></div>`;
      return;
    }
    box.innerHTML = `<h3>Nearest mapped stations</h3>` + near.map(({ s, d }) =>
      `<div class="card station st-${statusOf(s.id)}" data-id="${s.id}" style="display:flex;gap:10px;align-items:center">` +
      etaRing(d * 1.5) +
      `<div style="flex:1;min-width:0"><h3>${esc(s.name)}</h3>` +
      `<p class="meta">${esc(s.address || "")} · ${esc(locLabel(s))} · <span class="dist-chip">${fmtKm(d)}</span></p>` +
      `<div class="row">${statusBadge(s.id, true)} ${typeBadge(s.type)}${coordPrecision(s) === "town" ? " " + precisionChip(s) : ""}</div></div></div>`
    ).join("") +
    `<p class="tiny">Drive times are rough estimates (about 40 km/h) — traffic and road conditions change them.</p>`;
    box.querySelectorAll(".station").forEach((el) =>
      el.addEventListener("click", () => openStation(el.dataset.id)));
  }

  // ---------------- location: postcode / GPS ----------------
  function postcodeGo() {
    const raw = $("postcode-input").value;
    const p = F.postcode.parse(raw);
    const msg = $("postcode-msg");
    if (!p.valid) { msg.textContent = p.reason; msg.className = "notice err"; msg.classList.remove("hidden"); return; }
    if (p.kind === "ndaps") {
      msg.textContent = "✓ That code is well formed" +
        (p.stateConfirmed ? "" : " (its state code is not on the confirmed list yet — NIPOST has only published 12 state codes so far)") +
        ". Postcodes cannot give an exact map point, so use your location or tap the map to set your spot — your postcode is saved as your label.";
      msg.className = "notice ok"; msg.classList.remove("hidden");
      F.postcode.lookupApi(p.code).then((res) => {
        if (res && res.valid) {
          msg.textContent = "✓ NIPOST confirms this postcode is assigned" +
            (res.lga ? " — LGA: " + res.lga : "") +
            ". Use your location or tap the map to set your exact spot.";
        }
      });
      return;
    }
    F.postcode.resolveSix(p.code).then((hit) => {
      if (!hit) {
        msg.textContent = "We don't have that postcode area yet — the app only knows a small set of 6-digit codes so far. Use your location or tap the map instead.";
        msg.className = "notice"; msg.classList.remove("hidden");
        return;
      }
      msg.textContent = `📍 Centred on ${hit.place} (approximate ${hit.level === "exact" ? "district" : "dispatch district"} centre — a 6-digit code covers a whole area, not one building).`;
      msg.className = "notice ok"; msg.classList.remove("hidden");
      setUserLoc(hit.lat, hit.lng, hit.place + " — postcode " + p.code);
    });
  }
  function gpsGo() {
    const msg = $("postcode-msg");
    if (!navigator.geolocation) {
      msg.textContent = "Your device does not support location. Tap the map to set your spot instead.";
      msg.className = "notice err"; msg.classList.remove("hidden");
      return;
    }
    msg.textContent = "Getting your location…";
    msg.className = "notice"; msg.classList.remove("hidden");
    navigator.geolocation.getCurrentPosition(
      (pos) => { msg.classList.add("hidden"); setUserLoc(pos.coords.latitude, pos.coords.longitude, "Your location (GPS)"); },
      () => {
        msg.textContent = "Could not get your location — check that location is allowed for this site, or tap the map to set your spot.";
        msg.className = "notice err"; msg.classList.remove("hidden");
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }

  // ---------------- station list ----------------
  function populateStateFilters() {
    const states = [...new Set(stations.map((s) => s.state))].sort();
    ["state-filter", "centre-state-filter"].forEach((id) => {
      const sel = $(id);
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = `<option value="">All states (${states.length})</option>` +
        states.map((s) => `<option value="${esc(s)}">${esc(s)} (${stations.filter((x) => x.state === s).length})</option>`).join("");
      sel.value = cur;
    });
  }
  function filteredStations() {
    const q = ($("station-search").value || "").trim().toLowerCase();
    const st = $("state-filter").value;
    const ty = document.querySelector(".chip[data-type].on")?.dataset.type || "";
    let list = stations.filter((s) => {
      if (st && s.state !== st) return false;
      if (ty && s.type !== ty) return false;
      if (sortMode === "favs" && !favs.has(s.id)) return false;
      if (q) {
        const hay = `${s.name} ${s.address || ""} ${s.city || ""} ${s.state} ${s.operator || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sortMode === "az") {
      list.sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name));
    } else if (userLoc) {
      list = list.map((s) => ({ s, d: (s.lat && s.lng) ? haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng) : Infinity }))
        .sort((a, b) => a.d - b.d).map((x) => x.s);
    } else {
      list.sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name));
    }
    return list;
  }
  function stationCard(s) {
    const d = (userLoc && s.lat && s.lng) ? ` · <span class="dist-chip">${fmtKm(haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng))}</span>` : "";
    const noc = (!s.lat) ? `<span class="tiny"> · Map position not recorded yet</span>` : "";
    const fav = favs.has(s.id) ? "★" : "☆";
    const st = statusOf(s.id);
    const precChip = coordPrecision(s) === "town" ? " " + precisionChip(s) : "";
    return `<div class="card station st-${st}" data-id="${s.id}"><h3>${esc(s.name)} <button class="fav-btn" data-fav="${s.id}" aria-label="Favourite">${fav}</button></h3>` +
      `<p class="meta">${esc(s.address || "")}</p>` +
      `<p class="meta">${esc(locLabel(s))}${d}${noc}</p>` +
      `<div class="row">${statusBadge(s.id, true)} ${typeBadge(s.type)} ${verifyBadge(s)}${precChip}</div></div>`;
  }
  function bindCards(box) {
    box.querySelectorAll(".station").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-fav]")) return;
        openStation(el.dataset.id);
      }));
    box.querySelectorAll("[data-fav]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFav(btn.dataset.fav);
        renderStations(); renderCentres(); renderNearest();
      }));
  }
  function renderStations() {
    if (!dataLoaded) return;
    const list = filteredStations();
    const box = $("station-results");
    $("station-count").textContent = list.length + " of " + stations.length + " entries" +
      (sortMode === "favs" ? " · your favourites" : userLoc ? " · sorted by distance from your spot" : " · set your location to sort by distance");
    // State landing summary — genuinely useful content for ?state= pages.
    let summaryHtml = "";
    const st = $("state-filter").value;
    if (st) {
      const inState = stations.filter((s) => s.state === st);
      const ref = inState.filter((s) => s.type !== "conversion").length;
      const conv = inState.filter((s) => s.type !== "refuelling").length;
      const mapped = inState.filter((s) => s.lat).length;
      const acc = inState.filter((s) => s.acc).length;
      const stale = inState.filter((s) => s.confidence === "stale-2024-list").length;
      summaryHtml = `<div class="card"><h3 style="margin-top:0">CNG in ${esc(st)}</h3>` +
        `<p style="margin:0"><b>${inState.length}</b> entries: <b>${ref}</b> refuelling location(s), <b>${conv}</b> conversion centre(s). ` +
        `<b>${mapped}</b> on the map · <b>${acc}</b> officially accredited` +
        (stale ? ` · <b>${stale}</b> need re-verification` : "") + `.</p>` +
        `<p class="small" style="margin-bottom:0">Share this page: <b>${esc(location.origin + location.pathname + "?state=" + encodeURIComponent(st))}</b></p></div>`;
    }
    if (!list.length) {
      box.innerHTML = summaryHtml + (sortMode === "favs"
        ? `<div class="empty"><div class="big">☆</div><p><b>No favourites yet.</b></p><p>Tap the ☆ on any station to save it here — it stays on this device, no account needed.</p></div>`
        : `<div class="empty"><div class="big">🔍</div><p><b>Nothing matches that search.</b></p><p>Try a different spelling, or clear the state filter. New entries come from official government and agency lists as they are published.</p></div>`);
      $("station-more").classList.add("hidden");
      return;
    }
    const shown = list.slice(0, listShown);
    box.innerHTML = summaryHtml + shown.map(stationCard).join("");
    bindCards(box);
    $("station-more").classList.toggle("hidden", list.length <= listShown);
    $("station-more").textContent = "Show more (" + (list.length - shown.length) + " left)";
  }
  function toggleFav(id) {
    if (favs.has(id)) { favs.delete(id); toast("Removed from favourites."); }
    else { favs.add(id); toast("Saved to favourites on this device."); }
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch { /* ignore */ }
  }
  function renderFavs() {
    const box = $("fav-list");
    if (!box) return;
    const list = stations.filter((s) => favs.has(s.id));
    if (!list.length) {
      box.innerHTML = `<div class="empty"><p><b>No favourites yet.</b></p><p>Tap the ☆ on any station to save it here — it stays on this device, no account needed.</p></div>`;
      return;
    }
    box.innerHTML = list.map(stationCard).join("");
    bindCards(box);
  }

  // ---------------- outages ----------------
  function renderOutages() {
    const box = $("outages-list");
    if (!box || !dataLoaded) return;
    const list = stations.filter((s) => statusOf(s.id) === "finished")
      .sort((a, b) => (reports.get(b.id)?.ts || 0) - (reports.get(a.id)?.ts || 0));
    $("outages-count").textContent = reportsLive
      ? (list.length ? list.length + " station(s) reported out of gas in the last 2 hours" : "No station is currently reported out of gas. Good news — or no fresh reports yet.")
      : "Live reports could not be reached — showing the last known state. Check your connection.";
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">✅</div><p><b>Nothing out of gas right now.</b></p><p>No station has a fresh “Gas finished” report. If you find one empty, report it so other drivers don't waste the trip.</p></div>`;
      return;
    }
    box.innerHTML = list.map(stationCard).join("");
    bindCards(box);
  }

  // ---------------- centres / installer check ----------------
  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function checkInstaller() {
    const q = ($("installer-search").value || "").trim();
    const box = $("installer-result");
    if (q.length < 3) {
      box.innerHTML = `<p class="small">Type at least 3 letters of the centre's name.</p>`;
      return;
    }
    const nq = normName(q);
    const hits = stations.filter((s) => s.acc && normName(s.name).includes(nq)).slice(0, 8);
    if (hits.length) {
      const all = hits;
      box.innerHTML = `<div class="notice ok"><b>✓ Found — ${all.length} match${all.length > 1 ? "es" : ""}:</b></div>` +
        all.map((s) => `<div class="card station" data-id="${s.id}"><h3>${esc(s.name)}</h3>` +
          `<p class="meta">${esc(s.address || "")} · ${esc(locLabel(s))}</p>` +
          `<div class="row">${verifyBadge(s)}</div></div>`).join("");
      bindCards(box);
    } else {
      box.innerHTML = `<div class="notice err"><b>Not found on the accredited list.</b><br>` +
        `That does not automatically mean the centre is fake — the list may be incomplete — but do not convert there until you have seen their NADDC/Pi-CNG accreditation certificate and checked the certificate number with Pi-CNG. ` +
        `A real accredited centre will show you its certificate without arguing.</div>`;
    }
  }
  function renderCentres() {
    if (!dataLoaded) return;
    const q = ($("centre-search").value || "").trim().toLowerCase();
    const st = $("centre-state-filter").value;
    let list = stations.filter((s) => s.type !== "refuelling");
    if (st) list = list.filter((s) => s.state === st);
    if (q) list = list.filter((s) => (`${s.name} ${s.address || ""} ${s.city || ""} ${s.state}`).toLowerCase().includes(q));
    list.sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name));
    const box = $("centre-results");
    $("centre-count").textContent = list.length + " conversion centres" +
      (st ? " in " + st : " nationwide") + " · " + stations.filter((s) => s.acc).length + " on the Pi-CNG accredited list";
    if (!list.length) {
      box.innerHTML = `<div class="empty"><p><b>No centres match.</b></p><p>Try another state or spelling.</p></div>`;
      $("centre-more").classList.add("hidden");
      return;
    }
    const shown = list.slice(0, centresShown);
    box.innerHTML = shown.map(stationCard).join("");
    bindCards(box);
    $("centre-more").classList.toggle("hidden", list.length <= centresShown);
    $("centre-more").textContent = "Show more (" + (list.length - shown.length) + " left)";
  }

  // ---------------- station detail view ----------------
  // Reference order (images 04, 11, 12, 24): name → address → Directions +
  // Call → live status with confirm/deny → opening hours → services → price.
  // Hours/services/phone/price appear ONLY where the data has them — never
  // invented; honest "not listed" states otherwise.
  function openStation(id) {
    const s = stations.find((x) => x.id === id);
    if (!s) return;
    currentStation = id;
    renderDetail(id);
    showView("station");
  }
  window.openStation = openStation;
  function hoursHtml(s) {
    if (!s.hours) return `<p class="small">Opening hours not listed for this entry.</p>`;
    if (typeof s.hours === "string") return `<p>${esc(s.hours)}</p>`;
    const rows = Object.entries(s.hours).map(([d, h]) => `<tr><td>${esc(d)}</td><td>${esc(h)}</td></tr>`).join("");
    return rows ? `<table class="hours-table">${rows}</table>` : `<p class="small">Opening hours not listed for this entry.</p>`;
  }
  function servicesHtml(s) {
    if (!s.services) return `<p class="small">Services not listed for this entry.</p>`;
    const list = Array.isArray(s.services) ? s.services : String(s.services).split(",").map((x) => x.trim()).filter(Boolean);
    return list.length
      ? `<div class="service-chips">${list.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`
      : `<p class="small">Services not listed for this entry.</p>`;
  }
  function priceHtml(s) {
    if (s.price != null) {
      return `<p><b>₦${Number(s.price).toLocaleString("en-NG")} / SCM</b>` +
        (s.price_date ? ` <span class="small">(as listed, ${esc(s.price_date)})</span>` : "") + `</p>` + fillEstimateHtml();
    }
    return `<p class="small">This station's own price is not listed. The national CNG price is ` +
      `₦${F.PRICES.cngPerScmCar}/SCM for cars and buses (₦${F.PRICES.cngPerScmTruck}/SCM for trucks), as reported ${F.PRICES.priceDate} — stations may charge differently.</p>` +
      fillEstimateHtml();
  }
  function renderDetail(id) {
    const s = stations.find((x) => x.id === id);
    if (!s) return;
    const box = $("station-detail");
    const st = statusOf(id);
    const r = reports.get(id);
    const fav = favs.has(id) ? "★ Saved" : "☆ Save";
    const wa = s.phone ? normalizeNgPhone(s.phone) : null;
    const distText = (userLoc && s.lat && s.lng) ? fmtKm(haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng)) : null;
    // Photo hero (2.1 contract): entry.photo = {url, attribution} when a
    // real photo of that place exists. When absent there is NO placeholder
    // image — the clean typographic band is the design, not a gap.
    const photo = s.photo && s.photo.url ? s.photo : null;
    const precChip = precisionChip(s);
    const heroBody =
      `<div class="detail-hero-body"><h2>${esc(s.name)}</h2>` +
      `<div class="row">${statusBadge(id, true)} ${typeBadge(s.type)} ${verifyBadge(s)}${s.category ? ` <span class="badge type">${esc(s.category)}</span>` : ""}${precChip ? " " + precChip : ""}</div>` +
      `<p class="hero-addr">${esc(s.address || "")}<br>${esc(locLabel(s))}${s.postcode ? " · Postcode " + esc(s.postcode) : ""}</p>` +
      (distText ? `<p class="hero-dist">📍 ${distText} from your spot</p>` : "") +
      `</div>`;
    const hero = photo
      ? `<div class="detail-hero photo"><div class="detail-photo-wrap"><img src="${esc(photo.url)}" alt="Photo of ${esc(s.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.detail-hero').classList.remove('photo');this.closest('.detail-photo-wrap').remove()">${photo.attribution ? `<span class="photo-credit">Photo: ${esc(photo.attribution)}</span>` : ""}</div>${heroBody}</div>`
      : `<div class="detail-hero">${heroBody}</div>`;
    let statusBlock;
    if (!reportsLive) {
      statusBlock = `<div class="notice">Live reports could not be reached — check your connection and reload. The listing below is still accurate.</div>`;
    } else if (r && st !== "unconfirmed") {
      statusBlock =
        `<p><b>Live status: ${F.STATUS[st].label}</b> · reported ${timeAgo(r.ts)}` +
        `${r.queue ? ` · queue about ${r.queue} min` : ""}` +
        `${r.pressure === true ? " · pressure OK" : r.pressure === false ? " · low pressure" : ""}` +
        `${r.compressor === true ? " · compressor working" : r.compressor === false ? " · compressor faulty" : ""}</p>` +
        `<p class="small">Is this still right?</p>` +
        `<div class="confirm-row" id="confirm-row"><button data-vote="yes">✓ Yes</button><button data-vote="unsure">? Not sure</button><button data-vote="no">✗ No</button></div>` +
        `<p class="small" id="confirm-counts"></p>`;
    } else {
      statusBlock = `<p class="small">No gas report in the last 2 hours. ${s.type === "conversion" ? "Conversion centres don't sell gas — but you can still report whether the centre is open." : "Be the first to report it."}</p>`;
    }
    box.innerHTML = hero + precisionNoteHtml(s) +
      (s.coord_note && !coordPrecision(s) ? `<p class="small">📍 Map position: ${esc(s.coord_note)}</p>` : "") +
      `<div class="detail-actions">` +
        `<a class="btn" href="${directionsUrl(s)}" target="_blank" rel="noopener">🧭 Directions</a>` +
        (s.phone ? `<a class="btn outline" href="tel:${esc(s.phone)}">📞 Call</a>` : "") +
        (wa ? `<a class="btn outline" href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 Chat (WhatsApp)</a>` : "") +
      `</div>` +
      (!s.phone ? `<p class="small">No phone number listed for this entry.</p>` : "") +
      `<div class="card">${statusBlock}` +
      `<button class="btn" onclick="openReport('${s.id}')">Report gas status here</button>` +
      ((st === "finished" || st === "closed" || st === "low")
        ? `<button class="btn yellow" style="margin-top:8px" onclick="backToNormal('${s.id}')">✅ Back to normal — gas is back</button>` : "") +
      `</div>` +
      `<div class="card"><h3 style="margin-top:0">Opening hours</h3>${hoursHtml(s)}</div>` +
      `<div class="card"><h3 style="margin-top:0">Services</h3>${servicesHtml(s)}</div>` +
      `<div class="card"><h3 style="margin-top:0">Price</h3>${priceHtml(s)}</div>` +
      `<div class="card"><h3 style="margin-top:0">Reliability — last 30 days</h3><div id="reliability-box"><p class="small">Loading report history…</p></div></div>` +
      `<div class="detail-actions">` +
        `<button class="fav-btn ${favs.has(id) ? "on" : ""}" id="detail-fav">${fav}</button>` +
        `<button class="btn outline small" id="detail-share">🔗 Copy link</button>` +
      `</div>` +
      `<div class="detail-actions">` +
        `<button class="btn outline small" onclick="openListing('${s.id}','incorrect')">⚠️ Report an incorrect listing</button>` +
        `<button class="btn outline small" onclick="openListing('${s.id}','closed')">⛔ Report a closure</button>` +
      `</div>` +
      (!s.lat ? `<p class="notice">This entry has no map position yet — its coordinates have not been recorded. The address above is what we have. If you know the exact spot, open “Report an incorrect listing” below and send the coordinates.</p>` : "") +
      `<p class="small">Source: ${esc(s.src)}${s.acc ? " · Checked 18 Nov 2026" : ""} · Listing ID ${esc(s.id)}</p>`;
    $("detail-fav").addEventListener("click", () => { toggleFav(id); renderDetail(id); });
    $("detail-share").addEventListener("click", () => {
      const url = stationUrl(id);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => toast("Link copied — share it anywhere.")).catch(() => toast(url));
      } else { toast(url); }
    });
    // One-tap confirm counts (graceful when the table is not open yet).
    const row = $("confirm-row");
    if (row && r && r.id) {
      row.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => submitConfirmation(r.id, id, b.dataset.vote)));
      loadConfirmCounts(r.id);
    }
    loadReliability(id);
  }
  function loadConfirmCounts(reportId) {
    const cached = confirmCache.get(reportId);
    const el = $("confirm-counts");
    if (!el) return;
    if (cached === "not_open") {
      el.textContent = "Confirmations aren't open yet — the database table is still being set up.";
      return;
    }
    if (cached) { renderConfirmCounts(cached); return; }
    fetch(`/api/confirmations?report_id=${encodeURIComponent(reportId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error === "not_open") { confirmCache.set(reportId, "not_open"); el.textContent = "Confirmations aren't open yet — the database table is still being set up."; return; }
        if (j && j.ok) { confirmCache.set(reportId, j.counts); renderConfirmCounts(j.counts); }
      })
      .catch(() => { /* counts are optional */ });
  }
  function renderConfirmCounts(c) {
    const el = $("confirm-counts");
    if (!el) return;
    const total = (c.yes || 0) + (c.unsure || 0) + (c.no || 0);
    el.textContent = total
      ? `Confirmed by other drivers: ✓ ${c.yes} · ? ${c.unsure} · ✗ ${c.no}`
      : "No confirmations yet — be the first.";
  }
  function submitConfirmation(reportId, stationId, vote) {
    fetch("/api/confirmations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report_id: reportId, station_id: stationId, vote }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error === "not_open") {
          confirmCache.set(reportId, "not_open");
          toast("Confirmations aren't open yet — the database table is still being set up.");
          return;
        }
        if (j && j.ok) {
          confirmCache.set(reportId, j.counts);
          renderConfirmCounts(j.counts);
          document.querySelectorAll("#confirm-row button").forEach((b) => {
            b.className = "";
            if (b.dataset.vote === vote) b.classList.add("sel-" + vote);
          });
          toast("Thank you — your confirmation is counted.");
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => toast("Couldn't reach the server — try again."));
  }
  // Reliability from report history — "no history yet" when there is none.
  function loadReliability(stationId) {
    const box = $("reliability-box");
    if (!box) return;
    if (historyCache.has(stationId)) { renderReliability(stationId, historyCache.get(stationId)); return; }
    fetch(`/api/reports?station=${encodeURIComponent(stationId)}`)
      .then((r) => r.json())
      .then((j) => {
        const rows = (j && j.reports) || [];
        historyCache.set(stationId, rows);
        renderReliability(stationId, rows);
      })
      .catch(() => { box.innerHTML = `<p class="small">Report history could not be loaded.</p>`; });
  }
  function renderReliability(stationId, rows) {
    const box = $("reliability-box");
    if (!box) return;
    if (!rows || !rows.length) {
      box.innerHTML = `<p class="small">No report history yet for this station — nobody has reported here in the last 30 days.</p>`;
      return;
    }
    const avail = rows.filter((r) => r.status === "available").length;
    const pct = Math.round((avail / rows.length) * 100);
    box.innerHTML = `<p><b>${rows.length} report(s)</b> in the last 30 days · <b>${pct}%</b> said gas was available.</p>` +
      `<p class="small">Based only on driver reports — not a guarantee. The fresher the report, the more it matters.</p>`;
  }

  // ---------------- reporting ----------------
  function openReport(id) {
    const s = stations.find((x) => x.id === id);
    if (!s) return;
    currentStation = id;
    reportStatus = null;
    $("report-title").textContent = "Report: " + s.name;
    $("report-queue").value = "";
    document.querySelectorAll(".report-btn").forEach((b) => {
      b.className = "report-btn";
      b.onclick = () => {
        reportStatus = b.dataset.status;
        document.querySelectorAll(".report-btn").forEach((x) => { x.className = "report-btn"; });
        b.classList.add("sel-" + reportStatus);
      };
    });
    $("report-msg").classList.add("hidden");
    $("report-backdrop").classList.add("open");
  }
  window.openReport = openReport;
  function postReport(payload) {
    return fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
  }
  function submitReport() {
    const msg = $("report-msg");
    if (!reportStatus) {
      msg.textContent = "Pick one: Gas available, Low, Finished or Closed.";
      msg.className = "notice err"; msg.classList.remove("hidden");
      return;
    }
    const q = parseInt($("report-queue").value, 10);
    const queue = Number.isFinite(q) && q >= 0 ? Math.min(q, 600) : null;
    const tri = (id) => { const v = $(id).value; return v === "" ? null : v === "yes"; };
    const payload = {
      station_id: currentStation, status: reportStatus, queue_minutes: queue,
      pressure_ok: tri("report-pressure"), compressor_ok: tri("report-compressor"),
    };
    postReport(payload)
      .then((j) => {
        if (j && j.configured === false) {
          msg.textContent = "The reporting server is not available right now — your report was NOT saved. Please try again later.";
          msg.className = "notice err"; msg.classList.remove("hidden");
          return;
        }
        if (j && j.ok) {
          reports.set(currentStation, { id: (j.report && j.report.id) || null, status: reportStatus, queue,
            pressure: payload.pressure_ok, compressor: payload.compressor_ok, ts: Date.now() });
          $("report-backdrop").classList.remove("open");
          toast("Thank you — your report is live for the next 2 hours.");
          refreshStatuses();
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => {
        msg.textContent = "Couldn't reach the server — try again. Your report was NOT saved.";
        msg.className = "notice err"; msg.classList.remove("hidden");
      });
  }
  // "Back to normal" — files a report with status 'available' (no schema change).
  function backToNormal(id) {
    postReport({ station_id: id, status: "available", queue_minutes: null, pressure_ok: null, compressor_ok: null })
      .then((j) => {
        if (j && j.ok) {
          reports.set(id, { id: (j.report && j.report.id) || null, status: "available", queue: null,
            pressure: null, compressor: null, ts: Date.now() });
          toast("Thank you — marked as back to normal for the next 2 hours.");
          refreshStatuses();
        } else if (j && j.configured === false) {
          toast("The reporting server is not available — nothing was saved.");
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => toast("Couldn't reach the server — try again."));
  }
  window.backToNormal = backToNormal;

  // ---------------- listing reports ----------------
  function openListing(id, type) {
    const s = stations.find((x) => x.id === id);
    if (!s) return;
    listingStation = id;
    $("listing-title").textContent = "Report: " + s.name;
    document.querySelectorAll('input[name="listing-type"]').forEach((r) => {
      r.checked = r.value === type;
    });
    $("listing-details").value = "";
    $("listing-msg").classList.add("hidden");
    $("listing-backdrop").classList.add("open");
  }
  window.openListing = openListing;
  function submitListing() {
    const msg = $("listing-msg");
    const type = (document.querySelector('input[name="listing-type"]:checked') || {}).value || "other";
    const details = $("listing-details").value.trim();
    fetch("/api/listing-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ station_id: listingStation, report_type: type, details }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error === "not_open") {
          msg.textContent = "Listing reports aren't open yet — the database table is still being set up. Nothing was saved; please try again later.";
          msg.className = "notice"; msg.classList.remove("hidden");
          return;
        }
        if (j && j.ok) {
          $("listing-backdrop").classList.remove("open");
          toast("Thank you — a moderator will review this listing.");
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => {
        msg.textContent = "Couldn't reach the server — try again. Your report was NOT saved.";
        msg.className = "notice err"; msg.classList.remove("hidden");
      });
  }

  // ---------------- route planner: REMOVED in 2.4 (18 Nov 2026) ----------------
  // Saheed asked for it to go: the map is not accurate enough overall and
  // routing did not pick some areas. The OSRM driving-route code, Nominatim
  // place lookup, auto stop suggestion, ETA-ring legs and the route map all
  // lived here. The ETA rings on the nearest-stations list (etaRing) are
  // NOT part of the planner and stay.

  // ---------------- calculator ----------------
  function calc() {
    const v = F.VEHICLES[$("calc-vehicle").value];
    const kmDay = Math.max(0, parseFloat($("calc-km").value) || 0);
    const days = Math.max(1, Math.min(31, parseInt($("calc-days").value, 10) || 26));
    const kpl = Math.max(1, parseFloat($("calc-kpl").value) || v.kmPerLitre);
    const petrol = Math.max(0, parseFloat($("calc-petrol").value) || F.PRICES.petrolPerLitre);
    const cng = Math.max(0, parseFloat($("calc-cng").value) || v.cngPrice);
    const cost = Math.max(0, parseFloat($("calc-cost").value) || 0);
    const kmMonth = kmDay * days;
    const litres = kmMonth / kpl;
    const scm = kmMonth / (kpl * F.SCM_PER_LITRE_EQUIV);
    const petrolCost = litres * petrol;
    const cngCost = scm * cng;
    const saving = Math.max(0, petrolCost - cngCost);
    const annual = saving * 12;
    const pct = petrolCost > 0 ? Math.round((saving / petrolCost) * 100) : 0;
    let payback;
    if (saving <= 0) payback = "—";
    else if (cost > 0) payback = Math.ceil(cost / saving) + " months";
    else payback = Math.ceil(v.convLow / saving) + "–" + Math.ceil(v.convHigh / saving) + " months";
    $("calc-out").innerHTML =
      `<div class="card calc-out"><p style="margin:0">You would save about</p>` +
      `<div class="big-num">${naira(saving)} / month</div>` +
      `<p style="margin:4px 0 0">${naira(annual)} / year · ${pct}% cheaper than petrol on fuel alone</p></div>` +
      `<div class="card">` +
      `<div class="calc-row"><span>Petrol cost / month</span><b>${naira(petrolCost)}</b></div>` +
      `<div class="calc-row"><span>CNG cost / month</span><b>${naira(cngCost)}</b></div>` +
      `<div class="calc-row"><span>Annual saving</span><b>${naira(annual)}</b></div>` +
      `<div class="calc-row"><span>Distance / month</span><b>${kmMonth.toLocaleString()} km</b></div>` +
      `<div class="calc-row"><span>Petrol needed</span><b>${litres.toFixed(0)} litres</b></div>` +
      `<div class="calc-row"><span>CNG needed</span><b>${scm.toFixed(0)} SCM</b></div>` +
      `<div class="calc-row payback"><span>Conversion pays for itself in</span><b>${payback}</b></div>` +
      `</div><p class="small">${cost > 0 ? "Payback uses the conversion cost you entered (" + naira(cost) + "). " : esc(v.convLabel) + " "}Drivers report saving 50–75% on fuel in real life. ` +
      `This is fuel cost only — it does not count time spent queuing or extra plug/coil maintenance. ` +
      `1 SCM of CNG ≈ the energy of ~1.1 litres of petrol (estimate).</p>`;
    saveVehicleProfile();
  }
  function saveVehicleProfile() {
    try {
      localStorage.setItem(VEHICLE_KEY, JSON.stringify({
        vehicle: $("calc-vehicle").value,
        km: $("calc-km").value, days: $("calc-days").value,
        cost: $("calc-cost").value,
      }));
    } catch { /* ignore */ }
  }
  function loadVehicleProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(VEHICLE_KEY) || "null");
      if (!p) return;
      if (p.vehicle && F.VEHICLES[p.vehicle]) $("calc-vehicle").value = p.vehicle;
      if (p.km) $("calc-km").value = p.km;
      if (p.days) $("calc-days").value = p.days;
      if (p.cost) $("calc-cost").value = p.cost;
    } catch { /* ignore */ }
  }
  function calcVehicleChange() {
    const v = F.VEHICLES[$("calc-vehicle").value];
    $("calc-kpl").value = v.kmPerLitre;
    $("calc-cng").value = v.cngPrice;
    calc();
  }

  // ---------------- safety language toggle (EN / Pidgin) ----------------
  function initSafetyLang() {
    ["safety-lead", "safety-causes", "safety-myths", "safety-checklist"].forEach((id) => {
      const el = $(id);
      if (el) safetyEn[id] = el.innerHTML;
    });
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.addEventListener("click", () => setSafetyLang(b.dataset.lang)));
  }
  function setSafetyLang(lang) {
    safetyLang = lang;
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.classList.toggle("on", b.dataset.lang === lang));
    const map = { "safety-lead": "lead", "safety-causes": "causes", "safety-myths": "myths", "safety-checklist": "checklist" };
    Object.entries(map).forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = lang === "pcm" && F.SAFETY_PCM[key] ? F.SAFETY_PCM[key] : safetyEn[id];
    });
  }

  // ---------------- deep links ----------------
  // ?station=CNG-XXX (shareable detail), ?state=Lagos (state page),
  // ?view=safety (or #safety for backwards compatibility).
  function handleDeepLink() {
    const params = new URLSearchParams(location.search);
    const station = params.get("station");
    const state = params.get("state");
    const view = params.get("view");
    const hash = (location.hash || "").replace("#", "");
    if (station) { openStation(station); return; }
    if (state) {
      showView("stations");
      const sel = $("state-filter");
      if (sel && [...sel.options].some((o) => o.value === state)) {
        sel.value = state;
        listShown = 50; renderStations();
      }
      return;
    }
    if (view && VIEWS.includes(view) && view !== "map") { showView(view); return; }
    if (hash && VIEWS.includes(hash) && hash !== "map") showView(hash);
  }

  // ---------------- wiring ----------------
  function init() {
    try { initMap(); } catch (e) { mapFallback("Something went wrong loading the map. The rest of the app still works."); }
    initSafetyLang();
    $("postcode-go").addEventListener("click", postcodeGo);
    $("postcode-input").addEventListener("keydown", (e) => { if (e.key === "Enter") postcodeGo(); });
    $("gps-go").addEventListener("click", gpsGo);
    document.querySelectorAll("[data-map-layer]").forEach((b) =>
      b.addEventListener("click", () => setMapLayer(b.dataset.mapLayer)));
    $("map-search-go").addEventListener("click", () => {
      $("station-search").value = $("map-search").value;
      listShown = 50; showView("stations"); renderStations();
    });
    $("map-search").addEventListener("keydown", (e) => { if (e.key === "Enter") $("map-search-go").click(); });
    // Filter panel
    $("filter-btn").addEventListener("click", () => $("filter-panel").classList.toggle("hidden"));
    $("filter-available").addEventListener("change", (e) => { filters.availableOnly = e.target.checked; });
    $("filter-outages").addEventListener("change", (e) => { filters.outagesOnly = e.target.checked; });
    document.querySelectorAll(".chip[data-map-type]").forEach((c) =>
      c.addEventListener("click", () => {
        const on = c.classList.toggle("on");
        if (on) filters.types.add(c.dataset.mapType);
        else filters.types.delete(c.dataset.mapType);
      }));
    $("filter-apply").addEventListener("click", () => {
      $("filter-panel").classList.add("hidden");
      renderMapMarkers(); renderNearest();
    });
    $("filter-reset").addEventListener("click", () => {
      filters = { availableOnly: false, outagesOnly: false, types: new Set(), operators: new Set(), categories: new Set() };
      $("filter-available").checked = false;
      $("filter-outages").checked = false;
      document.querySelectorAll("#filter-panel .chip.on").forEach((c) => c.classList.remove("on"));
      document.querySelectorAll("#operator-list input").forEach((cb) => { cb.checked = false; });
      renderMapMarkers(); renderNearest();
    });
    // Stations list
    $("station-search").addEventListener("input", () => { listShown = 50; renderStations(); });
    $("state-filter").addEventListener("change", () => { listShown = 50; renderStations(); });
    document.querySelectorAll(".chip[data-type]").forEach((c) =>
      c.addEventListener("click", () => {
        const wasOn = c.classList.contains("on");
        document.querySelectorAll(".chip[data-type]").forEach((x) => x.classList.remove("on"));
        if (!wasOn) c.classList.add("on");
        listShown = 50; renderStations();
      }));
    document.querySelectorAll(".chip[data-sort]").forEach((c) =>
      c.addEventListener("click", () => {
        document.querySelectorAll(".chip[data-sort]").forEach((x) => x.classList.remove("on"));
        c.classList.add("on");
        sortMode = c.dataset.sort;
        listShown = 50; renderStations();
      }));
    $("station-more").addEventListener("click", () => { listShown += 50; renderStations(); });
    // Centres
    $("installer-go").addEventListener("click", checkInstaller);
    $("installer-search").addEventListener("keydown", (e) => { if (e.key === "Enter") checkInstaller(); });
    $("centre-search").addEventListener("input", () => { centresShown = 50; renderCentres(); });
    $("centre-state-filter").addEventListener("change", () => { centresShown = 50; renderCentres(); });
    $("centre-more").addEventListener("click", () => { centresShown += 50; renderCentres(); });
    // Calculator
    ["calc-vehicle", "calc-km", "calc-days", "calc-kpl", "calc-petrol", "calc-cng", "calc-cost"].forEach((id) => {
      $(id).addEventListener("input", id === "calc-vehicle" ? calcVehicleChange : calc);
      $(id).addEventListener("change", id === "calc-vehicle" ? calcVehicleChange : calc);
    });
    // Sheets
    $("report-submit").addEventListener("click", submitReport);
    $("listing-submit").addEventListener("click", submitListing);
    $("report-backdrop").addEventListener("click", (e) => { if (e.target === $("report-backdrop")) $("report-backdrop").classList.remove("open"); });
    $("listing-backdrop").addEventListener("click", (e) => { if (e.target === $("listing-backdrop")) $("listing-backdrop").classList.remove("open"); });
    $("report-close").addEventListener("click", () => $("report-backdrop").classList.remove("open"));
    $("listing-close").addEventListener("click", () => $("listing-backdrop").classList.remove("open"));
    $("station-back").addEventListener("click", () => showView(prevView || "map"));
    // Defaults
    $("calc-petrol").value = F.PRICES.petrolPerLitre;
    $("calc-cng").value = F.PRICES.cngPerScmCar;
    $("calc-kpl").value = F.VEHICLES.car.kmPerLitre;
    loadVehicleProfile();
    $("price-note").textContent = F.PRICES.priceNote + " Prices as of " + F.PRICES.priceDate + ".";
    calc();
    // Offline cache (app shell + station list; API calls are never cached).
    if ("serviceWorker" in navigator) {
      // When a new service worker takes over, refresh once so the page
      // shows the new release instead of the old cached shell — but
      // only if this page already had a controller when it loaded, so
      // first visits (no controller yet) do not reload. (18 Nov 2026:
      // Saheed kept seeing the previous release's data because the page
      // rendered from the old cache before the new worker activated.)
      var hadController = !!navigator.serviceWorker.controller;
      var refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (hadController && !refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        // Force an update check on load too: a tab restored from the
        // back-forward cache is not a navigation, so the browser would
        // otherwise not check for a new worker until the next visit.
        if (reg) reg.update().catch(function () {});
      }).catch(function () {});
    }
    // Load data after first paint
    requestAnimationFrame(() => {
      loadStations();
      loadReports();
      setInterval(loadReports, 5 * 60 * 1000); // refresh live reports
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
