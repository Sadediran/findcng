// GET /api/live-centres — the Pi-CNG conversion-centres register, live.
// The app's stored stations.json is a build-time snapshot; this route lets
// the app show centres Pi-CNG has listed SINCE the last daily rebuild, so
// a search captures newly listed centres the same hour instead of the
// next morning (Saheed, 18 Nov 2026: "displaying live instead of stored
// alone"). Display layer only — it never writes to the stored dataset;
// the daily findcng-data-refresh cron remains the system of record
// (it merges, dedupes, geocodes and deploys).
//
// How it reads the register: https://www.pci.gov.ng/conversion-centers.html
// is a public JS page that reads https://pcngi.com.ng/api/v1/conversion-centers
// with header `x-api-key: <CC_KEY>`, where CC_KEY is embedded in the page's
// own public HTML. This route extracts the API base + key FRESH from that
// public page on every uncached call — the key is NEVER hardcoded, NEVER
// stored, NEVER logged. Same rule as fetch-picng-api.py in the data repo.
//
// Response: { ok: true, fetched_at, total, rows: [{id, name, code, state,
// lga, address, status, createdAt, updatedAt}] }. Rows are TRIMMED:
// coordinates are deliberately dropped — the API's are unusable (249 are
// (0,0) placeholders, 236 exactly 2 decimals, 5 outside Nigeria), so live
// centres are list-only until the daily pipeline verifies a pin.
// Cache: the edge caches a good response for 1 hour (s-maxage=3600), so
// the app gets at most hour-old data without hammering Pi-CNG's page.
// On any failure the route 502s and the app falls back to the stored
// list silently — a live outage must never break the directory.
import { json } from "./_lib.js";

const CONV_PAGE = "https://www.pci.gov.ng/conversion-centers.html";
const UA = "FindCNG-Nigeria/2.5 (NYSC CDS project; https://findcng.vercel.app) live-centres/1.0";
const PAGE_LIMIT = 50; // the register page itself uses limit=50; limit < 10 -> 422
const FETCH_TIMEOUT_MS = 10000;

function extractJsConst(html, name) {
  const m = html.match(
    new RegExp(`(?:var|const|let)\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`)
  );
  return m ? m[1] : null;
}

async function fetchText(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...(headers || {}) }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchPage(apiBase, apiKey, page) {
  const body = await fetchText(`${apiBase}?limit=${PAGE_LIMIT}&page=${page}`, { "x-api-key": apiKey });
  const payload = JSON.parse(body);
  const data = Array.isArray(payload) ? payload : payload.data;
  const meta = (!Array.isArray(payload) && payload.meta) || {};
  if (!Array.isArray(data)) throw new Error(`page ${page}: no data list`);
  return { data, meta };
}

function trimRow(r) {
  return {
    id: r.id ?? null,
    name: r.name ?? null,
    code: r.code ?? null,
    state: r.state ?? null,
    lga: r.lga ?? null,
    address: r.address ?? null,
    status: r.status ?? null, // true = Active, false = Registered, not yet Active
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  try {
    const html = await fetchText(CONV_PAGE);
    const apiBase = extractJsConst(html, "CC_API");
    const apiKey = extractJsConst(html, "CC_KEY");
    if (!apiBase || !apiKey) {
      throw new Error("register page layout changed (CC_API/CC_KEY not found)");
    }
    const first = await fetchPage(apiBase, apiKey, 1);
    const lastPage = first.meta.lastPage || first.meta.last_page || 1;
    const total = first.meta.total || null;
    const rest = lastPage > 1
      ? await Promise.all(
          Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(apiBase, apiKey, i + 2))
        )
      : [];
    const rows = [...first.data, ...rest.flatMap((p) => p.data)].map(trimRow);
    if (!rows.length) throw new Error("register returned 0 rows");
    return json(res, 200, {
      ok: true,
      fetched_at: new Date().toISOString(),
      total: total ?? rows.length,
      rows,
    }, "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400");
  } catch (e) {
    // Never leak the key or the upstream body; the app falls back to the
    // stored list on any failure.
    console.error("live-centres failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 502, { ok: false, error: "Pi-CNG register could not be reached" });
  }
}
