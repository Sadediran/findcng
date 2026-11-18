// GET /api/news — live Nigerian CNG news, newest first.
// Reads the news_items table via Supabase REST. Paginated:
//   ?limit  (default 20, max 50), ?offset (default 0).
// Response: { ok: true, items: [...], total, source: "live" }.
// If the table does not exist yet (sql/002 not run) or Supabase is
// unreachable, the route falls back to the static seed file
// (data/news-seed.json) and answers source: "static-fallback" —
// it never crashes and never 500s. The seed file is read through
// `new URL(..., import.meta.url)` so Vercel's file tracing bundles
// it into the function.
import { readFileSync } from "node:fs";
import { json, sb, supabaseConfigured, isMissingTableError } from "./_lib.js";

const SEED_URL = new URL("../data/news-seed.json", import.meta.url);

function loadSeed() {
  try {
    const parsed = JSON.parse(readFileSync(SEED_URL, "utf8"));
    const items = Array.isArray(parsed) ? parsed : parsed.items || [];
    return items.map((it) => ({
      id: it.id || null,
      title: it.title,
      summary: it.summary || null,
      source_name: it.source_name || null,
      source_url: it.source_url,
      published_at: it.published_at || null,
      fetched_at: it.fetched_at || null,
      topic: it.topic || null,
    }));
  } catch {
    return [];
  }
}

function sortNewestFirst(items) {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.published_at || "") || 0;
    const tb = Date.parse(b.published_at || "") || 0;
    return tb - ta;
  });
}

function staticFallback(res, limit, offset) {
  const seed = sortNewestFirst(loadSeed());
  return json(res, 200, {
    ok: true,
    items: seed.slice(offset, offset + limit),
    total: seed.length,
    source: "static-fallback",
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  if (!supabaseConfigured) return staticFallback(res, limit, offset);

  try {
    const rows = await sb(
      `news_items?select=id,title,summary,source_name,source_url,published_at,fetched_at,topic` +
      `&order=published_at.desc.nullslast&limit=${limit}&offset=${offset}`
    );
    // Exact total: the table is capped at 100 rows (see
    // docs/cron-news-refresh.md), so counting ids is cheap.
    let total = (rows || []).length + offset;
    try {
      const ids = await sb("news_items?select=id");
      if (Array.isArray(ids)) total = ids.length;
    } catch { /* keep the best-effort total */ }
    return json(res, 200, { ok: true, items: rows || [], total, source: "live" });
  } catch (e) {
    // Missing table (sql/002 not run yet), Supabase unreachable, or any
    // other read failure: serve the saved seed, never a 500. Only log
    // when the cause is NOT the expected missing-table case, so the
    // logs stay quiet until sql/002 is run.
    if (!isMissingTableError(e)) {
      console.warn("[news] live feed failed, serving seed:", String(e.message || e).slice(0, 120));
    }
    return staticFallback(res, limit, offset);
  }
}
