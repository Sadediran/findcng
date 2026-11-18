/* FindCNG Nigeria — live News feed (2.2).
   Self-initializing: renders the saved seed items immediately, then
   fetches /api/news and replaces them with the live feed. If the fetch
   fails (offline, or the API is down), the saved items stay on screen
   with a small note saying so. No news is ever invented here — the
   seed below is the 9 items that used to be hardcoded in index.html
   (same titles, summaries, sources, dates), kept in data/news-seed.json
   as the single source of truth; keep both in sync when editing.
   Loaded after js/app.js so window.showView exists to hook. */
(function () {
  "use strict";

  // Offline fallback: the 9 saved items, newest first.
  var SEED_NEWS = [
    { title: "Pi-CNG chairman admits high costs, few stations are slowing adoption",
      summary: "Pi-CNG & EV Executive Chairman Ismaeel Ahmed admitted that high conversion costs and inadequate refuelling stations are slowing CNG adoption — the same two complaints drivers raise most.",
      source_name: "Punch", source_url: "https://punchng.com/high-conversion-costs-inadequate-stations-slowing-cng-adoption-fg/?amp",
      published_at: "2026-11-16T19:40:41Z", topic: "adoption" },
    { title: "Bus gas explosion on Lagos–Ibadan Expressway; LASTMA urges inspections",
      summary: "A Toyota Hiace bus (EKY 798 YK) with 18 occupants suffered a gas explosion at Berger. 17 people were rescued unhurt; one male passenger suffered severe burns. The exact technical cause was under investigation at the time of reporting. LASTMA General Manager Olalekan Bakare-Oki urged CNG operators to prioritise regular professional inspections of gas storage and delivery systems.",
      source_name: "New Daily Prime; LASTMA", source_url: "https://newdailyprime.news/cng-bus-explosion-lagos-ibadan-expressway/",
      published_at: "2026-11-11", topic: "safety" },
    { title: "127 more refuelling stations reported in development",
      summary: "127 additional CNG refuelling stations are reported in development across the country, on top of the 105 on the October register — part of the programme's push to cut the queues drivers face daily.",
      source_name: "Daily Nigerian / NAN", source_url: "https://dailynigerian.com/nigerian-govt-establish-cng/",
      published_at: "2026-11-04T14:38:58Z", topic: "infrastructure" },
    { title: "National CNG Summit held in Abuja",
      summary: "The National CNG Summit brought the programme, operators and regulators together in Abuja, chaired by Pi-CNG & EV Executive Chairman Ismaeel Ahmed, as converted vehicles passed 120,000.",
      source_name: "ThisDay", source_url: "https://www.thisdaylive.com/2026/11/04/nigeria-plans-1000-new-cng-stations-to-drive-gas-adoption-cut-transport-costs/",
      published_at: "2026-11-04", topic: "policy" },
    { title: "Fare-cut directive not implemented in 14 states, including Edo",
      summary: "President Tinubu's 19 September directive — that CNG savings should reach passengers as lower fares by 1 October — was not implemented in Enugu, Anambra, Delta, Imo, Sokoto, Kebbi, Jigawa, Gombe, Edo, Plateau, Ondo, Osun, Oyo and Ogun, Punch found. Drivers say they keep fares high to recover conversion costs and lost queue hours.",
      source_name: "Punch, via KOIKIMEDIA", source_url: "https://koikimediainternationalnews.com/states-yet-to-implement-tinubus-cng-fare-reduction-directive/",
      published_at: "2026-10-02", topic: "policy" },
    { title: "Pi-CNG register lists 105 refuelling stations in 24 states + FCT",
      summary: "The updated Pi-CNG refuelling stations register lists 105 operational stations across 24 states and the FCT — against roughly 120,000–140,000 converted vehicles, about 1,300 vehicles per station.",
      source_name: "Pi-CNG refuelling stations register", source_url: "https://www.pci.gov.ng/refuelling-stations.html",
      published_at: "2026-10-15", topic: "infrastructure" },
    { title: "120,000+ CNG vehicles, 400+ conversion centres, 96 stations",
      summary: "A Federal Ministry of Finance briefing cited 120,000+ CNG vehicles, 400+ conversion centres, 96 refuelling stations, 550+ CNG buses, 30–50% lower fares where CNG operates, and ₦100bn+ in duty waivers.",
      source_name: "Federal Ministry of Finance briefing", source_url: "https://www.facebook.com/Finminnigeria/posts/pfbid0tdQgMFGwNr3Rnk2nQgktkdADABm7UBMS1AaiyeMLRPRJLHv46VKeAYAYQXD1CFXxl",
      published_at: "2026-10-08", topic: "programme" },
    { title: "Diverse Autocare CNG hub commissioned in Benin City",
      summary: "The Minister of State for Petroleum Resources (Gas), Ekperikpe Ekpo, commissioned the Diverse Autocare CNG hub on Sapele Road, Benin City — Edo's first CNG refuelling station and conversion centre.",
      source_name: "Punch", source_url: "https://punchng.com/fg-promotes-cng-adoption-with-edo-conversion-centre/",
      published_at: "2026-05-26T23:02:32Z", topic: "infrastructure" },
    { title: "CNG price rises to ₦380/SCM as subsidy support is withdrawn",
      summary: "The CNG price rose from ₦230 to ₦380 per SCM for cars and buses (₦450 for trucks) after the Federal Government withdrew subsidy support in September 2025. At ₦380, CNG remains roughly 70–75% cheaper than petrol at ₦1,330–₦1,405 per litre — but drivers fear further rises.",
      source_name: "Punch; Pulse", source_url: "https://www.pulse.ng/story/cng-price-hike-nigeria-subsidy-withdrawal-queues-2025090306014084467",
      published_at: "2025-09-03", topic: "prices" }
  ];

  var PAGE_SIZE = 20;
  var REFRESH_MS = 5 * 60 * 1000; // re-check while the News view is open
  // source: null (not checked yet) | "live" | "seed-nolive" (API answered
  // but the table is not set up yet) | "seed-offline" (fetch failed).
  var state = { items: [], total: 0, source: null, loadingMore: false, fetchedAt: null };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Only http(s) links are rendered as links — anything else is dropped.
  function safeUrl(u) {
    try {
      var parsed = new URL(String(u || ""), location.origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : null;
    } catch (e) { return null; }
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function fmtRelative(iso) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    if (!t) return "";
    var diff = Date.now() - t;
    if (diff < 0) return "just now";
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    if (days < 7) return days + (days === 1 ? " day ago" : " days ago");
    return fmtDate(iso);
  }

  function sortNewestFirst(items) {
    return items.slice().sort(function (a, b) {
      return (Date.parse(b.published_at || "") || 0) - (Date.parse(a.published_at || "") || 0);
    });
  }

  function cardHtml(it) {
    var date = fmtDate(it.published_at);
    var meta = [date ? "<b>" + esc(date) + "</b>" : "", it.source_name ? esc(it.source_name) : ""]
      .filter(Boolean).join(" · ");
    var url = safeUrl(it.source_url);
    var link = url
      ? '<p class="news-source-link"><a href="' + esc(url) + '" target="_blank" rel="noopener">Read the original ↗</a></p>'
      : "";
    return '<div class="card">'
      + (meta ? '<p class="meta">' + meta + "</p>" : "")
      + "<h3>" + esc(it.title || "Untitled") + "</h3>"
      + (it.summary ? "<p style=\"margin:0\">" + esc(it.summary) + "</p>" : "")
      + link + "</div>";
  }

  function renderStatus() {
    var el = $("news-updated");
    if (!el) return;
    if (state.source === "live" && state.fetchedAt) {
      el.textContent = "Updated " + fmtRelative(state.fetchedAt) + " · Live feed";
      el.classList.remove("news-offline");
    } else if (state.source === "live") {
      el.textContent = "Live feed";
      el.classList.remove("news-offline");
    } else if (state.source === "seed-nolive") {
      el.textContent = "Showing saved news — live updates aren't available yet.";
      el.classList.add("news-offline");
    } else if (state.source === "seed-offline") {
      el.textContent = "Showing saved news — couldn't reach the live feed.";
      el.classList.add("news-offline");
    } else {
      el.textContent = ""; // not checked yet: say nothing until we know
      el.classList.remove("news-offline");
    }
    var more = $("news-more");
    if (more) more.hidden = !(state.total > state.items.length);
  }

  function renderList() {
    var list = $("news-list");
    if (!list) return;
    if (!state.items.length) {
      list.innerHTML = '<div class="card"><p style="margin:0">No news yet — check back soon.</p></div>';
    } else {
      list.innerHTML = state.items.map(cardHtml).join("");
    }
    renderStatus();
  }

  function renderSeed() {
    state.items = sortNewestFirst(SEED_NEWS);
    state.total = state.items.length;
    state.source = null; // status line stays empty until the first check
    state.fetchedAt = null;
    renderList();
  }

  function loadMore() {
    if (state.loadingMore || state.total <= state.items.length) return;
    state.loadingMore = true;
    var btn = $("news-more");
    if (btn) btn.disabled = true;
    fetch("/api/news?limit=" + PAGE_SIZE + "&offset=" + state.items.length, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok && Array.isArray(data.items)) {
          state.items = state.items.concat(data.items);
          state.total = typeof data.total === "number" ? data.total : state.items.length;
          renderList();
        }
      })
      .catch(function () { /* keep what is on screen */ })
      .finally(function () {
        state.loadingMore = false;
        if (btn) btn.disabled = false;
      });
  }

  function refresh() {
    return fetch("/api/news?limit=" + PAGE_SIZE, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.items) || !data.items.length) {
          state.source = "seed-offline";
          renderStatus();
          return;
        }
        state.items = sortNewestFirst(data.items);
        state.total = typeof data.total === "number" ? data.total : state.items.length;
        // The API answers source "static-fallback" until sql/002 is run;
        // those items are the same saved seed, so note that the live
        // feed is not switched on yet rather than claiming a failure.
        state.source = data.source === "live" ? "live" : "seed-nolive";
        var newest = state.items.reduce(function (best, it) {
          var t = Date.parse(it.fetched_at || "") || 0;
          return t > best ? t : best;
        }, 0);
        state.fetchedAt = newest ? new Date(newest).toISOString() : null;
        renderList();
      })
      .catch(function () {
        // Offline or API down: the saved items stay on screen with the note.
        state.source = "seed-offline";
        renderStatus();
      });
  }

  function init() {
    if (!$("news-list")) return; // not on a page with the News view
    renderSeed(); // instant paint from the saved items
    refresh();    // then replace with the live feed when it answers
    var more = $("news-more");
    if (more) more.addEventListener("click", loadMore);
    // Refresh each time the News view is opened, and every 5 minutes
    // while it stays open.
    if (typeof window.showView === "function" && !window.showView.__newsHooked) {
      var origShowView = window.showView;
      var wrapped = function (name) {
        origShowView(name);
        if (name === "news") refresh();
      };
      wrapped.__newsHooked = true;
      window.showView = wrapped;
    }
    setInterval(function () {
      var view = $("view-news");
      if (view && view.classList.contains("active")) refresh();
    }, REFRESH_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for debugging and for verify checks: window.FindCNGNews.refresh()
  window.FindCNGNews = { refresh: refresh, seedCount: SEED_NEWS.length };
})();
