// POST /api/postcode — server-side proxy to the official NIPOST Postcode API.
// Keeps the API key off the browser.
//
// Body: { action: "status" }                -> { configured, mode } (no NIPOST call)
//       { action: "lookup", code, level? }  -> validity (+ address on sandbox keys)
//       { action: "search", q }             -> autocomplete suggestions
//       { action: "nearby", lat, lng }      -> postcodes near a point
//       { action: "reverse", lat, lng }     -> postcode at a point
//       { action: "states" }                -> the 37 state codes/names
//       { action: "lgas", state }           -> LGA codes/names in a state
//       { action: "districts", state, lga } -> district codes in a state+LGA
//       { action: "areas", state, lga, district } -> area codes below a district
//
// Every response carries `mode`: "sandbox" (nipost_test_), "live"
// (nipost_live_) or "unknown" — the key itself is never exposed. The UI
// labels sandbox results as sandbox results; nothing here claims a live
// validation unless the key is a live one.
//
// LEVELS — READ CAREFULLY (19 Nov 2026): the gateway still implements the
// level parameter (verified live: level=1 answers, level=2 on our key
// returns 403 level_not_granted), but the official docs updated 19 Nov
// 2026 no longer document any L1–L5 system — they say "Lookup and
// Autocomplete consume credits" with no free tier stated for live keys,
// and "Test calls never consume credits" for test keys. So: on a LIVE key
// this proxy requests level 1 only (the cheapest possible lookup), but
// even L1 may consume credits under the current docs — the cost is
// UNCONFIRMED and NIPOST has published no credit pricing. On a TEST key
// the proxy allows level 2 (administrative address — the autofill demo)
// because test calls are unmetered; our current test key is in fact
// granted L1 only, so L2 answers not_granted and the client falls back
// to L1. L5 (coordinates) is never requested: publishable keys are
// capped below it, it needs special approval, and this app gets
// coordinates from GPS / a map tap instead.
//
// Without NIPOST_API_KEY the route answers { configured: false } and the
// app falls back to its local 6-digit table + GPS + map tap.
// NIPOST_API_BASE may point at the unofficial mock (https://ng-postcode.oliha.dev)
// for testing — default is the official https://api.postcode.gov.ng.
// Paths verified against the official docs (docs.postcode.gov.ng,
// updated 19 Nov 2026) and re-probed live the same day. NOTE: /v1/search
// /nearby and /reverse have NO docs pages (verified live only); the
// reference endpoints below are documented and free (no credits).
//
// Sandbox reality (verified live 19 Nov 2026): the sandbox dataset holds
// only NIPOST's published sandbox codes (e.g. FC-01-A01-KP-27 -> valid).
// The docs' format example FC 02 A09 DB 09 is NOT in the sandbox dataset
// and correctly returns valid:false — that is NIPOST's data, not a bug in
// this proxy. Real building codes only resolve under a live key.
//
// Terms compliance (postcode.gov.ng/terms, /acceptable-use, read 19 Nov
// 2026): this proxy looks up only codes the user typed, stores no NDAPS
// data anywhere (results are transient in the page; nothing is cached or
// written to any database), never claims a postcode verifies identity or
// ownership, and uses no NIPOST branding.
import { json, rateLimit } from "./_lib.js";

const BASE = (process.env.NIPOST_API_BASE || "https://api.postcode.gov.ng").replace(/\/$/, "");
const KEY = (process.env.NIPOST_API_KEY || "").trim();
const MODE = KEY.startsWith("nipost_live_") ? "live"
  : KEY.startsWith("nipost_test_") ? "sandbox" : "unknown";

// Max lookup level this key may request. Live keys stay at L1 (the
// cheapest lookup the gateway offers — though the current docs state
// Lookup consumes credits, so even L1's cost on a live key is
// unconfirmed); sandbox keys are unmetered, so L2 (administrative
// address — the autofill demo) is allowed there. L5 (coordinates) is
// never requested. The gateway, not this proxy, has the final say: our
// current test key is granted L1 only and answers L2 with not_granted.
const MAX_LEVEL = MODE === "sandbox" ? 2 : 1;

