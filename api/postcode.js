// POST /api/postcode — server-side proxy to the official NIPOST Postcode API.
// Keeps the API key off the browser. Free tier only (V1 never needs L2+
// credits or L5 coordinates — coordinates come from GPS/map, never the API).
//
// Body: { action: "lookup", code }          -> L1 validity (+ LGA if the API returns it)
//       { action: "search", q }             -> autocomplete suggestions
//       { action: "nearby", lat, lng }      -> postcodes near a point
//       { action: "reverse", lat, lng }     -> postcode at a point
//       { action: "states" }                -> the 37 state codes/names
//
// Without NIPOST_API_KEY the route answers { configured: false } and the app
// falls back to its local 6-digit table + GPS + map tap.
// NIPOST_API_BASE may point at the unofficial mock (https://ng-postcode.oliha.dev)
// for testing — default is the official https://api.postcode.gov.ng.
// Paths verified against the API's public OpenAPI spec (Nov 2026).
import { json } from "./_lib.js";

const BASE = (process.env.NIPOST_API_BASE || "https://api.postcode.gov.ng").replace(/\/$/, "");
const KEY = process.env.NIPOST_API_KEY || "";

async function nipost(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-API-Key": KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) {
    const code = body?.error?.code || `nipost_${r.status}`;
    throw new Error(code);
  }
  return body?.data ?? body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!KEY) {
    return json(res, 200, { configured: false, result: null });
  }
  try {
    const body = req.body || {};
    const action = String(body.action || "");
    let result = null;
    if (action === "lookup") {
      const code = String(body.code || "").trim();
      if (!code) return json(res, 400, { ok: false, error: "code is required" });
      const d = await nipost(`/v1/lookup?code=${encodeURIComponent(code)}&level=1`);
      result = {
        valid: d?.valid === true,
        postcode: d?.postcode || code,
        lga: d?.administrative_address?.lga_name || null,
        state: d?.administrative_address?.state_name || null,
      };
    } else if (action === "search") {
      const q = String(body.q || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "q is required" });
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
    } else {
      return json(res, 400, { ok: false, error: "unknown action" });
    }
    return json(res, 200, { configured: true, result });
  } catch (e) {
    // The NIPOST API is 7 weeks old; never let it break the app.
    return json(res, 200, { configured: true, result: null, error: String(e.message || e).slice(0, 120) });
  }
}
