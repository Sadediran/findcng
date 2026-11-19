// GET /api/tiles?provider=osm&z={z}&x={x}&y={y} — same-origin map tile
// proxy. Some Nigerian mobile networks cannot reach the tile CDNs
// directly (19 Nov 2026: on Saheed's 4G, Esri hangs and OSM fails
// outright, while findcng.vercel.app itself loads fine), so when the
// browser's direct tile requests fail, the map retries through here.
// Only OpenStreetMap tiles are proxied: ODbL permits redistribution
// with attribution (shown on the map), and the upstream fetch carries
// a User-Agent identifying this app, as OSM's tile policy requires.
// Esri tiles are NOT proxied (their terms don't allow re-serving).
// Tiles are cached at Vercel's edge for a day, so a tile is fetched
// from upstream at most once per region per day. Strict validation:
// this is not an open proxy — provider, z, x, y are allow-listed and
// range-checked, and the upstream host is fixed.
import { json } from "./_lib.js";

const UPSTREAM = "https://tile.openstreetmap.org";
const UA = "FindCNG-Nigeria/1.0 (https://findcng.vercel.app)";
const CACHE_HDR = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  const { provider, z, x, y } = req.query;
  if (provider !== "osm") {
    return json(res, 400, { ok: false, error: "unknown provider" });
  }
  const zi = Number(z), xi = Number(x), yi = Number(y);
  const valid = Number.isInteger(zi) && Number.isInteger(xi) && Number.isInteger(yi)
    && zi >= 0 && zi <= 19 && xi >= 0 && yi >= 0 && xi < 2 ** zi && yi < 2 ** zi;
  if (!valid) {
    return json(res, 400, { ok: false, error: "bad tile coordinates" });
  }
  const url = `${UPSTREAM}/${zi}/${xi}/${yi}.png`;
  let up;
  try {
    up = await fetch(url, { headers: { "User-Agent": UA, Accept: "image/png" } });
  } catch {
    return json(res, 502, { ok: false, error: "tile upstream unreachable" });
  }
  if (!up.ok) {
    return json(res, up.status === 404 ? 404 : 502, { ok: false, error: "tile not available" });
  }
  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": buf.length,
    "Cache-Control": CACHE_HDR,
  });
  res.end(buf);
}