async function nipost(path) {
  let r;
  try {
    r = await fetch(`${BASE}${path}`, {
      headers: { "X-API-Key": KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    // AbortSignal.timeout throws a TimeoutError (a DOMException named
    // "TimeoutError"); anything else here is a network failure.
    const err = new Error(e && e.name === "TimeoutError" ? "timeout" : "network_error");
    err.upstream = true;
    throw err;
  }
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) {
    // Map NIPOST's own error codes to stable codes the UI can explain.
    // Known codes (docs + mock): invalid_api_key, auth_required,
    // insufficient_credits, level_not_granted, rate_limited.
    const upstream = body?.error?.code || body?.code || "";
    let code = `nipost_${r.status}`;
    if (r.status === 401) code = "invalid_key";
    else if (r.status === 402 || upstream === "insufficient_credits") code = "insufficient_credits";
    else if (r.status === 403 || upstream === "level_not_granted") code = "not_granted";
    else if (r.status === 429 || upstream === "rate_limited") code = "rate_limited";
    else if (r.status >= 500) code = "nipost_unavailable";
    else if (r.status === 400) code = "bad_request";
    const err = new Error(code);
    err.upstream = true;
    throw err;
  }
  return body?.data ?? body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  // 30 lookups/min/IP/instance — stops casual abuse of a key that is
  // billed (live) or rate-limited (sandbox) upstream. Failures stay
  // HTTP 200 with an error code so the app degrades gracefully.
  if (!rateLimit(req, "postcode")) {
    return json(res, 200, { configured: Boolean(KEY), mode: MODE, result: null, error: "rate_limited" });
  }
  if (!KEY) {
    return json(res, 200, { configured: false, mode: "none", result: null });
  }
  try {
    const body = req.body || {};
    const action = String(body.action || "");
    let result = null;
    if (action === "status") {
      // No NIPOST call — just reports how this proxy is configured so
      // the UI can label sandbox vs live honestly.
      return json(res, 200, { configured: true, mode: MODE, maxLevel: MAX_LEVEL, result: null });
    } else if (action === "lookup") {
      const code = String(body.code || "").trim();
      if (!code) return json(res, 400, { ok: false, error: "code is required" });
      if (code.length > 64) return json(res, 400, { ok: false, error: "code is too long" });
      const want = Number(body.level) || 1;
      const level = Math.max(1, Math.min(want, MAX_LEVEL));
      const d = await nipost(`/v1/lookup?code=${encodeURIComponent(code)}&level=${level}`);
      const admin = d?.administrative_address || null;
      const house = d?.recent_house_address || null;
      result = {
        valid: d?.valid === true,
        status: typeof d?.status === "string" ? d.status : null,
        postcode: d?.postcode || code,
        level,
        mode: MODE,
        // L2+ fields — present only when the API returned them (sandbox
        // L2, or a live key granted L2 — which this proxy never asks for).
        state: admin?.state_name || null,
        lga: admin?.lga_name || null,
        locality: admin?.locality_name || null,
        zone: admin?.zone || null,
        houseAddress: (typeof house?.recent === "string" && house.recent) ? house.recent : null,
        buildingUse: typeof d?.building_use_status === "string" ? d.building_use_status : null,
      };
    } else if (action === "search") {
      const q = String(body.q || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "q is required" });
      if (q.length > 100) return json(res, 400, { ok: false, error: "q is too long" });
      result = await nipost(`/v1/search/autocomplete?q=${encodeURIComponent(q)}`);
    } else if (action === "nearby" || action === "reverse") {
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return json(res, 400, { ok: false, error: "valid lat/lng are required" });
      }
      result = await nipost(action === "nearby"
        ? `/v1/search/nearby?lat=${lat}&lng=${lng}`
        : `/v1/search/reverse?lat=${lat}&lng=${lng}`);
    } else if (action === "states") {
      result = await nipost("/v1/reference/states");
    } else if (action === "lgas" || action === "districts" || action === "areas") {
      // Free reference endpoints (docs: "free, no credits consumed").
      // Used to NAME the LGA segment of a code the user typed, and to
      // confirm the district/area codes exist under that state+LGA.
      // Districts and areas have no human names — code only.
      const state = String(body.state || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) return json(res, 400, { ok: false, error: "state is required (2 letters)" });
      if (action === "lgas") {
        result = await nipost(`/v1/reference/lgas?state=${state}`);
      } else {
        const lga = String(body.lga || "").trim();
        if (!/^\d{2}$/.test(lga)) return json(res, 400, { ok: false, error: "lga is required (2 digits)" });
        if (action === "districts") {
          result = await nipost(`/v1/reference/districts?state=${state}&lga=${lga}`);
        } else {
          const district = String(body.district || "").trim().toUpperCase();
          if (!/^[A-Z0-9]{3}$/.test(district)) return json(res, 400, { ok: false, error: "district is required (3 characters)" });
          result = await nipost(`/v1/reference/areas?state=${state}&lga=${lga}&district=${district}`);
        }
      }
    } else {
      return json(res, 400, { ok: false, error: "unknown action" });
    }
    return json(res, 200, { configured: true, mode: MODE, result });
  } catch (e) {
    // The NIPOST API is 7 weeks old; never let it break the app. Upstream
    // failures keep their stable code (timeout, invalid_key,
    // rate_limited, nipost_unavailable…); anything else is a server bug
    // and is reported generically, with the detail in the server log.
    if (e && e.upstream) {
      return json(res, 200, { configured: true, mode: MODE, result: null, error: String(e.message).slice(0, 40) });
    }
    console.error("postcode proxy error:", String((e && e.message) || e).slice(0, 200));
    return json(res, 200, { configured: true, mode: MODE, result: null, error: "proxy_error" });
  }
}
