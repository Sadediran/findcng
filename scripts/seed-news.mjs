// FindCNG Nigeria — one-time seed for the news_items table (2.2).
// Run AFTER sql/002_news_items.sql has been run in the Supabase SQL editor:
//   node scripts/seed-news.mjs            (inserts the missing seed items)
//   node scripts/seed-news.mjs --dry-run  (prints what WOULD be inserted)
//
// Idempotent: it GETs the source_urls already in news_items and inserts
// only the seed items whose URL is not there yet, so re-running it is safe.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local in the
// repo root. NEVER prints any secret value — only counts, titles and URLs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    env[k.trim()] = rest.join("=").trim();
  }
  return env;
}

const env = loadEnv();
const SB_URL = (env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SB_URL || !SB_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local — aborting.");
  process.exit(1);
}

const HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

const seed = JSON.parse(readFileSync(join(ROOT, "data", "news-seed.json"), "utf8"));
const seen = new Set();
const items = [];
for (const it of seed) {
  if (!it.source_url || seen.has(it.source_url)) continue; // skip dupes inside the file
  seen.add(it.source_url);
  items.push({
    title: it.title,
    summary: it.summary || null,
    source_name: it.source_name || null,
    source_url: it.source_url,
    published_at: it.published_at || null,
    topic: it.topic || null,
  });
}

const existingRes = await fetch(`${SB_URL}/rest/v1/news_items?select=source_url`, { headers: HEADERS });
if (!existingRes.ok) {
  const body = await existingRes.text().catch(() => "");
  if (existingRes.status === 404 || body.includes("PGRST205") || body.includes("Could not find the table")) {
    console.error("news_items table does not exist yet — run sql/002_news_items.sql in the Supabase SQL editor first, then re-run this script.");
  } else {
    console.error(`Could not read news_items (HTTP ${existingRes.status}). Not inserting anything.`);
  }
  process.exit(1);
}
const existing = new Set((await existingRes.json()).map((r) => r.source_url));
const missing = items.filter((it) => !existing.has(it.source_url));

console.log(`Seed file: ${items.length} items. Already in news_items: ${items.length - missing.length}. Missing: ${missing.length}.`);
if (missing.length === 0) {
  console.log("Nothing to insert — the table already has every seed item.");
  process.exit(0);
}
for (const it of missing) console.log(`  ${DRY_RUN ? "would insert" : "inserting"}: ${it.title} — ${it.source_url}`);
if (DRY_RUN) process.exit(0);

const insertRes = await fetch(`${SB_URL}/rest/v1/news_items`, {
  method: "POST",
  headers: { ...HEADERS, Prefer: "return=minimal" },
  body: JSON.stringify(missing),
});
if (!insertRes.ok) {
  console.error(`Insert failed (HTTP ${insertRes.status}). Nothing was assumed inserted — re-run this script to retry.`);
  process.exit(1);
}
console.log(`Inserted ${missing.length} item(s). Verify: SELECT count(*) FROM news_items; should now include the seed.`);
