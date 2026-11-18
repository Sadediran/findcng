/* FindCNG Nigeria — 2.0 app logic. Plain JS, no framework.
   Data: data/stations.json + data/stats.json (build-time, computed from the
   master dataset — never hardcoded). Runtime counts from /api/centres.
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

  // ---------------- state ----------------
  let stations = [];            // all entries (seed + approved submissions)
  let stats = null;             // data/stats.json (build-time, computed)
  let runtimeCounts = null;     // { verified, pending } from /api/centres
  let runtimeCountsFailed = false;
  let dataLoaded = false;
  let reports = new Map();      // stationId -> latest fresh report {id,status,queue,pressure,compressor,ts}
  let reportsLive = false;      // true once /api/reports has answered OK
  let userLoc = null;           // { lat, lng, label }
  let map = null, clusterLayer = null, userMarker = null;
  let lightTiles = null, darkTiles = null, darkOn = false;
  let routeMap = null, routeLayer = null, routePins = { from: null, to: null };
  let routeState = null;        // { routes, selected, stops, fallback }
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
  function fmtDur(mins) {
    if (mins < 60) return Math.round(mins) + " min";
    const h = Math.floor(mins / 60), m = Math.round(mins % 60);
    return h + " hr" + (m ? " " + m + " min" : "");
  }
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
  // Four DISTINCT verification badges — never one green badge for all.
  function verifyBadge(s) {
    if (s.verifiedDate) {
      return `<span class="badge ind">✓ Independently verified · ${new Date(s.verifiedDate).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}</span>`;
    }
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
  const VIEWS = ["map", "stations", "centres", "route", "station", "outages",
    "safety", "calculator", "news", "help", "privacy", "register", "about", "more"];
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
    if (name === "route") initRouteMapSoon();
    if (name === "register") initRegisterMapSoon();
    if (name === "outages") renderOutages();
    if (name === "more") renderFavs();
  }
  window.showView = showView;
  document.querySelectorAll(".bottomnav button").forEach((b) => {
    b.addEventListener("click", () => showView(b.dataset.view));
  });

  // ---------------- data loading ----------------
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
        $("map-count").textContent = stations.length + " stations & centres nationwide · " +
          stations.filter((s) => s.lat).length + " on the map (only these have coordinates so far)";
        return loadApprovedCentres();
      })
      .then(() => handleDeepLink())
      .catch(() => {
        $("map-count").textContent = "Could not load the station list. Check your connection and reload.";
      });
  }
  function loadApprovedCentres() {
    return fetch("/api/centres")
      .then((r) => r.json())
      .then((j) => {
        if (j && j.counts) { runtimeCounts = j.counts; renderStats(); }
        if (!j || !j.centres || !j.centres.length) return;
        const existing = new Set(stations.map((s) => s.id));
        j.centres.forEach((c) => {
          if (existing.has(c.id)) return;
          stations.push({
            id: c.id, name: c.name, type: "conversion", operator: c.operator,
            address: c.address, city: c.city, state: c.state, zone: "",
            postcode: c.postcode || null, lat: c.latitude, lng: c.longitude,
            phone: c.phone || null, confidence: "verified", acc: false,
            refReg: false, src: "Verified via FindCNG", verifiedDate: c.verification_date,
          });
        });
        populateStateFilters();
        renderStations();
        renderCentres();
        renderMapMarkers();
        renderNearest();
      })
      .catch(() => { /* approved centres are optional; seed data still works */
        runtimeCountsFailed = true; renderStats();
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
      statTile(stats.with_coordinates.toLocaleString(), "With coordinates", stats.with_coordinates_label);
    const live = runtimeCounts
      ? statTile(runtimeCounts.verified.toLocaleString(), "Independently verified (live)", "Centres registered here that passed human verification.", true) +
        statTile(runtimeCounts.pending.toLocaleString(), "Pending verification (live)", "Submissions awaiting review — not listed publicly until approved.", true)
      : runtimeCountsFailed
      ? statTile("—", "Independently verified / pending (live)", "Live counts could not be reached — check your connection.")
      : statTile("—", "Independently verified / pending (live)", "Loading live counts…");
    const grid = `<div class="stat-grid">${tiles}${live}</div>` +
      `<p class="tiny" style="margin:8px 0 0">Directory numbers computed from the dataset on ${esc(stats.generated)}. Live counts come from the verification queue right now.</p>`;
    const home = $("home-stats");
    if (home) home.innerHTML = grid;
    const about = $("about-stats");
    if (about) about.innerHTML = grid;
    // Hero stats — same source, three headline numbers.
    const hero = $("hero-stats");
    if (hero) hero.innerHTML =
      `<div class="hero-stat"><b>${stats.total_records.toLocaleString()}</b><span>stations &amp; centres</span></div>` +
      `<div class="hero-stat"><b>${stats.states_with_data} / 37</b><span>states + FCT</span></div>` +
      `<div class="hero-stat"><b>${stats.with_coordinates.toLocaleString()}</b><span>on the map</span></div>`;
    const lede = $("stations-lede");
    if (lede) lede.textContent = `Every CNG refuelling station and conversion centre in the dataset — ${stats.total_records} entries across ${stats.states_with_data} states. Search by name, town or operator.`;
    const nodata = $("nodata-note");
    if (nodata) {
      nodata.textContent = stats.no_data_states.length
        ? `${stats.no_data_states.length} states have no data yet: ${stats.no_data_states.join(", ")}. If you know a station or centre in one of them, ask it to register — see “Add your centre”.`
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
  function initMap() {
    if (map) return;
    if (!leafletReady()) {
      mapFallback("Check your connection and reload the page. The map needs to download its mapping library.");
      return;
    }
    map = L.map("map", { zoomControl: true }).setView(F.NIGERIA_CENTRE, F.NIGERIA_ZOOM);
    lightTiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
    darkTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    });
    lightTiles.addTo(map);
    try { darkOn = localStorage.getItem("findcng_darkmap") === "1"; } catch { darkOn = false; }
    if (darkOn) { map.removeLayer(lightTiles); darkTiles.addTo(map); $("dark-toggle").setAttribute("aria-pressed", "true"); $("dark-toggle").textContent = "☀️ Light map"; }
    map.on("click", (e) => setUserLoc(e.latlng.lat, e.latlng.lng, "Dropped pin"));
    map.on("moveend", renderMapMarkers);
    clusterLayer = L.layerGroup().addTo(map);
  }
  function toggleDarkMap() {
    if (!map) return;
    darkOn = !darkOn;
    if (darkOn) { map.removeLayer(lightTiles); darkTiles.addTo(map); }
    else { map.removeLayer(darkTiles); lightTiles.addTo(map); }
    try { localStorage.setItem("findcng_darkmap", darkOn ? "1" : "0"); } catch { /* ignore */ }
    $("dark-toggle").setAttribute("aria-pressed", String(darkOn));
    $("dark-toggle").textContent = darkOn ? "☀️ Light map" : "🌙 Dark map";
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
    return `<b>${esc(s.name)}</b><br>${esc(s.address || "")}<br>${esc(s.city || "")}, ${esc(s.state)}${d}<br>` +
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
      box.innerHTML = `<div class="empty"><p>No mapped stations near you yet — only ${stations.filter((s) => s.lat).length} of ${stations.length} entries have coordinates so far. Use the Stations tab to browse the full list by state.</p></div>`;
      return;
    }
    box.innerHTML = `<h3>Nearest mapped stations</h3>` + near.map(({ s, d }) =>
      `<div class="card station st-${statusOf(s.id)}" data-id="${s.id}" style="display:flex;gap:10px;align-items:center">` +
      etaRing(d * 1.5) +
      `<div style="flex:1;min-width:0"><h3>${esc(s.name)}</h3>` +
      `<p class="meta">${esc(s.address || "")} · ${esc(s.city || "")}, ${esc(s.state)} · <span class="dist-chip">${fmtKm(d)}</span></p>` +
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
      `<p class="meta">${esc(s.city || "")}, ${esc(s.state)}${d}${noc}</p>` +
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
        : `<div class="empty"><div class="big">🔍</div><p><b>Nothing matches that search.</b></p><p>Try a different spelling, or clear the state filter. If a real station is missing, it can be added — see “Add your centre”.</p></div>`);
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
    const verifiedHits = stations.filter((s) => s.verifiedDate && normName(s.name).includes(nq)).slice(0, 8);
    if (hits.length || verifiedHits.length) {
      const all = [...verifiedHits, ...hits.filter((h) => !verifiedHits.includes(h))].slice(0, 8);
      box.innerHTML = `<div class="notice ok"><b>✓ Found — ${all.length} match${all.length > 1 ? "es" : ""}:</b></div>` +
        all.map((s) => `<div class="card station" data-id="${s.id}"><h3>${esc(s.name)}</h3>` +
          `<p class="meta">${esc(s.address || "")} · ${esc(s.city || "")}, ${esc(s.state)}</p>` +
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
      `<p class="hero-addr">${esc(s.address || "")}<br>${esc(s.city || "")}, ${esc(s.state)}${s.postcode ? " · Postcode " + esc(s.postcode) : ""}</p>` +
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
      (!s.lat ? `<p class="notice">This entry has no map position yet — its coordinates have not been recorded. The address above is what we have. If you know the exact spot, ask the centre to register with a GPS pin.</p>` : "") +
      `<p class="small">Source: ${esc(s.src)}${s.verifiedDate ? " · Verified " + new Date(s.verifiedDate).toLocaleDateString("en-NG") : s.acc ? " · Checked 18 Nov 2026" : ""} · Listing ID ${esc(s.id)}</p>`;
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

  // ---------------- route planner ----------------
  // OSRM public API (free, no key) for driving routes. If OSRM is
  // unreachable, a straight-line corridor version is shown and labelled.
  const OSRM = "https://router.project-osrm.org/route/v1/driving";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ng&q=";
  function initRouteMapSoon() {
    setTimeout(() => {
      if (routeMap) { routeMap.invalidateSize(); return; }
      if (!leafletReady()) return;
      routeMap = L.map("route-map", { zoomControl: true }).setView(F.NIGERIA_CENTRE, F.NIGERIA_ZOOM);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(routeMap);
      routeLayer = L.layerGroup().addTo(routeMap);
      routeMap.on("click", (e) => {
        // Pin mode: the next tap sets whichever endpoint is waiting for a pin.
        if ($("route-from-type").value === "pin" && !routePins.from) {
          routePins.from = { lat: e.latlng.lat, lng: e.latlng.lng, label: "Pinned point" };
          toast("Starting point set from the map.");
        } else if ($("route-to-type").value === "pin" && !routePins.to) {
          routePins.to = { lat: e.latlng.lat, lng: e.latlng.lng, label: "Pinned point" };
          toast("Destination set from the map.");
        }
        drawRoutePins();
      });
    }, 80);
  }
  function drawRoutePins() {
    if (!routeMap || !routeLayer) return;
    routeLayer.clearLayers();
    if (routeState) drawRoute(routeState.selected ?? 0, false);
    ["from", "to"].forEach((k) => {
      const p = routePins[k];
      if (p) L.circleMarker([p.lat, p.lng], { radius: 9, color: "#fff", weight: 2,
        fillColor: k === "from" ? "#0b6e4f" : "#d64545", fillOpacity: 1 }).addTo(routeLayer)
        .bindPopup(esc((k === "from" ? "Start: " : "Destination: ") + p.label));
    });
  }
  function fillStationSelects() {
    const mapped = stations.filter((s) => s.lat && s.lng && s.type !== "conversion")
      .sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name));
    ["route-from-station", "route-to-station"].forEach((id) => {
      const sel = $(id);
      sel.innerHTML = mapped.length
        ? mapped.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.city || "")}, ${esc(s.state)}</option>`).join("")
        : `<option value="">No mapped refuelling stations yet</option>`;
    });
  }
  function geocodePlace(q) {
    return fetch(NOMINATIM + encodeURIComponent(q + ", Nigeria"))
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.length) return null;
        return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), label: j[0].display_name.split(",").slice(0, 2).join(",") };
      })
      .catch(() => null);
  }
  function gpsPoint() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Your location (GPS)" }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });
  }
  async function resolveEndpoint(which) {
    const type = $(`route-${which}-type`).value;
    if (type === "gps") {
      if (userLoc) return { lat: userLoc.lat, lng: userLoc.lng, label: userLoc.label };
      return gpsPoint();
    }
    if (type === "station") {
      const s = stations.find((x) => x.id === $(`route-${which}-station`).value);
      return s ? { lat: s.lat, lng: s.lng, label: s.name, stationId: s.id } : null;
    }
    if (type === "pin") {
      return routePins[which];
    }
    const q = $(`route-${which}`).value.trim();
    if (!q) return null;
    return geocodePlace(q);
  }
  function osrmRoute(coords, alternatives) {
    const path = coords.map((c) => `${c.lng},${c.lat}`).join(";");
    const url = `${OSRM}/${path}?overview=full&geometries=geojson&alternatives=${alternatives ? "true" : "false"}&steps=false`;
    return fetch(url).then((r) => r.json()).then((j) => {
      if (!j || j.code !== "Ok" || !j.routes || !j.routes.length) return null;
      return j.routes;
    }).catch(() => null);
  }
  // Stations within `corridorKm` of the route line, ordered along the route.
  function stationsAlongRoute(geometry, corridorKm) {
    const pts = geometry.coordinates;
    const step = Math.max(1, Math.floor(pts.length / 400));
    const sampled = [];
    for (let i = 0; i < pts.length; i += step) sampled.push(pts[i]);
    sampled.push(pts[pts.length - 1]);
    const cands = [];
    stations.filter((s) => s.lat && s.lng && s.type !== "conversion").forEach((s) => {
      let best = Infinity, bestIdx = 0;
      sampled.forEach((p, i) => {
        const d = haversineKm(s.lat, s.lng, p[1], p[0]);
        if (d < best) { best = d; bestIdx = i; }
      });
      if (best <= corridorKm) cands.push({ s, distToRoute: best, alongIdx: bestIdx });
    });
    // Route distance of each sample point (cumulative).
    let cum = 0;
    const cumDist = [0];
    for (let i = 1; i < sampled.length; i++) {
      cum += haversineKm(sampled[i - 1][1], sampled[i - 1][0], sampled[i][1], sampled[i][0]);
      cumDist.push(cum);
    }
    cands.forEach((c) => { c.alongKm = cumDist[c.alongIdx] || 0; });
    cands.sort((a, b) => a.alongKm - b.alongKm);
    return { cands, totalKm: cum };
  }
  function pickStops(cands, totalKm, rangeKm) {
    const stops = [];
    let lastKm = 0;
    cands.forEach((c) => {
      if (c.alongKm < rangeKm * 0.5) return;           // too early to need fuel
      if (totalKm - c.alongKm < 10) return;            // too close to the end
      if (c.alongKm - lastKm < rangeKm * 0.7) return;  // too close to last stop
      stops.push(c);
      lastKm = c.alongKm;
    });
    return stops;
  }
  async function planRoute() {
    const msg = $("route-msg");
    const out = $("route-out");
    msg.textContent = "Planning your route…";
    msg.className = "notice"; msg.classList.remove("hidden");
    out.innerHTML = "";
    const from = await resolveEndpoint("from");
    const to = await resolveEndpoint("to");
    if (!from || !to) {
      msg.textContent = "Could not place one of the two points. " +
        (!from ? "Check the starting point — for a place name, try a town or area name. " : "") +
        (!to ? "Check the destination." : "") +
        "For a map pin, tap the route map below first.";
      msg.className = "notice err"; msg.classList.remove("hidden");
      return;
    }
    const rangeKm = Math.max(20, Math.min(600, parseFloat($("route-range").value) || 150));
    const auto = $("route-auto").checked;
    const routes = await osrmRoute([from, to], true);
    if (routes) {
      routeState = { routes, from, to, rangeKm, auto, fallback: false, stopsByRoute: {} };
      if (auto) routeState.stopsByRoute[0] = await stopsForRoute(0);
      renderRoute(0);
      msg.classList.add("hidden");
      return;
    }
    // Straight-line fallback — labelled plainly, never passed off as a road route.
    const dist = haversineKm(from.lat, from.lng, to.lat, to.lng);
    const line = { type: "LineString", coordinates: [[from.lng, from.lat], [to.lng, to.lat]] };
    const { cands } = stationsAlongRoute(line, 10);
    const stops = auto ? pickStops(cands, dist, rangeKm) : [];
    routeState = { routes: null, from, to, rangeKm, auto, fallback: true,
      fallbackRoute: { distance: dist * 1000, duration: (dist / 40) * 3600, geometry: line }, stops };
    renderRoute(-1);
    msg.textContent = "The routing service could not be reached, so this is a straight-line estimate — not a road route. Distances are as the crow flies; real driving distance will be longer.";
    msg.className = "notice"; msg.classList.remove("hidden");
  }
  async function stopsForRoute(idx) {
    const r = routeState.routes[idx];
    const { cands, totalKm } = stationsAlongRoute(r.geometry, 5);
    const stops = pickStops(cands, totalKm, routeState.rangeKm);
    if (!stops.length) return { stops: [], legs: null };
    // Re-route through the stops so each leg has real time/distance.
    const coords = [routeState.from, ...stops.map((c) => ({ lat: c.s.lat, lng: c.s.lng })), routeState.to];
    const via = await osrmRoute(coords, false);
    if (via && via[0] && via[0].legs) return { stops, legs: via[0].legs, geometry: via[0].geometry,
      distance: via[0].distance, duration: via[0].duration };
    return { stops, legs: null };
  }
  function drawRoute(idx, fit = true) {
    if (!routeMap || !routeLayer) return;
    routeLayer.clearLayers();
    const st = routeState;
    let geom = null;
    if (st.fallback) geom = st.fallbackRoute.geometry;
    else if (st.auto && st.stopsByRoute[idx] && st.stopsByRoute[idx].geometry) geom = st.stopsByRoute[idx].geometry;
    else if (st.routes) geom = st.routes[idx].geometry;
    if (geom) {
      const latlngs = geom.coordinates.map((c) => [c[1], c[0]]);
      L.polyline(latlngs, { color: st.fallback ? "#d99300" : "#0b6e4f", weight: 5,
        dashArray: st.fallback ? "10 8" : null }).addTo(routeLayer);
      if (fit) routeMap.fitBounds(L.polyline(latlngs).getBounds().pad(0.15));
    }
    const stops = st.fallback ? st.stops : (st.stopsByRoute[idx] ? st.stopsByRoute[idx].stops : []);
    (stops || []).forEach((c) => {
      L.marker([c.s.lat, c.s.lng], { icon: markerIcon(statusOf(c.s.id), c.s.type, coordPrecision(c.s)) })
        .bindPopup(popupHtml(c.s)).addTo(routeLayer);
    });
    [st.from, st.to].forEach((p, i) => {
      L.circleMarker([p.lat, p.lng], { radius: 9, color: "#fff", weight: 2,
        fillColor: i === 0 ? "#0b6e4f" : "#d64545", fillOpacity: 1 }).addTo(routeLayer)
        .bindPopup(esc((i === 0 ? "Start: " : "Destination: ") + p.label));
    });
  }
  function renderRoute(idx) {
    const st = routeState;
    st.selected = idx;
    const out = $("route-out");
    const mapEl = $("route-map");
    mapEl.classList.remove("hidden");
    initRouteMapSoon();
    setTimeout(() => drawRoute(idx), 120);
    let totalKm, totalMin, legsHtml = "", stops = [];
    if (st.fallback) {
      totalKm = st.fallbackRoute.distance / 1000;
      totalMin = st.fallbackRoute.duration / 60;
      stops = st.stops;
      legsHtml = legsFromStops(st.from, stops, st.to, null, totalKm);
    } else {
      const r = st.routes[idx];
      const withStops = st.auto && st.stopsByRoute[idx];
      totalKm = (withStops && st.stopsByRoute[idx].distance ? st.stopsByRoute[idx].distance : r.distance) / 1000;
      totalMin = (withStops && st.stopsByRoute[idx].duration ? st.stopsByRoute[idx].duration : r.duration) / 60;
      stops = withStops ? st.stopsByRoute[idx].stops : [];
      legsHtml = legsFromStops(st.from, stops, st.to, withStops ? st.stopsByRoute[idx].legs : null, totalKm);
    }
    const altHtml = (!st.fallback && st.routes.length > 1)
      ? `<h3>Other routes</h3>` + st.routes.map((r, i) =>
          `<button class="route-alt ${i === idx ? "sel" : ""}" data-route="${i}"><b>${i === 0 ? "Fastest" : "Alternative " + i}</b> · ${fmtDur(r.duration / 60)} · ${fmtKm(r.distance / 1000)}</button>`).join("")
      : "";
    out.innerHTML =
      `<div class="card"><h3 style="margin-top:0">${esc(st.from.label)} → ${esc(st.to.label)}</h3>` +
      `<p style="margin:0"><b>${fmtDur(totalMin)} · ${fmtKm(totalKm)}</b>` +
      (st.fallback ? ` <span class="badge low">Straight-line estimate</span>` : "") +
      (stops.length ? ` · ${stops.length} refuelling stop(s)` : st.auto ? ` · no mapped station found along this route — check the Stations tab for unmapped ones` : "") +
      `</p></div>` +
      `<div class="card">${legsHtml}</div>` +
      altHtml +
      `<p class="small">Driving times come from the routing service and do not include queue time at stations — check live status before you leave, and carry enough fuel to reach the next stop. Road conditions and traffic change everything.</p>`;
    out.querySelectorAll("[data-route]").forEach((b) =>
      b.addEventListener("click", async () => {
        const i = parseInt(b.dataset.route, 10);
        if (st.auto && !st.stopsByRoute[i]) st.stopsByRoute[i] = await stopsForRoute(i);
        renderRoute(i);
      }));
    out.querySelectorAll("[data-station-link]").forEach((el) =>
      el.addEventListener("click", () => openStation(el.dataset.stationLink)));
  }
  // Legs with time/distance between stops + stop cards + ETA rings (images 05, 06).
  function legsFromStops(from, stops, to, legs, totalKm) {
    const points = [{ label: from.label, kind: "start" },
      ...stops.map((c) => ({ label: c.s.name, kind: "stop", station: c.s, alongKm: c.alongKm })),
      { label: to.label, kind: "end" }];
    let html = "";
    let prevKm = 0;
    points.forEach((p, i) => {
      if (i > 0) {
        const leg = legs && legs[i - 1];
        const legKm = leg ? leg.distance / 1000
          : p.kind === "end" ? totalKm - prevKm
          : (p.alongKm || 0) - prevKm;
        const legMin = leg ? leg.duration / 60 : Math.max(1, legKm * 1.5);
        html += `<div class="leg"><div class="leg-line"><div class="leg-stem"></div></div>` +
          `<div style="flex:1"><b>${fmtDur(legMin)} · ${fmtKm(Math.max(0, legKm))}</b> <span class="small">of driving</span></div>` +
          etaRing(legMin) + `</div>`;
        prevKm = p.kind === "end" ? totalKm : (p.alongKm || prevKm);
      }
      const dot = p.kind === "start" ? "" : p.kind === "stop" ? "stop" : "end";
      html += `<div class="leg"><div class="leg-line"><div class="leg-dot ${dot}"></div>${i < points.length - 1 ? `<div class="leg-stem"></div>` : ""}</div>` +
        `<div style="flex:1"><b>${esc(p.label)}</b>` +
        (p.station ? `<br><span class="small">${esc(p.station.address || "")} · ${esc(p.station.city || "")}, ${esc(p.station.state)}</span><br>${statusBadge(p.station.id, true)} ` +
          `<button class="btn outline small" data-station-link="${p.station.id}" style="margin-top:6px">View station</button>` : "") +
        `</div></div>`;
    });
    return html;
  }

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

  // ---------------- registration ----------------
  let regMap = null, regPin = null;
  function initRegisterMapSoon() {
    setTimeout(() => {
      if (regMap) { regMap.invalidateSize(); return; }
      if (!leafletReady()) {
        const el = $("reg-map");
        if (el) el.innerHTML = `<div class="empty"><p>The map could not load — type your latitude and longitude directly, or use the GPS button.</p></div>`;
        return;
      }
      regMap = L.map("reg-map", { zoomControl: true }).setView(F.NIGERIA_CENTRE, F.NIGERIA_ZOOM);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(regMap);
      regMap.on("click", (e) => {
        $("reg-lat").value = e.latlng.lat.toFixed(6);
        $("reg-lng").value = e.latlng.lng.toFixed(6);
        if (regPin) regMap.removeLayer(regPin);
        regPin = L.marker([e.latlng.lat, e.latlng.lng]).addTo(regMap);
      });
    }, 80);
  }
  function regGps() {
    if (!navigator.geolocation) { toast("Your device does not support location."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("reg-lat").value = pos.coords.latitude.toFixed(6);
        $("reg-lng").value = pos.coords.longitude.toFixed(6);
        if (regMap) {
          regMap.setView([pos.coords.latitude, pos.coords.longitude], 15);
          if (regPin) regMap.removeLayer(regPin);
          regPin = L.marker([pos.coords.latitude, pos.coords.longitude]).addTo(regMap);
        }
        toast("Location set from your phone's GPS.");
      },
      () => toast("Could not get your location — tap the map to drop a pin instead."),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result);
      rd.onerror = reject;
      rd.readAsDataURL(file);
    });
  }
  function duplicateCheck(name, address) {
    const nn = normName(name), na = normName(address);
    return stations.find((s) => {
      if (normName(s.name) !== nn) return false;
      const sa = normName(s.address || "");
      const aWords = new Set(na.split(" ").filter((w) => w.length > 2));
      const sWords = new Set(sa.split(" ").filter((w) => w.length > 2));
      let hit = 0;
      aWords.forEach((w) => { if (sWords.has(w)) hit++; });
      return hit >= 2 || (na && sa && (na.includes(sa) || sa.includes(na)));
    });
  }
  async function submitRegistration(ev) {
    ev.preventDefault();
    const msg = $("reg-msg");
    const name = $("reg-name").value.trim();
    const address = $("reg-address").value.trim();
    const state = $("reg-state").value;
    const phone = $("reg-phone").value.trim();
    const body = $("reg-body").value;
    const number = $("reg-number").value.trim();
    const certFile = $("reg-cert").files[0];
    const declared = $("reg-declare").checked;
    if (!name || !address || !state || !phone || !body || !number) {
      msg.textContent = "Please fill in every required field (marked *).";
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    if (!certFile) {
      msg.textContent = "A photo or scan of your accreditation certificate is required — a centre cannot be listed without evidence.";
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    if (certFile.size > 2 * 1024 * 1024) {
      msg.textContent = "The certificate file is too large — please use a photo under 2 MB.";
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    if (!declared) {
      msg.textContent = "Please tick the declaration that the information is true.";
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    const dup = duplicateCheck(name, address);
    if (dup) {
      msg.innerHTML = `This centre looks like it is already listed: <b>${esc(dup.name)}</b> (${esc(dup.address || "")}). ` +
        `If the listing is wrong or out of date, open it and use “Report an incorrect listing” instead of submitting a duplicate.`;
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    msg.textContent = "Sending your submission…";
    msg.className = "notice"; msg.classList.remove("hidden");
    const cert = await fileToBase64(certFile);
    const payload = {
      name, operator: $("reg-operator").value.trim() || name, address,
      city: $("reg-city").value.trim(), state, lga: $("reg-lga").value.trim(),
      phone, email: $("reg-email").value.trim(),
      services: $("reg-services").value.trim(),
      accreditation_body: body, accreditation_number: number,
      certificate: cert, certificate_name: certFile.name,
      latitude: parseFloat($("reg-lat").value) || null,
      longitude: parseFloat($("reg-lng").value) || null,
      submitter_contact: $("reg-contact").value.trim(),
      declaration: true,
    };
    try {
      const r = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j && j.configured === false) {
        msg.textContent = "Submissions are not available right now — the database is not connected. Your submission was NOT saved. Please try again later.";
        msg.className = "notice err"; msg.classList.remove("hidden");
        return;
      }
      if (j && j.ok) {
        msg.innerHTML = `<b>✓ Submission received — now Pending verification.</b> It is in the moderation queue. Nothing goes live until it passes verification (Pi-CNG list cross-check, certificate inspection, phone confirmation). You will not be listed automatically — a moderator reviews every submission.`;
        msg.className = "notice ok"; msg.classList.remove("hidden");
        $("reg-form").reset();
        return;
      }
      throw new Error((j && j.error) || "failed");
    } catch (e) {
      msg.textContent = "Could not send — check your connection and try again. Nothing was saved. " + (e.message || "");
      msg.className = "notice err"; msg.classList.remove("hidden");
    }
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
    $("dark-toggle").addEventListener("click", toggleDarkMap);
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
    // Route planner
    $("route-plan").addEventListener("click", planRoute);
    ["from", "to"].forEach((w) => {
      $(`route-${w}-type`).addEventListener("change", () => {
        const t = $(`route-${w}-type`).value;
        $(`route-${w}`).classList.toggle("hidden", t !== "place");
        $(`route-${w}-station`).classList.toggle("hidden", t !== "station");
        if (t === "pin") {
          routePins[w] = null;
          $("route-map").classList.remove("hidden");
          initRouteMapSoon();
          toast(w === "from" ? "Tap the route map to set your starting point." : "Tap the route map to set your destination.");
        }
      });
    });
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
    // Registration
    $("reg-form").addEventListener("submit", submitRegistration);
    $("reg-gps").addEventListener("click", regGps);
    // Defaults
    $("calc-petrol").value = F.PRICES.petrolPerLitre;
    $("calc-cng").value = F.PRICES.cngPerScmCar;
    $("calc-kpl").value = F.VEHICLES.car.kmPerLitre;
    loadVehicleProfile();
    $("price-note").textContent = F.PRICES.priceNote + " Prices as of " + F.PRICES.priceDate + ".";
    calc();
    fillStationSelects();
    // Offline cache (app shell + station list; API calls are never cached).
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    // Load data after first paint
    requestAnimationFrame(() => {
      loadStations().then(() => fillStationSelects());
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
