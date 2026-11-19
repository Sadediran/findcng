/* FindCNG Nigeria — live News feed (2.2).
   Self-initializing: renders the saved seed items immediately, then
   fetches /api/news and replaces them with the live feed. If the fetch
   fails (offline, or the API is down), the saved items stay on screen
   with a small note saying so. No news is ever invented here — the
   seed is data/news-seed.json, the single source of truth (Phase 4:
   the 9 items used to be duplicated inline here and in the JSON, which
   could drift; now this module loads the JSON file, which the service
   worker caches for offline use). Loaded after js/app.js so
   window.showView exists to hook. */
(function () {
  "use strict";

  // Offline fallback: the saved items from data/news-seed.json, loaded
  // once at init (the service worker caches the file, so this works
  // offline after the first visit). Empty until loaded.
  var seedItems = [];
  function loadSeedFile() {
    return fetch("data/news-seed.json")
      .then(function (r) { return r.json(); })
      .then(function (parsed) {
        var items = Array.isArray(parsed) ? parsed : parsed.items || [];
        seedItems = items;
      })
      .catch(function () { /* no seed: the live feed is still tried */ });
  }

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
    // Phase 1: the homepage "Latest CNG updates" section listens for this.
    if (typeof document !== "undefined" && document.dispatchEvent) {
      document.dispatchEvent(new CustomEvent("findcng:news"));
    }
  }

  function renderSeed() {
    state.items = sortNewestFirst(seedItems);
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
    // Seed first (instant paint from the saved items, cached offline),
    // then replace with the live feed when it answers.
    loadSeedFile().then(function () {
      renderSeed();
      refresh();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for debugging and for verify checks: window.FindCNGNews.refresh()
  // Phase 1: the homepage reads the feed through getItems() (live items
  // when loaded) and getSeed() (the saved items, for offline/fallback).
  window.FindCNGNews = {
    refresh: refresh,
    seedCount: function () { return seedItems.length; },
    getItems: function () { return state.items.slice(); },
    getSeed: function () { return sortNewestFirst(seedItems); },
  };
})();
