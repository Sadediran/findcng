/* FindCNG Nigeria — 2.0 app logic. Plain JS, no framework.
   Data: data/stations.json + data/stats.json (build-time, computed from the
   master dataset — never hardcoded), plus live centres from
   /api/live-centres (2.6): centres on the live Pi-CNG register that are
   not yet in the stored snapshot, shown with a New badge, list-only
   until the daily pipeline verifies a pin.
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
  let liveCentres = [];         // centres on the live Pi-CNG register but not yet in the stored snapshot (2.6)
  let liveState = "pending";    // pending | ok | unavailable
  let liveFetchedAt = null;     // Date of the last successful live fetch
  let liveLoading = false;      // a live fetch is in flight
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
  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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
    // Phase 4 (§20): when live reports cannot be reached (offline, or
    // the API is down), nothing is "available" — the last-known status
    // is never presented as current. The detail page and home feed
    // already withdrew live info in this state; this makes the cards,
    // the map and the filters agree with them.
    if (!reportsLive) return "unconfirmed";
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
  // ---------------- availability confidence (Phase 3, §8) ---------------
  // Every live report is COMMUNITY REPORTED — drivers reporting what they
  // see — UNLESS its source is 'operator' (Phase 4, §15): a report an
  // admin published by approving an operator's availability submission.
  // "Officially verified" stays reserved and unused: no official
  // confirmation feed exists yet.
  //
  // Confidence comes from three honest inputs, and the "why" is always
  // shown next to the level so the user can judge it themselves:
  //   freshness — how old the report is (reports expire after 2 hours)
  //   independent confirmations — net yes votes (yes minus no)
  //   source — community, or operator-confirmed (an operator report from
  //     the station itself, approved by a moderator, is the most
  //     reliable source and raises the level — but a disputed operator
  //     report is still disputed)
  // Levels:
  //   Disputed — more drivers said the report is wrong than right
  //   High     — reported in the last 30 min AND net confirmations >= 2,
  //              OR operator-confirmed in the last 60 min
  //   Medium   — reported in the last 60 min with net >= 1, OR reported
  //              in the last 15 min (a minutes-old report from a driver
  //              at the station, even unconfirmed), OR operator-confirmed
  //              and still inside the 2-hour window
  //   Low      — anything else still inside the 2-hour window
  // A report older than 2 hours has NO confidence at all — it is
  // unconfirmed, never "low confidence live".
  function confidenceFor(ageMs, counts, countsLabel, source) {
    const mins = ageMs / 60000;
    const yes = counts ? (counts.yes || 0) : 0;
    const no = counts ? (counts.no || 0) : 0;
    const net = yes - no;
    const isOperator = source === "operator";
    let level, label;
    if (counts && no > yes && no >= 1) { level = "disputed"; label = "Disputed report"; }
    else if ((mins <= 30 && net >= 2) || (isOperator && mins <= 60)) { level = "high"; label = "High confidence"; }
    else if ((mins <= 60 && net >= 1) || mins <= 15 || isOperator) { level = "medium"; label = "Medium confidence"; }
    else { level = "low"; label = "Low confidence"; }
    const ageBit = mins < 1 ? "Reported just now" : `Reported ${Math.floor(mins)} min ago`;
    const confBit = countsLabel || (!counts ? "confirmations not loaded yet"
      : (yes || no) ? `✓ confirmed by ${yes} driver${yes === 1 ? "" : "s"}${no ? `, ${no} said no` : ""}`
      : "no confirmations yet");
    const why = `${ageBit} · ${confBit} · ${isOperator ? "Operator confirmed" : "Community reported"}` +
      (level === "disputed" ? " — drivers disagree about this report, so treat it with caution" : "");
    return { level, label, why };
  }
  function confidenceChipHtml(conf) {
    return `<span class="conf-chip conf-${conf.level}">${conf.label}</span>`;
  }
  // DISTINCT data-driven badges — never one green badge for all. These
  // describe the DATASET (Pi-CNG register match / stale 2024 list), not a
  // submission: centre self-registration was removed in 2.5 (18 Nov 2026).
  function verifyBadge(s) {
    if (s.live) {
      return s.liveStatus === "active"
        ? `<span class="badge acc">✓ Officially accredited · live Pi-CNG register</span>`
        : `<span class="badge unver">Registered on Pi-CNG — not yet Active</span>`;
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
  // Verification card (Phase 2, §10): every profile shows its
  // verification status + source + last verification date where known.
  // Expired or unconfirmed accreditation is never shown as valid.
  function verificationCard(s) {
    let status, date;
    if (s.live) {
      status = s.liveStatus === "active"
        ? "✓ Officially accredited — live Pi-CNG register."
        : "Registered on the Pi-CNG register, but not yet Active — accreditation is not confirmed.";
      date = s.liveListedAt ? fmtDate(s.liveListedAt) : null;
    } else if (s.acc) {
      status = "✓ Officially accredited — matched on the Pi-CNG accredited centres register.";
      date = F.REGISTER_DATES.centres;
    } else if (s.refReg) {
      status = "✓ On the Pi-CNG refuelling stations register.";
      date = F.REGISTER_DATES.refuel;
    } else if (s.confidence === "stale-2024-list") {
      status = "⚠ Needs re-verification — from a 2024 list, not re-checked against a current source. Treat the details as unconfirmed.";
      date = null;
    } else if (s.confidence === "single-source") {
      status = "Single source — needs a second check before the details can be treated as confirmed.";
      date = null;
    } else {
      status = "Listed from a public source — no Pi-CNG register match, so no accreditation is claimed for this entry.";
      date = null;
    }
    return `<div class="card"><h3 style="margin-top:0">Verification</h3>` +
      `<p style="margin:0 0 6px">${status}</p>` +
      `<p class="small" style="margin:0">Source: ${esc(s.src)}<br>Last verification: ${date ? esc(date) : "not recorded for this entry"}</p></div>`;
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
    "safety", "calculator", "news", "help", "privacy", "about", "more", "chat",
    "intelligence", "postcode", "operator"];
  // Views that live under the More menu: opening one highlights More in
  // the bottom nav (Phase 1).
  const MORE_VIEWS = ["chat", "safety", "calculator", "news", "help",
    "privacy", "about", "intelligence", "postcode", "operator"];
  function showView(name) {
    // Phase 3: the Phase 1 "Coverage & data" view was upgraded into
    // "CNG Intelligence" — old ?view=coverage links still land there.
    if (name === "coverage") name = "intelligence";
    if (!VIEWS.includes(name)) name = "map";
    // The detail view with no station open (e.g. a hand-typed
    // ?view=station) used to render empty — send it home instead.
    if (name === "station" && !currentStation) name = "map";
    if (name !== "station") prevView = name;
    VIEWS.forEach((v) => {
      const el = $("view-" + v);
      if (el) el.classList.toggle("active", v === name);
    });
    document.querySelectorAll(".bottomnav button").forEach((b) => {
      const target = name === "station" ? prevView : name;
      b.classList.toggle("on", b.dataset.view === target ||
        (b.dataset.view === "more" && MORE_VIEWS.includes(target)));
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
    if (name === "intelligence") renderIntelligence();
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
        renderHomeLive();
        renderHomeCentres();
        renderHomeNews();
        renderIntelligence();
        handleDeepLink();
        loadLiveCentres(); // non-blocking: newly listed centres join the lists when they arrive
      })
      .catch(() => {
        $("map-count").textContent = "Could not load the station list. Check your connection and reload.";
      });
  }
  // ---------------- live centres (2.6) ----------------
  // The stored snapshot is rebuilt daily; /api/live-centres reads the
  // Pi-CNG register live so centres listed since the last rebuild show
  // up within the hour (Saheed, 18 Nov 2026: the directory must display
  // live, not stored alone). Live centres are list-only — the API's
  // coordinates are unusable (mostly (0,0) or 2-decimal) — until the
  // daily pipeline verifies a pin. Matching is by picng_id where the
  // stored entry carries it, else by normalised name + state. A failed
  // fetch leaves the stored list untouched: the directory never depends
  // on the live register.
  function allStations() { return stations.concat(liveCentres); }
  function findStation(id) {
    return stations.find((x) => x.id === id) || liveCentres.find((x) => x.id === id) || null;
  }
  function loadLiveCentres() {
    if (liveLoading) return Promise.resolve();
    liveLoading = true;
    return fetch("/api/live-centres")
      .then((r) => r.json())
      .then((j) => {
        liveLoading = false;
        if (!j || !j.ok || !Array.isArray(j.rows)) { liveState = "unavailable"; renderLiveNote(); return; }
        const byPicng = new Map();
        const byNameState = new Set();
        stations.forEach((s) => {
          if (s.picng_id != null) byPicng.set(s.picng_id, true);
          byNameState.add(normName(s.name) + "|" + String(s.state || "").toLowerCase());
        });
        liveCentres = j.rows
          .filter((r) => {
            if (r.id != null && byPicng.has(r.id)) return false;
            if (byNameState.has(normName(r.name) + "|" + String(r.state || "").toLowerCase())) return false;
            return r.name && r.state; // an entry needs at least a name + state
          })
          .map((r) => ({
            id: "LIVE-" + r.id,
            picng_id: r.id,
            name: r.name,
            type: "conversion",
            operator: null,
            address: r.address || null,
            city: r.lga || null, // the API has no city field; the LGA is the locality
            state: r.state,
            zone: null,
            postcode: null,
            lat: null,
            lng: null,
            phone: null,
            confidence: null,
            acc: r.status === true,
            refReg: false,
            src: "Pi-CNG live register",
            live: true,
            liveStatus: r.status === true ? "active" : "registered",
            liveListedAt: r.createdAt || null,
          }))
          .sort((a, b) => (Date.parse(b.liveListedAt || "") || 0) - (Date.parse(a.liveListedAt || "") || 0));
        liveState = "ok";
        liveFetchedAt = new Date();
        renderLiveNote();
        populateStateFilters(); // a live centre can add a state to the filter
        renderStations();
        renderCentres();
        renderNearest();
        // A ?station=LIVE-… deep link could only resolve once the live
        // data arrived; re-run the deep link now.
        if (!currentStation) handleDeepLink();
      })
      .catch(() => {
        liveLoading = false;
        liveState = "unavailable";
        renderLiveNote();
      });
  }
  function renderLiveNote() {
    const when = liveFetchedAt
      ? liveFetchedAt.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })
      : "";
    const text = liveState === "ok"
      ? (liveCentres.length
          ? `● Live · ${liveCentres.length} newly listed centre${liveCentres.length > 1 ? "s" : ""} from the Pi-CNG register (checked ${when}) — shown with a New badge; map pins appear after verification.`
          : `● Live · Pi-CNG register checked ${when} — no centres listed since the last daily update.`)
      : liveState === "unavailable"
        ? "Live register could not be reached — showing the stored list from the last daily update."
        : "Checking the live Pi-CNG register for newly listed centres…";
    // 19 Nov 2026: the live note lives on the Centres tab only — live
    // entries are conversion centres, and the Stations tab no longer
    // shows centres at all. (The old "live-note" element is gone from
    // the Stations view.)
    ["live-note-centres"].forEach((id) => {
      const el = $(id);
      if (el) el.textContent = text;
    });
  }
  // ---------------- honest statistics ----------------
  function statTile(num, label, meaning, live) {
    return `<div class="stat-tile${live ? " live" : ""}"><div class="num">${num}</div><div class="lbl">${esc(label)}</div><div class="mean">${esc(meaning)}</div></div>`;
  }
  function renderStats() {
    if (!stats) return;
    // Defensive (Phase 1): one missing key in stats.json used to throw
    // and kill the hero stats + both stat grids. A missing number shows
    // "—" instead of breaking the page.
    const num = (v) => (typeof v === "number" ? v.toLocaleString() : "—");
    const lbl = (v) => v || "";
    const tiles =
      statTile(num(stats.total_records), "Directory records", lbl(stats.total_records_label)) +
      statTile(num(stats.refuelling_locations), "Refuelling locations", lbl(stats.refuelling_label)) +
      statTile(num(stats.conversion_centres), "Conversion centres", lbl(stats.conversion_label)) +
      statTile(num(stats.picng_register_matched), "Officially accredited", lbl(stats.picng_register_label)) +
      statTile(num(stats.picng_refuel_register_matched), "On the Pi-CNG refuelling register", lbl(stats.picng_refuel_register_label)) +
      statTile(num(stats.needs_reverification), "Need re-verification", lbl(stats.needs_reverification_label)) +
      statTile((stats.states_with_data ?? "—") + " / 37", "States + FCT with data", lbl(stats.states_with_data_label)) +
      statTile(onMapCount().toLocaleString(), "With coordinates", lbl(stats.with_coordinates_label));
    const grid = `<div class="stat-grid">${tiles}</div>` +
      `<p class="tiny" style="margin:8px 0 0">Directory numbers computed from the dataset on ${esc(stats.generated || "—")}.</p>`;
    const home = $("home-stats");
    if (home) home.innerHTML = grid;
    const about = $("about-stats");
    if (about) about.innerHTML = grid;
    // Hero stats — same source, three headline numbers.
    const hero = $("hero-stats");
    if (hero) hero.innerHTML =
      `<div class="hero-stat"><b>${num(stats.total_records)}</b><span>stations &amp; centres</span></div>` +
      `<div class="hero-stat"><b>${stats.states_with_data ?? "—"} / 37</b><span>states + FCT</span></div>` +
      `<div class="hero-stat"><b>${onMapCount().toLocaleString()}</b><span>on the map</span></div>`;
    const lede = $("stations-lede");
    if (lede) lede.textContent = `Every CNG refuelling station in the dataset — ${stats.refuelling_locations ?? "—"} stations. Conversion centres live under the Centres tab.`;
    const nodata = $("nodata-note");
    if (nodata) {
      const noData = stats.no_data_states || [];
      nodata.textContent = noData.length
        ? `${noData.length} states have no data yet: ${noData.join(", ")}. New entries come from official government and agency lists as they are published.`
        : "Every state now has at least one entry.";
    }
    const cs = $("centre-stats");
    if (cs) cs.textContent = `${num(stats.picng_register_matched)} of ${num(stats.conversion_centres)} conversion centres are matched on the Pi-CNG accredited list; ${num(stats.needs_reverification)} entries need re-verification.`;
  }

  // ---------------- homepage sections (Phase 1, §5) ----------------
  // B. Live availability — fresh reports only. The reports Map holds only
  // reports inside the 2-hour window (loadReports filters), and the
  // filter below re-checks expiry, so an old report can never appear
  // here as live. Honest empty state when nothing is fresh.
  function renderHomeLive() {
    const box = $("home-live");
    if (!box) return;
    if (!dataLoaded) { box.innerHTML = `<p class="small">Loading live reports…</p>`; return; }
    if (!reportsLive) {
      box.innerHTML = navigator.onLine === false
        ? `<p class="small">You are offline — live reports need a connection, so none is shown here. The station list below is the saved copy; availability appears again when you are back online.</p>`
        : `<p class="small">Live reports could not be reached — check your connection and reload. The station list is still accurate.</p>`;
      return;
    }
    const fresh = [...reports.entries()]
      .filter(([id, r]) => Date.now() - r.ts <= F.REPORT_TTL_MS && findStation(id))
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 5);
    if (!fresh.length) {
      box.innerHTML = `<p style="margin:0">No gas report in the last 2 hours — nothing here is presented as live until a driver reports it. At a station right now? Open it and tap <b>✅ Has gas</b> or <b>🔴 Out</b>.</p>`;
      return;
    }
    box.innerHTML = fresh.map(([id, r]) => {
      const s = findStation(id);
      // Confirm button (Phase 3, §8): a driver who sees this report can
      // confirm it from the feed, without opening the detail page.
      const confirmBtn = r.id
        ? `<br><button class="qr-btn qr-yes home-confirm" data-confirm="${r.id}|${id}" aria-label="Confirm this report is still right">✓ Still right?</button>`
        : "";
      return `<div class="home-live-item" data-id="${id}"><div><b>${esc(s.name)}</b><br>` +
        `<span class="small">${esc(locLabel(s))}${r.queue ? ` · queue about ${r.queue} min` : ""}</span><br>` +
        `<span class="home-live-conf" data-conf-for="${r.id || ""}"></span></div>` +
        `<div style="text-align:right;flex:0 0 auto">${statusBadge(id, true)}${confirmBtn}</div></div>`;
    }).join("");
    box.querySelectorAll(".home-live-item").forEach((el) =>
      el.addEventListener("click", () => openStation(el.dataset.id)));
    box.querySelectorAll(".home-confirm").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [rid, sid] = btn.dataset.confirm.split("|");
        btn.disabled = true;
        submitConfirmation(rid, sid, "yes");
      }));
    loadHomeConfidence(fresh.map(([, r]) => r.id).filter(Boolean));
  }
  // Confidence chips on the home feed: one batch request for every fresh
  // report's confirmation counts (api/confirmations.js ?report_ids=…),
  // then each item's chip is rendered from its own counts + age.
  function refreshHomeConfidence() {
    document.querySelectorAll("[data-conf-for]").forEach((el) => {
      const rid = el.dataset.confFor;
      if (!rid) return;
      const counts = confirmCache.get(rid);
      if (!counts || counts === "not_open") return;
      let ageMs = null;
      let source = "community";
      reports.forEach((r) => { if (r.id === rid) { ageMs = Date.now() - r.ts; source = r.source || "community"; } });
      if (ageMs === null) return;
      const conf = confidenceFor(ageMs, counts, undefined, source);
      el.innerHTML = confidenceChipHtml(conf) + ` <span class="tiny">${esc(conf.why)}</span>`;
    });
  }
  function loadHomeConfidence(ids) {
    const missing = [...new Set(ids)].filter((id) => id && !confirmCache.has(id));
    if (!missing.length) { refreshHomeConfidence(); return; }
    fetch(`/api/confirmations?report_ids=${encodeURIComponent(missing.join(","))}`)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && j.counts) {
          Object.entries(j.counts).forEach(([id, c]) => confirmCache.set(id, c));
        }
        refreshHomeConfidence();
      })
      .catch(() => { /* confidence is optional; the report still stands */ });
  }
  // C. Conversion centres preview — nearest accredited centres when the
  // user's spot is known, otherwise the honest national counts + CTA.
  function renderHomeCentres() {
    const box = $("home-centres");
    if (!box) return;
    if (!dataLoaded) { box.innerHTML = `<p class="small">Loading centres…</p>`; return; }
    const accredited = stats ? stats.picng_register_matched
      : allStations().filter((s) => s.acc).length;
    const total = stats ? stats.conversion_centres
      : allStations().filter((s) => s.type !== "refuelling").length;
    let inner = `<p style="margin-top:0"><b>${(accredited || 0).toLocaleString()}</b> of <b>${(total || 0).toLocaleString()}</b> conversion centres are matched on the Pi-CNG accredited list.</p>`;
    if (userLoc) {
      const near = allStations()
        .filter((s) => s.type !== "refuelling" && s.acc && s.lat && s.lng)
        .map((s) => ({ s, d: haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      if (near.length) {
        inner += near.map(({ s, d }) =>
          `<div class="home-live-item" data-id="${s.id}"><div><b>${esc(s.name)}</b><br>` +
          `<span class="small">${esc(locLabel(s))}</span></div>` +
          `<div style="text-align:right;flex:0 0 auto"><span class="dist-chip">${fmtKm(d)}</span></div></div>`
        ).join("");
        inner += `<p style="margin:8px 0 0"><a href="#" data-view-link=\"centres\">All conversion centres →</a></p>`;
      } else {
        inner += `<p class="small">No accredited centre with coordinates near your spot yet — the full list is on the Centres tab. <a href="#" data-view-link=\"centres\">Browse centres →</a></p>`;
      }
    } else {
      inner += `<p style="margin:0">Set your location above to see the nearest accredited centres. <a href="#" data-view-link=\"centres\">Check an installer →</a></p>`;
    }
    box.innerHTML = inner;
    box.querySelectorAll(".home-live-item").forEach((el) =>
      el.addEventListener("click", () => openStation(el.dataset.id)));
  }
  // F. Savings teaser — a worked example from the real prices, with its
  // assumptions stated, never a bare number.
  function renderHomeSavings() {
    const box = $("home-savings");
    if (!box) return;
    const v = F.VEHICLES.car;
    const kmMonth = 100 * 26;
    const litres = kmMonth / v.kmPerLitre;
    const scm = kmMonth / (v.kmPerLitre * F.SCM_PER_LITRE_EQUIV);
    const saving = Math.max(0, litres * F.PRICES.petrolPerLitre - scm * F.PRICES.cngPerScmCar);
    box.innerHTML = `<p style="margin:0">A car driving <b>100 km a day, 26 days a month</b> would save about <b>${naira(saving)} a month</b> on fuel at today's reported prices (petrol ₦${F.PRICES.petrolPerLitre}/litre, CNG ₦${F.PRICES.cngPerScmCar}/SCM, ${F.PRICES.priceDate}). That is an estimate — your car and your mileage change it.</p>`;
  }
  // H. Latest updates — the 3 newest news items. The news module owns
  // the feed; it dispatches a "findcng:news" event whenever it renders,
  // and exposes its seed as the offline fallback.
  function renderHomeNews() {
    const box = $("home-news");
    if (!box) return;
    const N = window.FindCNGNews;
    if (!N) return; // news module not loaded yet — its event will call us
    const items = (N.getItems && N.getItems().length ? N.getItems()
      : (N.getSeed ? N.getSeed() : [])).slice(0, 3);
    if (!items.length) {
      box.innerHTML = `<p class="small" style="margin:0">No news yet — check back soon.</p>`;
      return;
    }
    box.innerHTML = items.map((it) =>
      `<div class="home-live-item" data-news="1"><div><b>${esc(it.title || "Untitled")}</b><br>` +
      `<span class="small">${it.published_at ? esc(fmtDate(it.published_at)) + " · " : ""}${esc(it.source_name || "")}</span></div></div>`
    ).join("");
    box.querySelectorAll("[data-news]").forEach((el) =>
      el.addEventListener("click", () => showView("news")));
  }
  // ---------------- CNG Intelligence (Phase 3, §11) -------------------
  // Upgrades the Phase 1 "Coverage & data" view. Every figure is
  // database-derived — stats.json at build time, stations.json and the
  // live reports map at runtime, data/history.json snapshots for growth
  // — nothing estimated, nothing invented. Where the data cannot answer
  // a question (e.g. "operational" status, or whether a thin state
  // really lacks infrastructure), the dashboard says so in plain words
  // instead of filling the gap with a guess.
  let intelSort = "total-desc";
  let intelPostcodes = null; // data/postcodes.json, fetched once
  let intelHistory = null;   // data/history.json, fetched once
  let intelNewsDate = null;  // newest news item's date, fetched once
  let intelNewsTried = false;

  function renderIntelligence() {
    const box = $("intelligence-body");
    if (!box) return;
    if (!stats) { box.innerHTML = `<p class="small">Loading intelligence numbers…</p>`; return; }
    const detail = stats.per_state_detail || [];
    const noData = stats.no_data_states || [];
    const prec = stats.coord_precision || {};
    const noCoords = (stats.total_records || 0) - (stats.with_coordinates || 0);
    // Live right now — fresh reports only. The reports Map already holds
    // only in-window reports; expiry is re-checked here too, so a stale
    // report can never count as live.
    let freshAvail = 0, freshLow = 0, freshOut = 0;
    reports.forEach((r) => {
      if (Date.now() - r.ts > F.REPORT_TTL_MS) return;
      if (r.status === "available") freshAvail++;
      else if (r.status === "low") freshLow++;
      else freshOut++;
    });
    const freshTotal = freshAvail + freshLow + freshOut;
    // Gaps — DIRECTORY gaps, not proven infrastructure gaps (the card
    // below says so explicitly; a thin directory is not proof of thin
    // infrastructure, only of unpublished official lists).
    const thin = detail.filter((d) => d.total <= 2);
    const noRefuel = detail.filter((d) => d.refuelling === 0);
    const unmapped = detail.filter((d) => d.with_coords === 0);
    // State comparison, sorted per the user's choice.
    const rows = [...detail];
    if (intelSort === "total-asc") rows.sort((a, b) => a.total - b.total || a.state.localeCompare(b.state));
    else if (intelSort === "mapped") rows.sort((a, b) => b.pct_mapped - a.pct_mapped || b.total - a.total);
    else if (intelSort === "az") rows.sort((a, b) => a.state.localeCompare(b.state));
    else rows.sort((a, b) => b.total - a.total || a.state.localeCompare(b.state));
    const sortOpts = [
      ["total-desc", "Most entries first"],
      ["total-asc", "Fewest entries first"],
      ["mapped", "Best mapped first"],
      ["az", "A–Z"],
    ].map(([v, l]) => `<option value="${v}"${intelSort === v ? " selected" : ""}>${l}</option>`).join("");
    box.innerHTML =
      // A. National overview — listed vs verified vs live, labelled.
      `<div class="card"><h3 style="margin-top:0">National overview</h3>` +
      `<p style="margin:0"><b>Listed:</b> ${(stats.total_records || 0).toLocaleString()} records — ` +
      `<b>${(stats.refuelling_locations || 0).toLocaleString()}</b> refuelling locations and ` +
      `<b>${(stats.conversion_centres || 0).toLocaleString()}</b> conversion centres across ` +
      `<b>${stats.states_with_data ?? "—"} of 37</b> states + FCT. (Entries that both sell gas and convert are counted in both groups.)</p>` +
      `<p style="margin:8px 0 0"><b>Verified:</b> <b>${(stats.picng_register_matched || 0).toLocaleString()}</b> conversion centres officially accredited (Pi-CNG register) · ` +
      `<b>${(stats.picng_refuel_register_matched || 0).toLocaleString()}</b> refuelling locations on the Pi-CNG refuelling register · ` +
      `<b>${(stats.needs_reverification || 0).toLocaleString()}</b> entries need re-verification · ` +
      `<b>${(stats.single_source || 0).toLocaleString()}</b> from a single source.</p>` +
      `<p style="margin:8px 0 0"><b>Live right now:</b> ${freshTotal ? `<b>${freshTotal}</b> station(s) have a fresh driver report (last 2 hours) — ${freshAvail} available, ${freshLow} low, ${freshOut} finished or closed.` : "no fresh driver report in the last 2 hours — nothing here is presented as live until a driver reports it."}</p>` +
      `<p class="small" style="margin:8px 0 0">FindCNG does not keep a separate “operational” register — a station is only known to be operating when a driver reports gas there in the last 2 hours. A listed station with no fresh report is unconfirmed, not closed. Directory numbers computed from the dataset on ${esc(stats.generated || "—")}.</p></div>` +
      `<div class="card"><h3 style="margin-top:0">Map pins — how precise?</h3>` +
      `<p style="margin:0"><b>${(prec.exact || 0).toLocaleString()}</b> exact locations · ` +
      `<b>${(prec.approximate || 0).toLocaleString()}</b> approximate · ` +
      `<b>${(prec.town || 0).toLocaleString()}</b> area pins (town centre, not the exact spot) · ` +
      `<b>${noCoords.toLocaleString()}</b> entries have no coordinates yet and appear in the list only.</p></div>` +
      // B. State comparison.
      `<div class="card" style="overflow-x:auto"><h3 style="margin-top:0">State comparison</h3>` +
      `<div class="field"><label for="intel-sort">Sort states by</label><select id="intel-sort">${sortOpts}</select></div>` +
      `<table class="coverage-table"><tr><th>State</th><th>Listed</th><th>Refuelling</th><th>Conversion</th><th>Accredited</th><th>Mapped</th></tr>` +
      rows.map((d) =>
        `<tr><td>${esc(d.state)}</td><td>${d.total.toLocaleString()}</td><td>${d.refuelling.toLocaleString()}</td>` +
        `<td>${d.conversion.toLocaleString()}</td><td>${d.accredited.toLocaleString()}</td><td>${d.pct_mapped}%</td></tr>`).join("") +
      `</table>` +
      `<p class="small" style="margin:8px 0 0">“Mapped” is the share of that state's listed entries with coordinates — a directory measure, not a measure of the state's real CNG infrastructure.</p></div>` +
      // C. Infrastructure gaps — verified vs missing, labelled.
      `<div class="card"><h3 style="margin-top:0">Where the directory is thin</h3>` +
      (noData.length
        ? `<p style="margin:0"><b>${noData.length} states have no listed entries at all:</b> ${noData.map(esc).join(", ")}.</p>`
        : `<p style="margin:0">Every state now has at least one entry.</p>`) +
      (thin.length
        ? `<p style="margin:8px 0 0"><b>Thinly listed (2 or fewer entries):</b> ${thin.map((d) => `${esc(d.state)} (${d.total})`).join(", ")}.</p>` : "") +
      (noRefuel.length
        ? `<p style="margin:8px 0 0"><b>Listed entries but no refuelling location:</b> ${noRefuel.map((d) => esc(d.state)).join(", ")} — conversion centres only.</p>` : "") +
      (unmapped.length
        ? `<p style="margin:8px 0 0"><b>No mapped entries at all:</b> ${unmapped.map((d) => esc(d.state)).join(", ")} — every entry there is list-only until coordinates are recorded.</p>` : "") +
      `<p class="small" style="margin:8px 0 0"><b>Read this carefully:</b> these are gaps in the DIRECTORY — what official lists have published so far. A state with few or no listed entries may still have CNG stations and conversion centres that no official list has published yet. FindCNG cannot verify a real infrastructure gap; only the official registers can. Know a station that is missing? <a href="#" data-listing-link=\"NEW|missing\">Suggest it →</a></p></div>` +
      // D. Postcode-area exploration (enriched below).
      `<div class="card"><h3 style="margin-top:0">Postcode areas</h3><div id="intel-postcode"><p class="small">Loading postcode areas…</p></div></div>` +
      // E. Infrastructure growth (enriched below).
      `<div class="card"><h3 style="margin-top:0">Infrastructure growth</h3><div id="intel-growth"><p class="small">Loading growth history…</p></div></div>` +
      // F. Data freshness (enriched below).
      `<div class="card"><h3 style="margin-top:0">Data freshness</h3><div id="intel-freshness"><p class="small">Loading freshness…</p></div></div>`;
    const sortEl = $("intel-sort");
    if (sortEl) sortEl.addEventListener("change", () => { intelSort = sortEl.value; renderIntelligence(); });
    enrichIntelPostcode();
    enrichIntelGrowth();
    enrichIntelFreshness(freshTotal, freshAvail, freshLow, freshOut);
  }
  // D. Postcode areas — the 6-digit codes the app can centre on, with
  // how many mapped stations sit within 25 km of each district centre.
  // Distances are haversine from VERIFIED station coordinates; the
  // postcode centre itself is approximate (see build-data.py).
  function enrichIntelPostcode() {
    const box = $("intel-postcode");
    if (!box) return;
    const render = () => {
      if (!intelPostcodes || !intelPostcodes.exact) {
        box.innerHTML = `<p class="small">Postcode area data could not be loaded — the Postcode Explorer still works for individual codes.</p>`;
        return;
      }
      const codes = Object.entries(intelPostcodes.exact).sort((a, b) => a[0].localeCompare(b[0]));
      const rows = codes.map(([code, c]) => {
        const near = stations.filter((s) => s.lat && s.lng &&
          haversineKm(c.lat, c.lng, s.lat, s.lng) <= 25).length;
        return { code, place: c.place, lat: c.lat, lng: c.lng, near };
      });
      box.innerHTML =
        `<p style="margin-top:0">The app can centre the map on <b>${rows.length} six-digit postcode areas</b> (district centres, approximate). ` +
        `<b>${(stats && stats.with_postcode) || 0}</b> directory entries carry a postcode in the dataset. ` +
        `For the 11-character building postcode, use the <a href="#" data-view-link=\"postcode\">Postcode Explorer</a> — it parses the code, names the state and LGA from NIPOST reference data, and checks whether the code is assigned.</p>` +
        `<table class="coverage-table"><tr><th>Postcode</th><th>Area</th><th>Mapped stations within 25 km</th><th></th></tr>` +
        rows.map((r) =>
          `<tr><td>${esc(r.code)}</td><td>${esc(r.place)}</td><td>${r.near}</td>` +
          `<td><button class="btn small outline intel-nearby" data-lat="${r.lat}" data-lng="${r.lng}" data-place="${esc(r.place)}" data-code="${esc(r.code)}">See stations</button></td></tr>`).join("") +
        `</table>`;
      box.querySelectorAll(".intel-nearby").forEach((b) =>
        b.addEventListener("click", () => {
          setUserLoc(parseFloat(b.dataset.lat), parseFloat(b.dataset.lng),
            b.dataset.place + " — postcode " + b.dataset.code);
          showView("map");
        }));
    };
    if (intelPostcodes) { render(); return; }
    fetch("data/postcodes.json").then((r) => r.json()).then((j) => {
      intelPostcodes = j; render();
    }).catch(() => {
      box.innerHTML = `<p class="small">Postcode area data could not be loaded — the Postcode Explorer still works for individual codes.</p>`;
    });
  }
  // E. Growth — from recorded daily snapshots ONLY (data/history.json,
  // appended by build-data.py). With a single snapshot the dashboard
  // shows the baseline honestly and says the trend is still forming —
  // it never draws a trend from one point.
  function enrichIntelGrowth() {
    const box = $("intel-growth");
    if (!box) return;
    const render = () => {
      if (!intelHistory || !intelHistory.length) {
        box.innerHTML = `<p class="small">No growth snapshots recorded yet — the daily rebuild records the first one, and the trend appears as days accumulate.</p>`;
        return;
      }
      const latest = intelHistory.slice(-5).reverse();
      const first = intelHistory[0];
      box.innerHTML =
        (intelHistory.length === 1
          ? `<p style="margin-top:0"><b>Baseline recorded ${esc(fmtDate(first.date))}.</b> Growth tracking starts here — the daily rebuild records a new snapshot each day, and change will show in this table as it accumulates. No trend is drawn from a single day.</p>`
          : `<p style="margin-top:0">Snapshots recorded by the daily rebuild — the latest ${latest.length} of ${intelHistory.length} day(s). Change since the ${esc(fmtDate(first.date))} baseline: <b>${(intelHistory[intelHistory.length - 1].total_records - first.total_records) >= 0 ? "+" : ""}${(intelHistory[intelHistory.length - 1].total_records - first.total_records).toLocaleString()}</b> records, <b>${(intelHistory[intelHistory.length - 1].with_coordinates - first.with_coordinates) >= 0 ? "+" : ""}${(intelHistory[intelHistory.length - 1].with_coordinates - first.with_coordinates).toLocaleString()}</b> mapped.</p>`) +
        `<div style="overflow-x:auto"><table class="coverage-table"><tr><th>Date</th><th>Records</th><th>Refuelling</th><th>Conversion</th><th>Accredited</th><th>States</th><th>Mapped</th></tr>` +
        latest.map((h) =>
          `<tr><td>${esc(fmtDate(h.date))}</td><td>${(h.total_records || 0).toLocaleString()}</td>` +
          `<td>${(h.refuelling_locations || 0).toLocaleString()}</td><td>${(h.conversion_centres || 0).toLocaleString()}</td>` +
          `<td>${(h.picng_register_matched || 0).toLocaleString()}</td><td>${h.states_with_data ?? "—"}</td>` +
          `<td>${(h.with_coordinates || 0).toLocaleString()}</td></tr>`).join("") +
        `</table></div>`;
    };
    if (intelHistory) { render(); return; }
    fetch("data/history.json").then((r) => r.json()).then((j) => {
      intelHistory = Array.isArray(j) ? j : []; render();
    }).catch(() => {
      box.innerHTML = `<p class="small">Growth history could not be loaded — the directory itself is unaffected.</p>`;
    });
  }
  // F. Data freshness — when each dataset was last updated, in one place.
  function enrichIntelFreshness(freshTotal, freshAvail, freshLow, freshOut) {
    const box = $("intel-freshness");
    if (!box) return;
    const render = () => {
      const liveLine = liveState === "ok"
        ? `Pi-CNG live register checked ${liveFetchedAt ? liveFetchedAt.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" }) : ""} — ${liveCentres.length} newly listed centre(s) since the last daily update.`
        : liveState === "unavailable"
          ? "Pi-CNG live register could not be reached — showing the stored list from the last daily update."
          : "Pi-CNG live register check in progress…";
      box.innerHTML =
        `<p style="margin:0"><b>Directory dataset:</b> rebuilt ${esc(stats.generated ? fmtDate(stats.generated) : "—")} from the official registers and public lists.</p>` +
        `<p style="margin:8px 0 0"><b>Pi-CNG accredited centres register:</b> checked ${esc(F.REGISTER_DATES.centres)}. <b>Pi-CNG refuelling register:</b> updated ${esc(F.REGISTER_DATES.refuel)}.</p>` +
        `<p style="margin:8px 0 0"><b>Live register:</b> ${esc(liveLine)}</p>` +
        `<p style="margin:8px 0 0"><b>Live availability:</b> ${freshTotal ? `${freshTotal} fresh report(s) in the last 2 hours (${freshAvail} available, ${freshLow} low, ${freshOut} finished or closed).` : "no fresh report in the last 2 hours."} Reports expire after 2 hours and are never shown cached as live.</p>` +
        `<p style="margin:8px 0 0"><b>News:</b> ${intelNewsDate ? `newest item ${esc(fmtDate(intelNewsDate))}.` : intelNewsTried ? "could not be reached just now." : "loading…"}</p>` +
        `<p class="small" style="margin:8px 0 0"><b>Postcode reference data</b> (states, LGAs, districts, areas) is checked live against NIPOST each time you use the Postcode Explorer — it is never stored here.</p>`;
    };
    render();
    if (intelNewsTried) return;
    intelNewsTried = true;
    const fromModule = window.FindCNGNews && window.FindCNGNews.getItems && window.FindCNGNews.getItems();
    if (fromModule && fromModule.length && fromModule[0].published_at) {
      intelNewsDate = fromModule[0].published_at;
      render();
      return;
    }
    fetch("/api/news?limit=1").then((r) => r.json()).then((j) => {
      const items = (j && j.items) || [];
      if (items.length && items[0].published_at) intelNewsDate = items[0].published_at;
      render();
    }).catch(() => render());
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
                pressure: r.pressure_ok, compressor: r.compressor_ok, ts,
                source: r.source || "community" });
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
    renderHomeLive();
    renderHomeCentres();
    if (currentStation && $("view-station").classList.contains("active")) renderDetail(currentStation);
    // Phase 3: the Intelligence view's "Live right now" line is computed
    // from reports, and reports arrive after the directory — without this
    // re-render it would keep showing "no fresh driver report" forever
    // even while a fresh report was live (found by viewing the Phase 3
    // screenshots; the first UI check had passed only because the empty
    // state contains the words "fresh driver report").
    renderIntelligence();
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
    hideMapError();
    Object.values(baseLayers).forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); });
    mapLayer = kind;
    baseLayers[kind].addTo(map);
    try { localStorage.setItem(MAP_LAYER_KEY, kind); } catch { /* ignore */ }
    // A deliberate manual switch re-arms the fallback; a fallback disarms it
    // so the street layer's own errors can never re-trigger it (no loop).
    if (opts.fallbackFrom) tileFallbackArmed = false;
    else if (kind !== "street") tileFallbackArmed = true;
    // Every switch to street re-arms the street-failure watch (fresh layer).
    if (kind === "street") streetFailArmed = true;
    updateLayerSwitcher();
    if (opts.fallbackFrom) toast(MAP_LAYERS[opts.fallbackFrom].label + " map couldn't load — showing street map.");
  }
  // Tile resilience (19 Nov 2026): flaky mobile data drops individual
  // tiles, so every failed tile gets ONE retry 1.5s later (a retry that
  // also fails is what counts toward the fallback). Only failures after
  // a retry count — 3+ within 10s on satellite switches to street; on
  // street there is no third provider (Wikimedia 403s browser user
  // agents, Carto needs an API key now, OSM France 404s), so street
  // failure shows an on-map message with counts and a Retry button
  // instead of a silent grey map. Per-layer stats feed that message.
  const tileStats = {
    satellite: { loaded: 0, failed: 0 },
    street: { loaded: 0, failed: 0 },
  };
  const tileRetried = new Set(); // tile URLs already retried once
  let streetFailArmed = true; // false once the street-failure message shows
  let mapErrorLoadedAt = 0; // total tiles loaded when the message appeared
  function mapErrorEl() {
    let el = $("map-error");
    if (el) return el;
    const mapEl = $("map");
    if (!mapEl) return null;
    el = document.createElement("div");
    el.id = "map-error";
    el.className = "map-error hidden";
    el.setAttribute("role", "alert");
    el.innerHTML = "<b>Map tiles aren't loading</b>" +
      '<span class="map-error-detail"></span>' +
      '<span class="map-error-note">The station list and search still work — use the tabs below.</span>' +
      '<span class="map-error-btns"><button type="button" class="btn small" data-map-retry>Retry map</button>' +
      '<button type="button" class="btn outline small" data-map-other>Try satellite</button></span>';
    el.querySelector("[data-map-retry]").addEventListener("click", () => {
      hideMapError();
      streetFailArmed = true;
      if (mapLayer === "satellite") tileFallbackArmed = true;
      if (map && baseLayers && baseLayers[mapLayer]) baseLayers[mapLayer].redraw();
    });
    el.querySelector("[data-map-other]").addEventListener("click", () => {
      setMapLayer(mapLayer === "satellite" ? "street" : "satellite");
    });
    mapEl.appendChild(el);
    return el;
  }
  function showMapError() {
    if (!streetFailArmed) return;
    streetFailArmed = false;
    hideMapLoading();
    const el = mapErrorEl();
    if (!el) return;
    mapErrorLoadedAt = tileStats.satellite.loaded + tileStats.street.loaded;
    const s = tileStats.satellite, t = tileStats.street;
    el.querySelector(".map-error-detail").textContent =
      `Satellite: ${s.loaded} loaded · ${s.failed} failed. Street: ${t.loaded} loaded · ${t.failed} failed.`;
    el.querySelector("[data-map-other]").textContent =
      mapLayer === "satellite" ? "Try street" : "Try satellite";
    el.classList.remove("hidden");
  }
  function hideMapError() {
    const el = $("map-error");
    if (el) el.classList.add("hidden");
  }
  // Tile-failure fallback: 3+ post-retry tile errors within 10 seconds
  // on the satellite layer means the provider is failing, not one bad
  // tile — switch to the street layer. On street, show the error
  // message instead (no third provider exists).
  function watchTileErrors(layer, kind) {
    let errors = [];
    layer.on("tileload", () => {
      tileStats[kind].loaded++;
      // Genuine recovery clears the message: 3+ tiles loaded since it
      // appeared (1–2 stragglers from the failed batch do not).
      const el = $("map-error");
      if (el && !el.classList.contains("hidden") &&
          tileStats.satellite.loaded + tileStats.street.loaded - mapErrorLoadedAt >= 3) {
        hideMapError();
      }
    });
    layer.on("tileerror", (e) => {
      if (mapLayer !== kind || !map || !map.hasLayer(layer)) return;
      const tile = e && e.tile;
      const url = tile ? tile.src : "";
      // One free retry per tile: flaky data drops single tiles that load
      // fine a second later. A retry URL (or an already-retried one)
      // failing again is a real failure and counts toward the fallback.
      // Retries and stats run even after the fallback disarms — recovery
      // is always good, and the counts in the error message must reflect
      // every failure, not just the three that triggered it.
      if (url && !url.includes("retry=1") && !tileRetried.has(url)) {
        tileRetried.add(url);
        if (tileRetried.size > 500) tileRetried.clear();
        setTimeout(() => {
          if (tile.isConnected && map && map.hasLayer(layer)) {
            tile.src = url + (url.includes("?") ? "&" : "?") + "retry=1";
          }
        }, 1500);
        return;
      }
      tileStats[kind].failed++;
      const armed = kind === "satellite" ? tileFallbackArmed : streetFailArmed;
      if (!armed) return;
      const now = Date.now();
      errors = errors.filter((t) => now - t < 10000);
      errors.push(now);
      if (errors.length >= 3) {
        if (kind === "satellite") setMapLayer("street", { fallbackFrom: kind });
        else showMapError();
      }
    });
  }
  // Slow-tile UX (19 Nov 2026): on a slow connection the satellite layer
  // can sit grey for 10–30s without a single tile ERROR (Esri tiles are
  // ~3x the bytes of OSM street tiles), so the error fallback never fires
  // and the map just looks broken. Show a loading pill while the active
  // layer is fetching, offer a manual switch to street after 6s, and
  // auto-switch to street if satellite loads continuously for 15s.
  let tileSlowTimer = null;
  let tileSlowNudgeTimer = null;
  function mapLoadingEl() {
    let el = $("map-loading");
    if (el) return el;
    const mapEl = $("map");
    if (!mapEl) return null;
    el = document.createElement("div");
    el.id = "map-loading";
    el.className = "map-loading hidden";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="map-loading-dot"></span><span class="map-loading-text">Loading map…</span><button type="button" class="map-loading-btn hidden">Use street map</button>';
    el.querySelector(".map-loading-btn").addEventListener("click", () => setMapLayer("street"));
    mapEl.appendChild(el);
    return el;
  }
  function showMapLoading(kind) {
    const el = mapLoadingEl();
    if (!el) return;
    el.querySelector(".map-loading-text").textContent =
      kind === "satellite" ? "Loading satellite imagery…" : "Loading street map…";
    el.querySelector(".map-loading-btn").classList.add("hidden");
    el.classList.remove("hidden");
  }
  function hideMapLoading() {
    const el = $("map-loading");
    if (el) el.classList.add("hidden");
    clearTimeout(tileSlowTimer); tileSlowTimer = null;
    clearTimeout(tileSlowNudgeTimer); tileSlowNudgeTimer = null;
  }
  function watchLayerLoading(layer, kind) {
    layer.on("loading", () => {
      if (!map || mapLayer !== kind || !map.hasLayer(layer)) return;
      showMapLoading(kind);
      clearTimeout(tileSlowNudgeTimer);
      tileSlowNudgeTimer = setTimeout(() => {
        const el = $("map-loading");
        if (!el || el.classList.contains("hidden") || mapLayer !== "satellite") return;
        el.querySelector(".map-loading-text").textContent = "Still loading — slow connection?";
        el.querySelector(".map-loading-btn").classList.remove("hidden");
      }, 6000);
      // Slow-load fallback: 15s of continuous loading with no 'load'
      // event means the provider is too slow to use on this connection.
      // Satellite switches to street; street shows the error message.
      // Same disarm rules as the error fallback.
      clearTimeout(tileSlowTimer); tileSlowTimer = null;
      if (kind === "satellite") {
        tileSlowTimer = setTimeout(() => {
          if (!tileFallbackArmed || mapLayer !== "satellite" || !map || !map.hasLayer(layer)) return;
          setMapLayer("street", { fallbackFrom: "satellite" });
        }, 15000);
      } else {
        tileSlowTimer = setTimeout(() => {
          if (!streetFailArmed || mapLayer !== "street" || !map || !map.hasLayer(layer)) return;
          showMapError();
        }, 15000);
      }
    });
    layer.on("load", () => {
      if (mapLayer === kind) hideMapLoading();
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
    watchTileErrors(baseLayers.street, "street");
    watchLayerLoading(baseLayers.satellite, "satellite");
    watchLayerLoading(baseLayers.street, "street");
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
    // One-tap report (19 Nov 2026): refuelling stations only, same rule
    // as the card buttons. Data attributes + document-level delegation:
    // Leaflet popups are plain HTML strings, so the buttons carry
    // data-quick-report / data-open-station and one delegated listener
    // (init) handles them — no inline handlers, so the CSP can run
    // without 'unsafe-inline' (Phase 4, §19).
    // strings with no bind step, so the handler must be global.
    const qr = (s.type !== "conversion" && !s.live)
      ? `<br><button class="qr-btn qr-yes" style="margin-top:8px" data-quick-report=\"${s.id}|available\">✅ Has gas</button> <button class="qr-btn qr-no" data-quick-report=\"${s.id}|finished\">🔴 Out</button>`
      : "";
    return `<b>${esc(s.name)}</b><br>${esc(s.address || "")}<br>${esc(locLabel(s))}${d}<br>` +
      `${F.STATUS[st].label}${st !== "unconfirmed" ? " · " + timeAgo(reports.get(s.id).ts) : ""}${precLine}${qr}<br>` +
      `<button class="btn small" style="margin-top:8px" data-open-station=\"${s.id}\">Details &amp; report</button>`;
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
    renderHomeCentres();
    loadLiveCentres(); // a near-me search refreshes the live register, so newly listed centres are captured at search time (2.6)
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
    // Live centres have no coordinates, so they cannot be ranked by
    // distance — but a near-me search still surfaces the ones just
    // listed in the same state as the nearest result (2.6).
    (() => {
      const nearState = near.length ? near[0].s.state : null;
      const fresh = nearState ? liveCentres.filter((s) => s.state === nearState).slice(0, 3) : [];
      if (!fresh.length) return "";
      return `<h3 style="margin-top:18px">Newly listed in ${esc(nearState)}</h3>` +
        `<p class="small">Just appeared on the live Pi-CNG register — no map pin yet, so they can't be ranked by distance.</p>` +
        fresh.map((s) =>
          `<div class="card station" data-id="${s.id}"><h3>${esc(s.name)}</h3>` +
          `<p class="meta">${esc(s.address || "")} · ${esc(locLabel(s))}</p>` +
          `<div class="row">${typeBadge(s.type)} ${verifyBadge(s)} <span class="badge live-new">🆕 New — just listed</span></div></div>`
        ).join("");
    })() +
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
        (p.stateName ? ` — ${p.segments.state} is ${p.stateName}.` : ` — but ${p.segments.state} is not in NIPOST's 37-state reference list, so double-check it.`) +
        " A postcode cannot give an exact map point, so use your location or tap the map to set your exact spot.";
      msg.className = "notice ok"; msg.classList.remove("hidden");
      F.postcode.lookupApi(p.code).then((env) => {
        const res = env && env.result;
        if (res && res.valid) {
          msg.textContent = "✓ " + (env.mode === "live" ? "NIPOST's live database" : "NIPOST's sandbox") +
            " confirms this postcode is assigned" +
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

  // ---------------- postcode explorer (Phase 2) ----------------
  // NDAPS codes: segments are parsed offline (state named from NIPOST's
  // 37-state reference list; LGA named and district/area confirmed via
  // the free reference endpoints), then the code is checked against
  // NIPOST — validity, plus address autofill on keys granted above L1
  // (our current test key is L1-only, so the check falls back to L1 and
  // says so). 6-digit codes resolve through the local table and offer
  // nearby stations with distances. Nothing here claims a live
  // validation unless the key is a live one — the mode line says which.
  const SANDBOX_SAMPLE = "FC-01-A01-KP-27"; // NIPOST's published sandbox code (valid:true under a test key)
  let explorerSuggestTimer = null;

  function explorerModeLabel(mode) {
    return mode === "live" ? "NIPOST live database"
      : mode === "sandbox" ? "NIPOST sandbox (test key)" : "NIPOST";
  }

  async function refreshExplorerMode() {
    const el = $("explorer-mode");
    if (!el) return;
    const st = await F.postcode.statusApi();
    if (!st || st.configured === false) {
      el.textContent = "Online check: not set up on this server — codes are checked on structure only.";
    } else if (st.mode === "live") {
      el.textContent = "Online check: NIPOST live database — real building codes validate here.";
    } else {
      el.textContent = "Online check: NIPOST sandbox (test key) — only NIPOST's published sample codes validate here. Real building codes need a live key.";
    }
  }

  // Lookup with L2 first on sandbox keys (the autofill demo), falling
  // back to L1 when the key is not granted above L1 (our current key).
  async function lookupWithFallback(code) {
    const st = await F.postcode.statusApi();
    const mode = (st && st.mode) || "unknown";
    if (!st || st.configured === false) return { env: { configured: false }, l2denied: false, mode };
    let env = await F.postcode.lookupApi(code, mode === "sandbox" ? 2 : 1);
    let l2denied = false;
    if (env && (env.error === "not_granted" || env.error === "insufficient_credits")) {
      l2denied = true;
      env = await F.postcode.lookupApi(code, 1);
    }
    return { env, l2denied, mode };
  }

  // Nearest mapped stations to a point — the explorer's discovery
  // preview. Distances are haversine from VERIFIED station coordinates;
  // a postcode never supplies coordinates (see the NDAPS discovery block).
  function nearestPreviewHtml(lat, lng, count) {
    const near = stations
      .filter((s) => s.lat && s.lng)
      .map((s) => ({ s, d: haversineKm(lat, lng, s.lat, s.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count || 3);
    if (!near.length) {
      return `<p class="small">No mapped stations near here yet — only ${onMapCount()} of ${stations.length} entries have coordinates so far. Use the Stations tab to browse the full list by state.</p>`;
    }
    return `<h3 style="margin-bottom:6px">Nearest mapped stations</h3>` + near.map(({ s, d }) =>
      `<div class="card station st-${statusOf(s.id)}" data-id="${s.id}">` +
      `<h3>${esc(s.name)}</h3>` +
      `<p class="meta">${esc(s.address || "")} · ${esc(locLabel(s))} · <span class="dist-chip">${fmtKm(d)}</span></p>` +
      `<div class="row">${statusBadge(s.id, true)} ${typeBadge(s.type)}</div></div>`
    ).join("");
  }
  function wirePreviewClicks(box) {
    box.querySelectorAll(".station[data-id]").forEach((el) =>
      el.addEventListener("click", () => openStation(el.dataset.id)));
  }

  function explorerGo() {
    const raw = $("explorer-input").value;
    const p = F.postcode.parse(raw);
    const msg = $("explorer-msg");
    const out = $("explorer-result");
    msg.classList.add("hidden");
    $("explorer-suggest").innerHTML = "";
    out.innerHTML = "";
    if (!p.valid) {
      msg.textContent = p.reason === "empty"
        ? "Enter a postcode first — a 6-digit code (e.g. 300001) or an 11-character code (e.g. FC 02 A09 DB 09)."
        : p.reason;
      msg.className = "notice err"; msg.classList.remove("hidden");
      return;
    }
    if (p.kind === "ndaps") { explorerNdaps(p, out); return; }
    F.postcode.resolveSix(p.code).then((hit) => {
      if (!hit) {
        msg.textContent = "We don't have that postcode area yet — the app only knows a small set of 6-digit codes so far. Use your location or tap the map instead.";
        msg.className = "notice"; msg.classList.remove("hidden");
        return;
      }
      out.innerHTML = `<p><b>📍 ${esc(hit.place)}</b><br><span class="small">Approximate ${hit.level === "exact" ? "district" : "dispatch district"} centre — a 6-digit code covers a whole area, not one building.</span></p>` +
        nearestPreviewHtml(hit.lat, hit.lng, 3) +
        `<button class="btn" id="explorer-nearby">See all stations near here</button>`;
      wirePreviewClicks(out);
      $("explorer-nearby").addEventListener("click", () => {
        setUserLoc(hit.lat, hit.lng, hit.place + " — postcode " + p.code);
        showView("map");
      });
    });
  }

  function explorerNdaps(p, out) {
    const s = p.segments;
    out.innerHTML =
      `<div class="seg-chips"><span><b>State</b><br>${esc(s.state)}${p.stateName ? "<br>" + esc(p.stateName) : ""}</span>` +
      `<span><b>LGA</b><br>${esc(s.lga)}<br><span id="explorer-lga-name">…</span></span><span><b>District</b><br>${esc(s.district)}<br><span id="explorer-district-mark">…</span></span>` +
      `<span><b>Area</b><br>${esc(s.area)}<br><span id="explorer-area-mark">…</span></span><span><b>Building</b><br>${esc(s.building)}</span></div>` +
      `<p class="small" id="explorer-seg-note">${p.stateName ? `State ${esc(s.state)} is ${esc(p.stateName)} (NIPOST reference list).` : `State ${esc(s.state)} is not in NIPOST's 37-state reference list — double-check the code.`} A building code identifies one building, but NIPOST does not give out building coordinates — set your exact spot with GPS or a map tap to find stations near it.</p>` +
      `<p class="small" id="explorer-api">Checking with NIPOST…</p>` +
      `<div id="explorer-autofill"></div>` +
      `<div class="card" style="margin-top:12px"><h3 style="margin-top:0">Find CNG near this postcode</h3>` +
      `<p class="small" style="margin-top:0">A postcode has no coordinates in this app, so set your exact spot — then the nearest stations appear with distances.</p>` +
      `<div class="detail-actions"><button class="btn" id="explorer-gps">📍 Use my location</button>` +
      `<button class="btn outline" id="explorer-mappick">🗺️ Pick on the map</button></div>` +
      `<div id="explorer-nearby"></div></div>`;
    // Reference enrichment (free endpoints): name the LGA, confirm the
    // district + area codes are listed under that state+LGA. Each step
    // degrades silently — the segments above stay correct without them.
    explorerReference(p);
    // Validity (+ autofill where the key allows it).
    lookupWithFallback(p.code).then(({ env, l2denied, mode }) => {
      const el = $("explorer-api");
      if (!el) return;
      const res = env && env.result;
      if (env && env.configured === false) {
        el.textContent = "The online check is not set up on this server — the structure above is still valid.";
        return;
      }
      if (!env || (env && env.error)) {
        el.textContent = env && env.error ? F.postcode.errorMessage(env.error)
          : "The online check is unavailable right now — the structure above is still valid; try again later.";
        return;
      }
      if (!res) {
        el.textContent = "The online check is unavailable right now — the structure above is still valid; try again later.";
        return;
      }
      const where = explorerModeLabel(mode);
      if (res.valid) {
        el.textContent = `✓ Confirmed assigned — ${where}.`;
        const af = $("explorer-autofill");
        if (af) {
          if (res.state || res.lga || res.locality || res.houseAddress) {
            af.innerHTML = `<div class="card"><h3 style="margin-top:0">Address on file (NIPOST autofill)</h3><p style="margin:0">` +
              [res.houseAddress, res.locality, res.lga, res.state, res.zone].filter(Boolean).map(esc).join("<br>") +
              `</p></div>`;
          } else if (l2denied) {
            af.innerHTML = `<p class="small">Address details need NIPOST access above L1 — this key is L1-only, so autofill is not available here. Validity is confirmed above.</p>`;
          } else if (mode === "live") {
            af.innerHTML = `<p class="small">Address autofill needs a higher NIPOST access level (L2+) — this integration only uses L1 validity on a live key.</p>`;
          }
        }
      } else if (res.status === "not_found") {
        el.textContent = mode === "sandbox"
          ? "Not found in the sandbox — it only holds NIPOST's published sample codes, so a real building code is not expected to resolve here. The structure above is valid. Try the sample code below to see a confirmed check."
          : "NIPOST has no record of this postcode — it may be unassigned or mistyped. The structure above is valid; double-check the code or find it at postcode.gov.ng/find.";
      } else {
        el.textContent = "NIPOST did not confirm this code. The structure above is valid; double-check the code and try again.";
      }
    });
    // Discovery buttons.
    $("explorer-gps").addEventListener("click", explorerGps);
    $("explorer-mappick").addEventListener("click", () => {
      showView("map");
      toast("Tap the map to drop your pin — the nearest stations appear below.");
    });
  }

  function explorerReference(p) {
    const s = p.segments;
    if (!p.stateConfirmed) return; // reference endpoints need a real state code
    F.postcode.lgasApi(s.state).then((env) => {
      const el = $("explorer-lga-name");
      if (!el) return;
      const list = env && env.result && env.result.lgas;
      if (!Array.isArray(list)) { el.textContent = ""; return; }
      const hit = list.find((x) => x.code === s.lga);
      el.textContent = hit ? hit.name : "not in NIPOST's LGA list for this state";
    });
    F.postcode.districtsApi(s.state, s.lga).then((env) => {
      const el = $("explorer-district-mark");
      if (!el) return;
      const list = env && env.result && env.result.districts;
      if (!Array.isArray(list)) { el.textContent = ""; return; }
      el.textContent = list.some((x) => x.code === s.district) ? "✓ listed" : "not listed";
    });
    F.postcode.areasApi(s.state, s.lga, s.district).then((env) => {
      const el = $("explorer-area-mark");
      if (!el) return;
      const list = env && env.result && env.result.areas;
      if (!Array.isArray(list)) { el.textContent = ""; return; }
      el.textContent = list.some((x) => x.code === s.area) ? "✓ listed" : "not listed";
    });
  }

  function explorerGps() {
    const box = $("explorer-nearby");
    if (!box) return;
    if (!navigator.geolocation) {
      box.innerHTML = `<p class="notice err">Your device does not support location. Pick on the map instead.</p>`;
      return;
    }
    box.innerHTML = `<p class="small">Getting your location…</p>`;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        box.innerHTML = `<p class="small" id="explorer-reverse">Looking up this spot's postcode…</p>` +
          nearestPreviewHtml(lat, lng, 3) +
          `<button class="btn" id="explorer-see-all">See all stations near here</button>`;
        wirePreviewClicks(box);
        $("explorer-see-all").addEventListener("click", () => {
          setUserLoc(lat, lng, "Your location (GPS)");
          showView("map");
        });
        // Reverse lookup: the postcode AT this spot, if NIPOST has one
        // within range. In the sandbox that is almost never — said plainly.
        F.postcode.reverseApi(lat, lng).then((env) => {
          const el = $("explorer-reverse");
          if (!el) return;
          const res = env && env.result;
          const foundCode = res && (res.postcode || res.code || (res.data && res.data.postcode));
          if (res && res.found && foundCode) {
            el.textContent = `NIPOST has postcode ${foundCode} for this spot.`;
          } else if (res && res.found === false) {
            el.textContent = "NIPOST has no postcode within 25 m of this spot in the sandbox — the sandbox only covers sample places. Your nearest stations are below.";
          } else {
            el.textContent = "";
          }
        });
      },
      () => {
        box.innerHTML = `<p class="notice err">Could not get your location — check that location is allowed for this site, or pick on the map instead.</p>`;
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }

  // Autocomplete while typing a partial NDAPS code (segment-aware: NIPOST
  // completes one segment at a time). Sandbox only: the current docs say
  // autocomplete consumes credits, and on a live key every keystroke
  // would spend them — so in live mode no suggestions are offered and
  // the Check button is the way in.
  function explorerSuggest() {
    const input = $("explorer-input");
    const box = $("explorer-suggest");
    if (!input || !box) return;
    clearTimeout(explorerSuggestTimer);
    const raw = input.value;
    if (!/[A-Za-z]/.test(raw)) { box.innerHTML = ""; return; }
    explorerSuggestTimer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q || !/[A-Za-z]/.test(q)) { box.innerHTML = ""; return; }
      const st = await F.postcode.statusApi();
      if (!st || st.mode !== "sandbox") { box.innerHTML = ""; return; }
      const env = await F.postcode.searchApi(q);
      const res = env && env.result;
      const sugg = res && res.suggestions;
      if (!Array.isArray(sugg) || !sugg.length) { box.innerHTML = ""; return; }
      const last = q.split(/[\s-]+/).filter(Boolean).pop() || "";
      const fresh = sugg.filter((x) => x && x.code && x.code.toUpperCase() !== last.toUpperCase());
      if (!fresh.length) { box.innerHTML = ""; return; }
      box.innerHTML = `<span class="small">NIPOST suggests (${esc(res.segment || "segment")}): </span>` +
        fresh.slice(0, 5).map((x) => `<button type="button" class="suggest-chip" data-code="${esc(x.code)}">${esc(x.code)}${x.label ? " — " + esc(x.label) : ""}</button>`).join("");
      box.querySelectorAll(".suggest-chip").forEach((b) =>
        b.addEventListener("click", () => {
          const parts = input.value.trim().split(/[\s-]+/).filter(Boolean);
          parts[parts.length - 1] = b.dataset.code;
          input.value = parts.join(" ") + " ";
          input.focus();
          box.innerHTML = "";
        }));
    }, 300);
  }

  // ---------------- station list ----------------
  function populateStateFilters() {
    // 19 Nov 2026: each tab's dropdown counts only what the tab shows —
    // Stations counts refuelling + both, Centres counts conversion + both.
    const scopes = {
      "state-filter": allStations().filter((s) => s.type !== "conversion"),
      "centre-state-filter": allStations().filter((s) => s.type !== "refuelling"),
    };
    Object.entries(scopes).forEach(([id, list]) => {
      const sel = $(id);
      if (!sel) return;
      const states = [...new Set(list.map((s) => s.state))].sort();
      const cur = sel.value;
      sel.innerHTML = `<option value="">All states (${states.length})</option>` +
        states.map((s) => `<option value="${esc(s)}">${esc(s)} (${list.filter((x) => x.state === s).length})</option>`).join("");
      sel.value = cur;
    });
  }
  function filteredStations() {
    const q = ($("station-search").value || "").trim().toLowerCase();
    const st = $("state-filter").value;
    let list = allStations().filter((s) => {
      // Stations tab shows refuelling stations only (19 Nov 2026):
      // conversion centres live under the Centres tab. "Both" entries
      // sell gas, so they stay. (The old type chips are gone — the tab
      // itself is the filter now.)
      if (s.type === "conversion") return false;
      if (st && s.state !== st) return false;
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
    // Live entries have no favourite button: a LIVE- id would not survive
    // the daily merge, so a saved favourite would point at nothing.
    const favBtn = s.live ? "" : `<button class="fav-btn" data-fav="${s.id}" aria-label="Favourite">${favs.has(s.id) ? "★" : "☆"}</button>`;
    const st = statusOf(s.id);
    const precChip = coordPrecision(s) === "town" ? " " + precisionChip(s) : "";
    const liveBadge = s.live ? ` <span class="badge live-new">🆕 New — just listed</span>` : "";
    // One-tap report (19 Nov 2026): refuelling stations only — conversion
    // centres don't sell gas — and never live entries (a LIVE- id would
    // not survive the daily merge, so the report would be orphaned).
    const qrBtns = (s.type !== "conversion" && !s.live)
      ? `<div class="quick-report"><button class="qr-btn qr-yes" data-qr="${s.id}|available" aria-label="Report gas available here">✅ Has gas</button><button class="qr-btn qr-no" data-qr="${s.id}|finished" aria-label="Report gas finished here">🔴 Out</button></div>`
      : "";
    return `<div class="card station st-${st}" data-id="${s.id}"><h3>${esc(s.name)} ${favBtn}</h3>` +
      `<p class="meta">${esc(s.address || "")}</p>` +
      `<p class="meta">${esc(locLabel(s))}${d}${noc}</p>` +
      `<div class="row">${statusBadge(s.id, true)} ${typeBadge(s.type)} ${verifyBadge(s)}${precChip}${liveBadge}</div>${qrBtns}</div>`;
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
    // One-tap report buttons: stopPropagation so the tap reports instead
    // of opening the station detail.
    box.querySelectorAll("[data-qr]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const [id, status] = btn.dataset.qr.split("|");
        quickReport(id, status, btn);
      }));
  }
  function renderStations() {
    if (!dataLoaded) return;
    const list = filteredStations();
    const box = $("station-results");
    const stationTotal = allStations().filter((s) => s.type !== "conversion").length;
    $("station-count").textContent = list.length + " of " + stationTotal + " refuelling stations" +
      (sortMode === "favs" ? " · your favourites" : userLoc ? " · sorted by distance from your spot" : " · set your location to sort by distance");
    // State landing summary — genuinely useful content for ?state= pages.
    // Stations only (19 Nov 2026): conversion centres are counted on
    // the Centres tab, not here.
    let summaryHtml = "";
    const st = $("state-filter").value;
    if (st) {
      const inState = stations.filter((s) => s.state === st && s.type !== "conversion");
      const mapped = inState.filter((s) => s.lat).length;
      const refReg = inState.filter((s) => s.refReg).length;
      const stale = inState.filter((s) => s.confidence === "stale-2024-list").length;
      summaryHtml = `<div class="card"><h3 style="margin-top:0">CNG in ${esc(st)}</h3>` +
        `<p style="margin:0"><b>${inState.length}</b> refuelling location(s). ` +
        `<b>${mapped}</b> on the map · <b>${refReg}</b> on the Pi-CNG refuelling register` +
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
    // Phase 4 (§20): when live reports cannot be reached, show NO outage
    // list at all — the old code kept listing stations from the last
    // known state, which presented possibly-stale availability as
    // current. An outage is only shown while a fresh report is live.
    if (!reportsLive) {
      $("outages-count").textContent = navigator.onLine === false
        ? "You are offline — live reports need a connection."
        : "Live reports could not be reached — check your connection.";
      box.innerHTML = `<div class="empty"><div class="big">📴</div><p><b>Live outages need a connection.</b></p><p>Outages are only shown while a fresh report is live (2 hours). Reconnect to see the current list — the station directory still works offline.</p></div>`;
      return;
    }
    // Finished OR closed (Phase 1): the map filter already treated closed
    // stations as outages, but this view only listed "finished".
    const list = stations.filter((s) => statusOf(s.id) === "finished" || statusOf(s.id) === "closed")
      .sort((a, b) => (reports.get(b.id)?.ts || 0) - (reports.get(a.id)?.ts || 0));
    $("outages-count").textContent = list.length
      ? list.length + " station(s) reported out of gas or closed in the last 2 hours"
      : "No station is currently reported out of gas. Good news — or no fresh reports yet.";
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">✅</div><p><b>Nothing out of gas right now.</b></p><p>No station has a fresh “Gas finished” or “Closed” report. If you find one empty, report it so other drivers don't waste the trip.</p></div>`;
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
    const hits = allStations().filter((s) => s.acc && normName(s.name).includes(nq)).slice(0, 8);
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
    let list = allStations().filter((s) => s.type !== "refuelling");
    if (st) list = list.filter((s) => s.state === st);
    if (q) list = list.filter((s) => (`${s.name} ${s.address || ""} ${s.city || ""} ${s.state}`).toLowerCase().includes(q));
    list.sort((a, b) => (a.state + a.name).localeCompare(b.state + b.name));
    const box = $("centre-results");
    $("centre-count").textContent = list.length + " conversion centres" +
      (st ? " in " + st : " nationwide") + " · " + allStations().filter((s) => s.acc).length + " on the Pi-CNG accredited list";
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
    const s = findStation(id);
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
    const s = findStation(id);
    if (!s) return;
    const box = $("station-detail");
    const st = statusOf(id);
    const r = reports.get(id);
    const fav = favs.has(id) ? "★ Saved" : "☆ Save";
    const wa = s.phone ? normalizeNgPhone(s.phone) : null;
    const distText = (userLoc && s.lat && s.lng) ? fmtKm(haversineKm(userLoc.lat, userLoc.lng, s.lat, s.lng)) : null;
    // WhatsApp share (19 Nov 2026): a snapshot message — name, address,
    // live status with its age when a fresh report exists, and the deep
    // link. wa.me/?text= opens the share picker, no number needed.
    // Address line: append only the trailing city/state parts the
    // address doesn't already end with. A whole-string includes() check
    // fails when city == state ("Lagos, Lagos" is not contained in an
    // address ending "...Ikeja, Lagos") and produced "Lagos, Lagos,
    // Lagos" — caught by the live check on CNG-019, 19 Nov 2026.
    const locParts = locLabel(s) ? locLabel(s).split(", ").filter(Boolean) : [];
    let addrLine = s.address || "";
    for (const part of locParts) {
      if (!addrLine.toLowerCase().endsWith(part.toLowerCase())) {
        addrLine = addrLine ? addrLine + ", " + part : part;
      }
    }
    const shareStatus = (r && st !== "unconfirmed")
      ? `\n${F.STATUS[st].label} (reported ${timeAgo(r.ts)})` : "";
    const shareHref = "https://wa.me/?text=" + encodeURIComponent(
      `${s.name}\n${addrLine}${shareStatus}\nLive CNG status: ${stationUrl(id)}`);
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
      ? `<div class="detail-hero photo"><div class="detail-photo-wrap"><img src="${esc(photo.url)}" alt="Photo of ${esc(s.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">${photo.attribution ? `<span class="photo-credit">Photo: ${esc(photo.attribution)}</span>` : ""}</div>${heroBody}</div>`
      : `<div class="detail-hero">${heroBody}</div>`;
    let statusBlock;
    if (!reportsLive) {
      statusBlock = navigator.onLine === false
        ? `<div class="notice">You are offline — live reports need a connection, so no availability is shown here. The listing below is the saved copy.</div>`
        : `<div class="notice">Live reports could not be reached — check your connection and reload. The listing below is still accurate.</div>`;
    } else if (r && st !== "unconfirmed") {
      statusBlock =
        `<p><b>Live status: ${F.STATUS[st].label}</b> · reported ${timeAgo(r.ts)}` +
        `${r.source === "operator" ? ` <span class="op-chip">✓ Operator confirmed</span>` : ""}` +
        `${r.queue ? ` · queue about ${r.queue} min` : ""}` +
        `${r.pressure === true ? " · pressure OK" : r.pressure === false ? " · low pressure" : ""}` +
        `${r.compressor === true ? " · compressor working" : r.compressor === false ? " · compressor faulty" : ""}</p>` +
        `<p class="small">Is this still right?</p>` +
        `<div class="confirm-row" id="confirm-row"><button data-vote="yes">✓ Yes</button><button data-vote="unsure">? Not sure</button><button data-vote="no">✗ No</button></div>` +
        `<p class="small" id="confirm-counts"></p>` +
        `<p class="small" id="confidence-line"></p>`;
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
      // Live entries (2.6): no gas report, no reliability history, no
      // favourite and no listing-report buttons — a LIVE- id would not
      // survive the daily merge, so anything filed against it would be
      // orphaned. They get a just-listed notice instead.
      (s.live
        ? `<div class="card"><p><b>🆕 Just listed on the Pi-CNG register${s.liveListedAt ? " — " + fmtDate(s.liveListedAt) : ""}.</b></p>` +
          `<p class="small">This centre appeared on the live register after the last daily update. Its map pin, opening hours and reports appear once the daily check verifies it — usually within a day. The address above is what the register lists.</p></div>`
        : `<div class="card">${statusBlock}` +
          `<button class="btn" data-open-report=\"${s.id}\">Report gas status here</button>` +
          ((st === "finished" || st === "closed" || st === "low")
            ? `<button class="btn yellow" style="margin-top:8px" data-back-normal=\"${s.id}\">✅ Back to normal — gas is back</button>` : "") +
          `</div>`) +
      `<div class="card"><h3 style="margin-top:0">Opening hours</h3>${hoursHtml(s)}</div>` +
      verificationCard(s) +
      `<div id="op-claim-badge"></div>` +
      `<div class="card"><h3 style="margin-top:0">Services</h3>${servicesHtml(s)}</div>` +
      `<div class="card"><h3 style="margin-top:0">Price</h3>${priceHtml(s)}</div>` +
      (s.live ? "" : `<div class="card"><h3 style="margin-top:0">Reliability — last 30 days</h3><div id="reliability-box"><p class="small">Loading report history…</p></div></div>`) +
      `<div class="detail-actions">` +
        (s.live ? "" : `<button class="fav-btn ${favs.has(id) ? "on" : ""}" id="detail-fav">${fav}</button>`) +
        `<button class="btn outline small" id="detail-share">🔗 Copy link</button>` +
        `<a class="btn outline small" href="${shareHref}" target="_blank" rel="noopener">💬 Share on WhatsApp</a>` +
      `</div>` +
      (s.live ? "" : `<div class="detail-actions">` +
        `<button class="btn outline small" data-listing-link=\"${s.id}|incorrect\">⚠️ Report an incorrect listing</button>` +
        `<button class="btn outline small" data-listing-link=\"${s.id}|closed\">⛔ Report a closure</button>` +
      `</div>`) +
      (s.live ? "" : `<div class="detail-actions">` +
        `<button class="btn outline small" id="detail-claim">🏢 Are you the operator? Claim this station</button>` +
        `<button class="btn outline small" id="detail-op-update">✏️ Request an update</button>` +
      `</div>`) +
      (!s.lat && !s.live ? `<p class="notice">This entry has no map position yet — its coordinates have not been recorded. The address above is what we have. If you know the exact spot, open “Report an incorrect listing” below and send the coordinates.</p>` : "") +
      `<p class="small">Source: ${esc(s.src)}${s.acc && !s.live ? " · Checked 18 Nov 2026" : ""}${s.live && s.liveListedAt ? " · Listed " + fmtDate(s.liveListedAt) : ""} · Listing ID ${esc(s.id)}</p>`;
    const favBtnEl = $("detail-fav");
    if (favBtnEl) favBtnEl.addEventListener("click", () => { toggleFav(id); renderDetail(id); });
    // Photo hero (2.1): if the photo fails to load, drop back to the
    // clean typographic band. Wired here, not as an inline onerror, so
    // the CSP can run without 'unsafe-inline' (Phase 4, §19).
    const photoImg = box.querySelector(".detail-photo-wrap img");
    if (photoImg) photoImg.addEventListener("error", () => {
      const hero = photoImg.closest(".detail-hero");
      if (hero) hero.classList.remove("photo");
      const wrap = photoImg.closest(".detail-photo-wrap");
      if (wrap) wrap.remove();
    });
    $("detail-share").addEventListener("click", () => {
      const url = stationUrl(id);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(() => toast("Link copied — share it anywhere.")).catch(() => toast(url));
      } else { toast(url); }
    });
    // Operator portal entry points (Phase 4, §15): claim this station
    // or request an update — both open the portal prefilled.
    const claimBtn = $("detail-claim");
    if (claimBtn) claimBtn.addEventListener("click", () => openOperator("claim", id));
    const updBtn = $("detail-op-update");
    if (updBtn) updBtn.addEventListener("click", () => openOperator("update", id));
    loadClaimBadge(id);
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
      renderConfidenceLine(null, "confirmations aren't open yet");
      return;
    }
    if (cached) { renderConfirmCounts(cached); return; }
    fetch(`/api/confirmations?report_id=${encodeURIComponent(reportId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error === "not_open") {
          confirmCache.set(reportId, "not_open");
          el.textContent = "Confirmations aren't open yet — the database table is still being set up.";
          renderConfidenceLine(null, "confirmations aren't open yet");
          return;
        }
        if (j && j.ok) { confirmCache.set(reportId, j.counts); renderConfirmCounts(j.counts); }
      })
      .catch(() => { /* counts are optional */ });
  }
  function renderConfirmCounts(c) {
    const el = $("confirm-counts");
    if (el) {
      const total = (c.yes || 0) + (c.unsure || 0) + (c.no || 0);
      el.textContent = total
        ? `Confirmed by other drivers: ✓ ${c.yes} · ? ${c.unsure} · ✗ ${c.no}`
        : "No confirmations yet — be the first.";
    }
    renderConfidenceLine(c);
  }
  // Confidence line on the detail page — the level chip plus the honest
  // "why" (age + confirmations + source). Only rendered once the counts
  // are known (or known-unavailable); an empty line stays empty rather
  // than guessing.
  function renderConfidenceLine(counts, countsLabel) {
    const line = $("confidence-line");
    const r = currentStation ? reports.get(currentStation) : null;
    if (!line || !r) return;
    const conf = confidenceFor(Date.now() - r.ts, counts, countsLabel, r.source || "community");
    line.innerHTML = confidenceChipHtml(conf) + ` <span>${esc(conf.why)}</span>`;
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
          refreshHomeConfidence(); // a feed confirm updates the feed chip too
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
  // One-tap report from a station card or map popup (19 Nov 2026): posts
  // immediately with no queue/pressure details — the full four-option
  // form stays in the detail view. Same trust model as the full flow:
  // anonymous, live for 2 hours. The tapped button disables while the
  // post is in flight so a double-tap can't file twice.
  function quickReport(id, status, btn) {
    if (!id || (status !== "available" && status !== "finished")) return;
    if (btn) btn.disabled = true;
    postReport({ station_id: id, status, queue_minutes: null, pressure_ok: null, compressor_ok: null })
      .then((j) => {
        if (j && j.ok) {
          reports.set(id, { id: (j.report && j.report.id) || null, status, queue: null,
            pressure: null, compressor: null, ts: Date.now() });
          toast(status === "available"
            ? "Thank you — marked as gas available for the next 2 hours."
            : "Thank you — marked as gas finished for the next 2 hours.");
          refreshStatuses();
        } else if (j && j.configured === false) {
          toast("The reporting server is not available — nothing was saved.");
          if (btn) btn.disabled = false;
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => {
        toast("Couldn't reach the server — try again. Nothing was saved.");
        if (btn) btn.disabled = false;
      });
  }
  window.quickReport = quickReport;

  // ---------------- listing reports (Phase 3, §14) ------------------
  // Types: incorrect | coordinates | contact | closed | moved | safety |
  // missing | other. "missing" suggests a station that is not listed yet
  // (station_id "NEW") — opened from Help, the Stations tab and the
  // Intelligence gaps card, not from a station page. Newer types are
  // stored under the closest original DB type with a tag in the details
  // (see api/listing-reports.js); listingTypeLabel renders the tag back.
  function listingTypeLabel(reportType, details) {
    const d = details || "";
    if (d.startsWith("[Wrong coordinates]")) return "Wrong coordinates";
    if (d.startsWith("[Updated contact]")) return "Updated contact details";
    if (d.startsWith("[Safety concern]")) return "Safety concern";
    if (d.startsWith("[Missing station]")) return "Missing station";
    return { incorrect: "Incorrect details", closed: "Closed", moved: "Moved", other: "Other" }[reportType] || reportType;
  }
  function updateListingDetailsHint() {
    const type = (document.querySelector('input[name="listing-type"]:checked') || {}).value || "other";
    const label = $("listing-details-label");
    const input = $("listing-details");
    if (!label || !input) return;
    if (type === "missing") {
      label.textContent = "Station details — required";
      input.placeholder = "Name, address and state — e.g. XYZ Filling Station, 12 Allen Avenue, Ikeja, Lagos. The moderator checks it against official lists before adding it — nothing is published unverified.";
    } else if (type === "coordinates") {
      label.textContent = "Details — what is wrong with the location?";
      input.placeholder = "e.g. The pin is in the wrong place — the station is actually at… (paste coordinates from your maps app if you have them)";
    } else if (type === "contact") {
      label.textContent = "Updated contact details";
      input.placeholder = "e.g. The correct phone number is 0803…";
    } else if (type === "safety") {
      label.textContent = "Details — what is the safety concern?";
      input.placeholder = "e.g. Staff were filling a cooking-gas cylinder / a cylinder on display looks welded…";
    } else {
      label.textContent = "Details — optional";
      input.placeholder = "e.g. The phone number is wrong — the correct one is…";
    }
  }
  function openListing(id, type) {
    const isNew = id === "NEW";
    const s = isNew ? null : stations.find((x) => x.id === id);
    if (!isNew && !s) return;
    listingStation = isNew ? "NEW" : id;
    $("listing-title").textContent = isNew ? "Suggest a missing station" : "Report: " + s.name;
    // The "missing" type only makes sense when suggesting a new place;
    // the other types only make sense for an existing listing.
    document.querySelectorAll("[data-lr-row]").forEach((row) => {
      row.classList.toggle("hidden",
        isNew ? row.dataset.lrRow !== "missing" : row.dataset.lrRow === "missing");
    });
    document.querySelectorAll('input[name="listing-type"]').forEach((r) => {
      r.checked = r.value === (type || (isNew ? "missing" : "incorrect"));
    });
    updateListingDetailsHint();
    $("listing-details").value = "";
    $("listing-msg").classList.add("hidden");
    $("listing-form").classList.remove("hidden");
    $("listing-success").classList.add("hidden");
    $("listing-backdrop").classList.add("open");
  }
  window.openListing = openListing;
  function submitListing() {
    const msg = $("listing-msg");
    const type = (document.querySelector('input[name="listing-type"]:checked') || {}).value || "other";
    const details = $("listing-details").value.trim();
    if (listingStation === "NEW" && details.length < 10) {
      msg.textContent = "Please name the station, its address and its state — the moderator needs those to check it.";
      msg.className = "notice err"; msg.classList.remove("hidden");
      return;
    }
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
        if (j && j.ok && j.id) {
          // Submission tracking (§14): the reference is shown in the
          // sheet and saved on this device, so the submitter can check
          // the report's status later (Help → Check a report).
          try { localStorage.setItem("findcng_last_lr", j.id); } catch { /* ignore */ }
          $("listing-form").classList.add("hidden");
          $("listing-success-note").textContent = j.duplicate
            ? "This was already reported — a moderator is reviewing it. Your reference:"
            : "Thank you — a moderator will review this. Your reference:";
          $("listing-ref").value = j.id;
          $("listing-success").classList.remove("hidden");
        } else {
          throw new Error((j && j.error) || "failed");
        }
      })
      .catch(() => {
        msg.textContent = "Couldn't reach the server — try again. Your report was NOT saved.";
        msg.className = "notice err"; msg.classList.remove("hidden");
      });
  }
  // Submission tracking (§14): check a listing report's status by its
  // reference. The API returns public fields only — never the reporter's
  // fingerprint.
  function checkListingStatus() {
    const input = $("lr-check-input");
    const out = $("lr-check-result");
    if (!input || !out) return;
    const id = (input.value || "").trim();
    if (!id) {
      out.innerHTML = `<p class="small">Enter the reference shown when you sent the report — it is also saved on this device if you sent it from here.</p>`;
      return;
    }
    out.innerHTML = `<p class="small">Checking…</p>`;
    fetch(`/api/listing-reports?id=${encodeURIComponent(id)}`)
      .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
      .then(({ status, body }) => {
        if (status === 404 || !body || !body.ok) {
          out.innerHTML = `<p class="notice err">No report with that reference — check it and try again. The reference is the long code shown when you sent the report.</p>`;
          return;
        }
        const r = body.report;
        const what = r.station_id === "NEW" ? "Suggested new station"
          : (findStation(r.station_id) ? findStation(r.station_id).name : r.station_id);
        out.innerHTML = `<p style="margin:0"><b>${esc(what)}</b> — ${esc(listingTypeLabel(r.report_type, r.details))}<br>` +
          `Status: <b>${esc(r.status)}</b> · reported ${esc(fmtDate(r.reported_at))}` +
          (r.resolution_note ? `<br>Moderator note: ${esc(r.resolution_note)}` : "") +
          (r.status === "open" ? `<br><span class="small">A moderator reviews open reports in turn — nothing is published from a report until a human checks it.</span>` : "") + `</p>`;
      })
      .catch(() => {
        out.innerHTML = `<p class="notice err">Could not reach the server — try again.</p>`;
      });
  }

  // ---------------- operator portal (Phase 4, §15) ----------------
  // Verification-first: every submission goes to a moderator queue and
  // NOTHING is published until an admin approves that exact submission.
  // The portal is a form + a status check — there are no operator
  // accounts and no automatic verification anywhere in this flow.
  const OPERATOR_STATES = ["Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"];
  const OP_TYPE_HELP = {
    register: "Register a conversion centre or refuelling station that is not in the directory yet. A moderator checks it against official lists before anything is published.",
    claim: "Claim the listing of a station or centre you own or run. You will need a business documentation reference, and the moderator confirms by phone before approving — nobody can claim a station that is not theirs.",
    update: "Ask for a correction to your listing — opening hours, services, phone number, or anything else that is wrong. The moderator checks it before the listing changes.",
    availability: "Tell drivers whether your station has gas right now. Your update only becomes “Operator confirmed” on the listing after a moderator approves it — until then, nothing changes.",
    response: "Answer a user report about your station — for example a listing report you disagree with. Your response goes to the moderator, not straight onto the listing.",
  };
  const OP_DETAILS = {
    update: { label: "What should change? *", placeholder: "e.g. Our opening hours are now 7am–9pm daily, and our phone number is 0803…" },
    response: { label: "Your response *", placeholder: "What do you want the moderator to know about this report?" },
    claim: { label: "Anything else for the moderator", placeholder: "Optional — e.g. the best time to reach you by phone." },
  };
  let opType = "register";
  let opStationId = null;   // directory id picked in the station search
  let opStatus = null;      // availability status picked on the grid
  const claimCache = new Map(); // station id -> { claimed, business_name } | "failed"

  // "Operator-verified listing" badge on the detail page — shown only
  // when an APPROVED claim exists for the station (public endpoint,
  // business name only, no contact details). Silent when the portal is
  // not open yet: no badge is the honest state then.
  function loadClaimBadge(stationId) {
    const box = $("op-claim-badge");
    if (!box) return;
    const cached = claimCache.get(stationId);
    if (cached === "failed") return;
    if (cached) {
      if (cached.claimed) box.innerHTML = `<div class="card"><p style="margin:0"><span class="op-chip">✓ Operator-verified listing</span> — this listing is claimed by <b>${esc(cached.business_name || "its operator")}</b>, verified by a moderator.</p></div>`;
      return;
    }
    fetch(`/api/operator?station=${encodeURIComponent(stationId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) { claimCache.set(stationId, "failed"); return; }
        claimCache.set(stationId, j);
        if (j.claimed) box.innerHTML = `<div class="card"><p style="margin:0"><span class="op-chip">✓ Operator-verified listing</span> — this listing is claimed by <b>${esc(j.business_name || "its operator")}</b>, verified by a moderator.</p></div>`;
      })
      .catch(() => claimCache.set(stationId, "failed"));
  }

  // Open the portal for one action, optionally prefilled with a station
  // (from the detail page). Exposed globally for the detail buttons.
  function openOperator(type, stationId) {
    if (OP_TYPE_HELP[type]) setOpType(type);
    if (stationId) {
      const s = findStation(stationId);
      if (s) {
        opStationId = stationId;
        const search = $("op-station-search");
        const sel = $("op-station-selected");
        if (search) search.value = s.name;
        if (sel) sel.innerHTML = `Selected: <b>${esc(s.name)}</b> (${esc(s.id)}) — ${esc(locLabel(s))}`;
        const res = $("op-station-results");
        if (res) res.innerHTML = "";
      }
    }
    showView("operator");
  }
  window.openOperator = openOperator;

  function setOpType(type) {
    opType = type;
    document.querySelectorAll("#op-type-chips .chip").forEach((c) =>
      c.classList.toggle("on", c.dataset.opType === type));
    const help = $("op-type-help");
    if (help) help.textContent = OP_TYPE_HELP[type] || "";
    const show = (id, on) => { const el = $(id); if (el) el.classList.toggle("hidden", !on); };
    const needsStation = type !== "register";
    show("op-station-field", needsStation);
    show("op-address-field", type === "register");
    show("op-state-field", type === "register");
    show("op-services-field", type === "register");
    show("op-accred-field", type === "register");
    show("op-accred-no-field", type === "register");
    show("op-coords-field", type === "register");
    show("op-proof-field", type === "claim");
    show("op-details-field", type === "update" || type === "response" || type === "claim");
    const d = OP_DETAILS[type];
    if (d) {
      const lbl = $("op-details-label");
      const ta = $("op-details");
      if (lbl) lbl.textContent = d.label;
      if (ta) ta.placeholder = d.placeholder;
    }
    show("op-status-field", type === "availability");
    show("op-queue-field", type === "availability");
    show("op-pressure-field", type === "availability");
    show("op-compressor-field", type === "availability");
    show("op-reportref-field", type === "response");
    if (type !== "availability") { opStatus = null; }
    const msg = $("op-msg");
    if (msg) msg.classList.add("hidden");
  }

  function opStationSearch() {
    const q = ($("op-station-search").value || "").trim().toLowerCase();
    const res = $("op-station-results");
    if (!res) return;
    if (q.length < 2) { res.innerHTML = ""; return; }
    // Multi-word search: every word must appear somewhere in the
    // station's name, city, state or address ("NIPCO Benin" matches a
    // NIPCO station in Benin City even though no single field contains
    // the whole phrase).
    const words = q.split(/\s+/).filter(Boolean);
    const hay = (s) => `${s.name || ""} ${s.city || ""} ${s.state || ""} ${s.address || ""}`.toLowerCase();
    const hits = allStations()
      .filter((s) => !s.live && words.every((w) => hay(s).includes(w)))
      .slice(0, 8);
    if (!hits.length) {
      res.innerHTML = `<p class="small">No listing matches that name. If the station is not in the directory yet, use “Register a centre” instead.</p>`;
      return;
    }
    res.innerHTML = hits.map((s) =>
      `<button type="button" class="op-pick" data-op-pick="${s.id}"><b>${esc(s.name)}</b><br><span class="small">${esc(locLabel(s))} · ${esc(s.id)}</span></button>`).join("");
    res.querySelectorAll("[data-op-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const s = findStation(b.dataset.opPick);
        if (!s) return;
        opStationId = s.id;
        $("op-station-search").value = s.name;
        $("op-station-selected").innerHTML = `Selected: <b>${esc(s.name)}</b> (${esc(s.id)}) — ${esc(locLabel(s))}`;
        res.innerHTML = "";
      }));
  }

  function submitOperator() {
    const msg = $("op-msg");
    const business = ($("op-business").value || "").trim();
    if (business.length < 2) {
      msg.textContent = "Enter your business name.";
      msg.className = "notice err"; msg.classList.remove("hidden"); return;
    }
    const body = {
      type: opType,
      business_name: business,
      contact_name: ($("op-contact").value || "").trim() || undefined,
      phone: ($("op-phone").value || "").trim() || undefined,
      email: ($("op-email").value || "").trim() || undefined,
    };
    if (opType === "register") {
      body.address = ($("op-address").value || "").trim();
      body.state = $("op-state").value || "";
      body.services = ($("op-services").value || "").trim() || undefined;
      body.accreditation_body = ($("op-accred-body").value || "").trim() || undefined;
      body.accreditation_number = ($("op-accred-no").value || "").trim() || undefined;
      const lat = $("op-lat").value, lng = $("op-lng").value;
      if (lat !== "" && lng !== "") { body.latitude = Number(lat); body.longitude = Number(lng); }
      if (body.address.length < 10) {
        msg.textContent = "Enter the centre's address — enough for a driver to find it.";
        msg.className = "notice err"; msg.classList.remove("hidden"); return;
      }
      if (!body.state) {
        msg.textContent = "Select the state the centre is in.";
        msg.className = "notice err"; msg.classList.remove("hidden"); return;
      }
    } else {
      if (!opStationId) {
        msg.textContent = "Pick your station from the search results first.";
        msg.className = "notice err"; msg.classList.remove("hidden"); return;
      }
      body.station_id = opStationId;
      if (!body.phone && !body.email) {
        msg.textContent = "Enter a phone number or email so the moderator can reach you.";
        msg.className = "notice err"; msg.classList.remove("hidden"); return;
      }
      if (opType === "claim") {
        body.proof_reference = ($("op-proof").value || "").trim();
        body.details = ($("op-details").value || "").trim() || undefined;
        if (body.proof_reference.length < 10) {
          msg.textContent = "Enter a business documentation reference (at least 10 characters) — the moderator checks it before approving a claim.";
          msg.className = "notice err"; msg.classList.remove("hidden"); return;
        }
      } else if (opType === "update" || opType === "response") {
        body.details = ($("op-details").value || "").trim();
        if (body.details.length < 10) {
          msg.textContent = opType === "update"
            ? "Describe the change you are requesting."
            : "Write what you want the moderator to know.";
          msg.className = "notice err"; msg.classList.remove("hidden"); return;
        }
        if (opType === "response") {
          body.listing_report_id = ($("op-reportref").value || "").trim() || undefined;
        }
      } else if (opType === "availability") {
        if (!opStatus) {
          msg.textContent = "Pick the gas status — available, low, finished or closed.";
          msg.className = "notice err"; msg.classList.remove("hidden"); return;
        }
        body.status = opStatus;
        const q = $("op-queue").value;
        if (q !== "") body.queue_minutes = Number(q);
        const pr = $("op-pressure").value;
        if (pr === "yes") body.pressure_ok = true;
        else if (pr === "no") body.pressure_ok = false;
        const co = $("op-compressor").value;
        if (co === "yes") body.compressor_ok = true;
        else if (co === "no") body.compressor_ok = false;
      }
    }
    const btn = $("op-submit");
    btn.disabled = true;
    msg.classList.add("hidden");
    fetch("/api/operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
      .then(({ status, body: j }) => {
        btn.disabled = false;
        if (j && j.error === "not_open") {
          msg.textContent = "The operator portal is not open yet — the database table is still being set up. Nothing was saved; please try again later.";
          msg.className = "notice"; msg.classList.remove("hidden");
          return;
        }
        if (j && j.ok && j.id) {
          try { localStorage.setItem("findcng_last_op", j.id); } catch { /* ignore */ }
          $("op-form").classList.add("hidden");
          $("op-success-note").textContent = j.duplicate
            ? "This was already sent — a moderator is reviewing it. Your reference:"
            : "Thank you — a moderator will review this. Nothing is published until it is approved. Your reference:";
          $("op-ref").value = j.id;
          $("op-success").classList.remove("hidden");
          const checkInput = $("op-check-input");
          if (checkInput) checkInput.value = j.id;
        } else {
          msg.textContent = (j && j.error) || "Could not send — try again.";
          msg.className = "notice err"; msg.classList.remove("hidden");
        }
      })
      .catch(() => {
        btn.disabled = false;
        msg.textContent = "Couldn't reach the server — try again. Your submission was NOT saved.";
        msg.className = "notice err"; msg.classList.remove("hidden");
      });
  }

  function checkOperatorStatus() {
    const input = $("op-check-input");
    const out = $("op-check-result");
    if (!input || !out) return;
    const id = (input.value || "").trim();
    if (!id) {
      out.innerHTML = `<p class="small">Enter the reference shown when you sent the submission — it is also saved on this device if you sent it from here.</p>`;
      return;
    }
    out.innerHTML = `<p class="small">Checking…</p>`;
    fetch(`/api/operator?id=${encodeURIComponent(id)}`)
      .then((r) => r.json().then((j) => ({ status: r.status, body: j })))
      .then(({ status, body }) => {
        if (body && body.error === "not_open") {
          out.innerHTML = `<p class="notice">The operator portal is not open yet — the database table is still being set up.</p>`;
          return;
        }
        if (status === 404 || !body || !body.ok) {
          out.innerHTML = `<p class="notice err">No submission with that reference — check it and try again.</p>`;
          return;
        }
        const s = body.submission;
        const typeLabel = { register: "Centre registration", claim: "Ownership claim",
          update: "Update request", availability: "Availability update", response: "Response to a report" }[s.type] || s.type;
        const where = s.station_id && findStation(s.station_id) ? findStation(s.station_id).name : (s.station_id || "");
        out.innerHTML = `<p style="margin:0"><b>${esc(s.business_name)}</b> — ${esc(typeLabel)}${where ? ` · ${esc(where)}` : ""}<br>` +
          `Status: <b>${esc(s.status)}</b> · sent ${esc(fmtDate(s.submitted_at))}` +
          (s.decision_reason ? `<br>Moderator note: ${esc(s.decision_reason)}` : "") +
          (s.status === "pending" ? `<br><span class="small">A moderator reviews pending submissions in turn — nothing is published until it is approved.</span>` : "") + `</p>`;
      })
      .catch(() => {
        out.innerHTML = `<p class="notice err">Could not reach the server — try again.</p>`;
      });
  }

  function wireOperator() {
    const stateSel = $("op-state");
    if (stateSel) {
      OPERATOR_STATES.forEach((st) => {
        const o = document.createElement("option");
        o.value = st; o.textContent = st;
        stateSel.appendChild(o);
      });
    }
    document.querySelectorAll("#op-type-chips .chip").forEach((c) =>
      c.addEventListener("click", () => setOpType(c.dataset.opType)));
    const search = $("op-station-search");
    if (search) {
      search.addEventListener("input", () => { opStationId = null; $("op-station-selected").textContent = ""; opStationSearch(); });
    }
    document.querySelectorAll("[data-op-status]").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-op-status]").forEach((x) => x.classList.remove("sel"));
        b.classList.add("sel");
        opStatus = b.dataset.opStatus;
      }));
    $("op-submit").addEventListener("click", submitOperator);
    $("op-success-close").addEventListener("click", () => {
      $("op-success").classList.add("hidden");
      $("op-form").classList.remove("hidden");
    });
    $("op-ref-copy").addEventListener("click", () => {
      const ref = $("op-ref").value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ref).then(() => toast("Reference copied.")).catch(() => toast(ref));
      } else { toast(ref); }
    });
    $("op-check-go").addEventListener("click", checkOperatorStatus);
    $("op-check-input").addEventListener("keydown", (e) => { if (e.key === "Enter") checkOperatorStatus(); });
    try {
      const last = localStorage.getItem("findcng_last_op");
      if (last) $("op-check-input").value = last;
    } catch { /* ignore */ }
    setOpType("register");
  }

  // ---------------- route planner: REMOVED in 2.4 (18 Nov 2026) ----------------
  // Saheed asked for it to go: the map is not accurate enough overall and
  // routing did not pick some areas. The OSRM driving-route code, Nominatim
  // place lookup, auto stop suggestion, ETA-ring legs and the route map all
  // lived here. The ETA rings on the nearest-stations list (etaRing) are
  // NOT part of the planner and stay.

  // ---------------- calculator ----------------
  // Phase 3 (§12): CNG consumption is now its own editable input (km per
  // SCM), auto-filled from km/litre × 1.1 (1 SCM ≈ the energy of ~1.1
  // litres of petrol) and changeable by the user — a car that does
  // better or worse on CNG than the estimate can say so. Editing the
  // km/litre or the vehicle resets it to the estimate.
  let kmpscmEdited = false;
  let lastCalcSummary = ""; // the current calculation's shareable text, kept outside #calc-out
  function calc() {
    const v = F.VEHICLES[$("calc-vehicle").value];
    const kmDay = Math.max(0, parseFloat($("calc-km").value) || 0);
    const days = Math.max(1, Math.min(31, parseInt($("calc-days").value, 10) || 26));
    const kpl = Math.max(1, parseFloat($("calc-kpl").value) || v.kmPerLitre);
    const kmpscm = Math.max(0.5, parseFloat($("calc-kmpscm").value) || kpl * F.SCM_PER_LITRE_EQUIV);
    const petrol = Math.max(0, parseFloat($("calc-petrol").value) || F.PRICES.petrolPerLitre);
    const cng = Math.max(0, parseFloat($("calc-cng").value) || v.cngPrice);
    const cost = Math.max(0, parseFloat($("calc-cost").value) || 0);
    const kmMonth = kmDay * days;
    const litres = kmMonth / kpl;
    const scm = kmMonth / kmpscm;
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
      `<div class="calc-row"><span>Daily saving</span><b>${naira(saving / days)}</b></div>` +
      `<div class="calc-row"><span>Monthly saving</span><b>${naira(saving)}</b></div>` +
      `<div class="calc-row"><span>Annual saving</span><b>${naira(annual)}</b></div>` +
      `<div class="calc-row"><span>Distance / month</span><b>${kmMonth.toLocaleString()} km</b></div>` +
      `<div class="calc-row"><span>Petrol needed</span><b>${litres.toFixed(0)} litres</b></div>` +
      `<div class="calc-row"><span>CNG needed</span><b>${scm.toFixed(0)} SCM</b></div>` +
      `<div class="calc-row payback"><span>Conversion pays for itself in</span><b>${payback}</b></div>` +
      `</div><p class="small">${cost > 0 ? "Payback uses the conversion cost you entered (" + naira(cost) + "). " : esc(v.convLabel) + " "}Drivers report saving 50–75% on fuel in real life. ` +
      `This is fuel cost only — it does not count time spent queuing or extra plug/coil maintenance. ` +
      `CNG use is ${kmpscm.toFixed(1)} km per SCM (estimate — change it above if your car does better or worse on CNG).</p>`;
    // The shareable summary text lives in a variable, NOT in the
    // re-rendered output: the Copy/Download buttons are static HTML
    // below #calc-out (wired once in init) and read this variable.
    lastCalcSummary =
      `My CNG savings estimate (FindCNG Nigeria)\n` +
      `Vehicle: ${v.label} · ${kmDay} km/day × ${days} days = ${kmMonth.toLocaleString()} km/month\n` +
      `Petrol use: ${kpl} km/litre (${litres.toFixed(0)} litres/month at ₦${petrol}/litre) = ${naira(petrolCost)}/month\n` +
      `CNG use: ${kmpscm.toFixed(1)} km/SCM (${scm.toFixed(0)} SCM/month at ₦${cng}/SCM) = ${naira(cngCost)}/month\n` +
      `Saving: ${naira(saving)}/month (${naira(saving / days)}/day, ${naira(annual)}/year, ${pct}% cheaper)\n` +
      `Payback: ${payback}${cost > 0 ? ` (conversion cost ${naira(cost)})` : ""}\n` +
      `Prices as reported ${F.PRICES.priceDate}. This is an estimate, not a guarantee — your car and your mileage change it.\n` +
      `Calculated at https://findcng.vercel.app/?view=calculator`;
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
      // A restored vehicle must bring its own km/litre, CNG price and
      // km/SCM with it — otherwise a saved "bus" silently calculated
      // with the car's defaults (pre-existing bug, fixed Phase 3).
      if (p.vehicle && F.VEHICLES[p.vehicle]) calcVehicleChange();
    } catch { /* ignore */ }
  }
  function calcVehicleChange() {
    const v = F.VEHICLES[$("calc-vehicle").value];
    $("calc-kpl").value = v.kmPerLitre;
    $("calc-cng").value = v.cngPrice;
    kmpscmEdited = false;
    $("calc-kmpscm").value = (v.kmPerLitre * F.SCM_PER_LITRE_EQUIV).toFixed(1);
    calc();
  }
  // km/litre changed: the CNG estimate follows it (× 1.1) unless the
  // user has typed their own km/SCM — their own number wins until the
  // vehicle or km/litre changes again.
  function calcKplChange() {
    if (!kmpscmEdited) {
      const kpl = Math.max(1, parseFloat($("calc-kpl").value) || F.VEHICLES.car.kmPerLitre);
      $("calc-kmpscm").value = (kpl * F.SCM_PER_LITRE_EQUIV).toFixed(1);
    }
    calc();
  }

  // ---------------- safety language toggle (EN / Pidgin / Hausa / Yoruba / Igbo) ----------------
  // Phase 4 (§17): Hausa, Yoruba and Igbo join English + Pidgin for the
  // safety hub's core content (lead, causes, myths, checklist + the
  // headings). The translations live in js/safety-i18n.js and were
  // produced in-session — they are AWAITING native-speaker review, so
  // the review banner shows whenever one of those languages is picked,
  // and the translations are never presented as professionally verified.
  // The incidents table stays in English (dates, place names, sources).
  const SAFETY_LANGS = { pcm: "SAFETY_PCM", ha: "SAFETY_HA", yo: "SAFETY_YO", ig: "SAFETY_IG" };
  const SAFETY_HEADINGS = { "safety-title": "title", "safety-h-causes": "causes",
    "safety-h-myths": "myths", "safety-h-checklist": "checklist" };
  function initSafetyLang() {
    ["safety-lead", "safety-causes", "safety-myths", "safety-checklist"].forEach((id) => {
      const el = $(id);
      if (el) safetyEn[id] = el.innerHTML;
    });
    Object.keys(SAFETY_HEADINGS).forEach((id) => {
      const el = $(id);
      if (el) safetyEn[id] = el.textContent;
    });
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.addEventListener("click", () => setSafetyLang(b.dataset.lang)));
  }
  function setSafetyLang(lang) {
    safetyLang = lang;
    document.querySelectorAll("[data-lang]").forEach((b) =>
      b.classList.toggle("on", b.dataset.lang === lang));
    const pack = SAFETY_LANGS[lang] ? F[SAFETY_LANGS[lang]] : null;
    const map = { "safety-lead": "lead", "safety-causes": "causes", "safety-myths": "myths", "safety-checklist": "checklist" };
    Object.entries(map).forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      el.innerHTML = (pack && pack[key]) ? pack[key] : safetyEn[id];
    });
    Object.entries(SAFETY_HEADINGS).forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      el.textContent = (pack && pack.headings && pack.headings[key]) ? pack.headings[key] : safetyEn[id];
    });
    const banner = $("safety-review-note");
    if (banner) {
      const needsReview = lang === "ha" || lang === "yo" || lang === "ig";
      banner.classList.toggle("hidden", !needsReview);
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
    if (view === "coverage" || hash === "coverage") { showView("intelligence"); return; }
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
    // Hero primary actions (Phase 1, §5) — every one does something real.
    $("hero-nearby").addEventListener("click", () => {
      gpsGo();
      const nl = $("nearest-list");
      if (nl) nl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("hero-centres").addEventListener("click", () => showView("centres"));
    $("hero-postcode").addEventListener("click", () => {
      const pi = $("postcode-input");
      pi.scrollIntoView({ behavior: "smooth", block: "center" });
      pi.focus();
    });
    // Postcode explorer (Phase 1).
    $("explorer-go").addEventListener("click", explorerGo);
    $("explorer-input").addEventListener("keydown", (e) => { if (e.key === "Enter") explorerGo(); });
    $("explorer-input").addEventListener("input", explorerSuggest);
    $("explorer-sample").addEventListener("click", () => {
      $("explorer-input").value = SANDBOX_SAMPLE;
      explorerGo();
    });
    refreshExplorerMode();
    // Latest-updates section refreshes whenever the news module renders.
    document.addEventListener("findcng:news", renderHomeNews);
    renderHomeSavings();
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
    ["calc-vehicle", "calc-km", "calc-days", "calc-kpl", "calc-kmpscm", "calc-petrol", "calc-cng", "calc-cost"].forEach((id) => {
      const handler = id === "calc-vehicle" ? calcVehicleChange
        : id === "calc-kpl" ? calcKplChange
        : id === "calc-kmpscm" ? () => { kmpscmEdited = true; calc(); }
        : calc;
      $(id).addEventListener("input", handler);
      $(id).addEventListener("change", handler);
    });
    // Copy / Download read lastCalcSummary — they are static buttons,
    // never re-rendered, so a tap can never be swallowed by a re-render.
    $("calc-copy").addEventListener("click", () => {
      if (!lastCalcSummary) { toast("Enter your numbers first."); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lastCalcSummary).then(() => toast("Summary copied — paste it anywhere.")).catch(() => toast(lastCalcSummary));
      } else { toast(lastCalcSummary); }
    });
    $("calc-download").addEventListener("click", () => {
      if (!lastCalcSummary) { toast("Enter your numbers first."); return; }
      const blob = new Blob([lastCalcSummary], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "findcng-savings-summary.txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Summary downloaded.");
    });
    // Sheets
    $("report-submit").addEventListener("click", submitReport);
    $("listing-submit").addEventListener("click", submitListing);
    document.querySelectorAll('input[name="listing-type"]').forEach((r) =>
      r.addEventListener("change", updateListingDetailsHint));
    $("listing-success-close").addEventListener("click", () => $("listing-backdrop").classList.remove("open"));
    $("listing-ref-copy").addEventListener("click", () => {
      const ref = $("listing-ref").value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ref).then(() => toast("Reference copied.")).catch(() => toast(ref));
      } else { toast(ref); }
    });
    // Submission tracking (Help → Check a report): the last reference
    // sent from this device is filled in automatically.
    const lrCheckBtn = $("lr-check-go");
    if (lrCheckBtn) {
      lrCheckBtn.addEventListener("click", checkListingStatus);
      $("lr-check-input").addEventListener("keydown", (e) => { if (e.key === "Enter") checkListingStatus(); });
      try {
        const last = localStorage.getItem("findcng_last_lr");
        if (last) $("lr-check-input").value = last;
      } catch { /* ignore */ }
    }
    // Operator portal (Phase 4, §15).
    wireOperator();
    $("report-backdrop").addEventListener("click", (e) => { if (e.target === $("report-backdrop")) $("report-backdrop").classList.remove("open"); });
    $("listing-backdrop").addEventListener("click", (e) => { if (e.target === $("listing-backdrop")) $("listing-backdrop").classList.remove("open"); });
    $("report-close").addEventListener("click", () => $("report-backdrop").classList.remove("open"));
    $("listing-close").addEventListener("click", () => $("listing-backdrop").classList.remove("open"));
    // Escape closes either sheet (Phase 1 — keyboard users had no way out
    // except the × button or tapping the backdrop).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $("report-backdrop").classList.remove("open");
        $("listing-backdrop").classList.remove("open");
      }
    });
    // One delegated click handler for every data-attribute action in the
    // app (Phase 4, §19 — CSP): static links in index.html, rendered
    // links in the home/intelligence views, Leaflet popup buttons and
    // detail-page buttons all carry data-* attributes instead of inline
    // onclick handlers, so the Content Security Policy can run without
    // 'unsafe-inline'. showView goes through window.showView so the
    // news module's refresh hook (js/news.js) still fires.
    document.addEventListener("click", (e) => {
      const vl = e.target.closest("[data-view-link]");
      if (vl) {
        e.preventDefault();
        (window.showView || showView)(vl.dataset.viewLink);
        return;
      }
      const ll = e.target.closest("[data-listing-link]");
      if (ll) {
        e.preventDefault();
        const [lid, ltype] = ll.dataset.listingLink.split("|");
        openListing(lid, ltype);
        return;
      }
      const qr = e.target.closest("[data-quick-report]");
      if (qr) {
        const [qid, qstatus] = qr.dataset.quickReport.split("|");
        quickReport(qid, qstatus, qr);
        return;
      }
      const os = e.target.closest("[data-open-station]");
      if (os) {
        e.preventDefault();
        openStation(os.dataset.openStation);
        return;
      }
      const orp = e.target.closest("[data-open-report]");
      if (orp) { openReport(orp.dataset.openReport); return; }
      const bn = e.target.closest("[data-back-normal]");
      if (bn) { backToNormal(bn.dataset.backNormal); return; }
    });
    $("station-back").addEventListener("click", () => showView(prevView || "map"));
    // Defaults
    $("calc-petrol").value = F.PRICES.petrolPerLitre;
    $("calc-cng").value = F.PRICES.cngPerScmCar;
    $("calc-kpl").value = F.VEHICLES.car.kmPerLitre;
    $("calc-kmpscm").value = (F.VEHICLES.car.kmPerLitre * F.SCM_PER_LITRE_EQUIV).toFixed(1);
    loadVehicleProfile();
    $("price-note").textContent = F.PRICES.priceNote + " Prices as of " + F.PRICES.priceDate + ".";
    calc();
    // Offline indicator + auto-sync (Phase 4, §20): the moment the
    // browser reports offline, live availability is withdrawn at once
    // (cached reports must never read as current) and the banner shows;
    // on reconnect the live reports and news refresh automatically.
    // The directory itself keeps working from the service-worker cache.
    function updateOfflineBar() {
      const bar = $("offline-bar");
      if (!bar) return;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      bar.classList.toggle("hidden", !offline);
    }
    window.addEventListener("offline", () => {
      updateOfflineBar();
      reportsLive = false;
      refreshStatuses();
    });
    window.addEventListener("online", () => {
      updateOfflineBar();
      loadReports();
      if (window.FindCNGNews) window.FindCNGNews.refresh();
      toast("Back online — live reports refreshed.");
    });
    updateOfflineBar();
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
