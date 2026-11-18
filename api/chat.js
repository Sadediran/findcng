// POST /api/chat — "Ask about CNG" AI answers.
// Body: { question } (max 500 chars).
//
// Answers come from Google's Gemini API (free tier, no card, no spend),
// grounded in three live sources assembled server-side before the call:
//   1. data/chat-knowledge.json — the verified FindCNG knowledge base
//      (safety facts, dated prices, programme facts, how FindCNG works).
//   2. Recent news headlines from the news_items table (best effort — the
//      table may not exist yet; skipped silently if it does not).
//   3. For availability questions: fresh availability_reports (last 2 hours
//      only). The LLM is told explicitly when NO recent report exists —
//      it must never invent live availability.
// Plus a best-effort DuckDuckGo web search (no key). On ANY search failure
// the answer proceeds without it and search_available:false is returned.
//
// Env: GEMINI_API_KEY (free Google AI Studio key). Without it the route
// answers { configured: false } and the app shows "being set up" —
// graceful, never an error. NO chat logs are stored — no DB writes at all.
import { json, sb, supabaseConfigured, rateLimit, isMissingTableError } from "./_lib.js";
import { readFileSync } from "node:fs";

// Single named constant — change the model here and nowhere else.
// 18 Nov 2026: gemini-2.5-flash is retired for new API users (Gemini 404);
// Google's own error message directs new users to gemini-3.8-flash.
const MODEL = "gemini-3.8-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const MAX_QUESTION = 500;
const MAX_OUTPUT_TOKENS = 400;
const REPORT_TTL_MS = 2 * 60 * 60 * 1000; // same 2-hour window as the app
const SEARCH_TIMEOUT_MS = 5000;
// 18 Nov 2026: gemini-3.8-flash is slower than 2.5-flash was — the first
// live call exceeded the old 25s limit, so the timeout is 45s (the
// function itself is capped at 60s in vercel.json).
const GEMINI_TIMEOUT_MS = 45000;

// --- Knowledge base + station names (loaded once per instance) ----------
let knowledgeText = null; // null = not tried yet; "" = failed to load
function loadKnowledge() {
  if (knowledgeText !== null) return knowledgeText;
  try {
    const kb = JSON.parse(readFileSync(new URL("../data/chat-knowledge.json", import.meta.url), "utf8"));
    knowledgeText = (kb.facts || [])
      .map((f) => `[${f.topic} | ${f.source} | as of ${f.as_of}] ${f.text}`)
      .join("\n\n");
  } catch {
    knowledgeText = "";
  }
  return knowledgeText;
}

let stationNames = null; // Map station_id -> "Name, City (State)"
function loadStationNames() {
  if (stationNames !== null) return stationNames;
  stationNames = new Map();
  try {
    const list = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
    for (const s of list) {
      stationNames.set(s.id, `${s.name || s.id}${s.city ? ", " + s.city : ""}${s.state ? " (" + s.state + ")" : ""}`);
    }
  } catch { /* name lookup is a nicety; station ids still work without it */ }
  return stationNames;
}

// --- DuckDuckGo web search (no key, best effort) --------------------------
// lite.duckduckgo.com returns simple HTML: <a class="result-link" href="...">
// + <td class="result-snippet">. Tiny regex parser; any failure -> [].
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function ddgLink(href) {
  // DuckDuckGo sometimes wraps links as /l/?uddg=<encoded target>.
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    const out = target ? decodeURIComponent(target) : href;
    return /^https?:\/\//i.test(out) ? out : null;
  } catch { return null; }
}
async function webSearch(query) {
  try {
    const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FindCNG/2.2)" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 5) {
      const url = ddgLink(m[1]);
      const title = stripTags(m[2]);
      if (url && title) out.push({ title, url, snippet: "" });
    }
    // Attach the snippet that follows each link, when present.
    const snip = /<td class="result-snippet">([\s\S]*?)<\/td>/gi;
    let i = 0;
    while ((m = snip.exec(html)) && i < out.length) {
      out[i].snippet = stripTags(m[1]).slice(0, 200);
      i++;
    }
    return out;
  } catch {
    return [];
  }
}

// --- Live context ---------------------------------------------------------
const AVAILABILITY_RE = /\b(gas at|available|availability|queue|queuing|has gas|out of gas|finished|nearest|closest|near me|where.*station|station.*gas|open now|in stock)\b/i;

async function recentNews() {
  if (!supabaseConfigured) return [];
  try {
    const rows = await sb(
      "news_items?select=title,summary,published_at,source_url&order=published_at.desc&limit=5"
    );
    return (rows || []).map((n) => ({
      title: n.title, summary: n.summary || "", url: n.source_url || null,
      date: String(n.published_at || "").slice(0, 10),
    }));
  } catch (e) {
    if (!isMissingTableError(e)) { /* table missing or any other failure: skip silently */ }
    return [];
  }
}

async function availabilityContext(question) {
  if (!supabaseConfigured) {
    return "LIVE AVAILABILITY: the reports database is not configured, so there is no live availability data. Say that live availability is unavailable right now and point the user at the Map tab.";
  }
  let rows = [];
  try {
    const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    rows = await sb(
      `availability_reports?select=station_id,status,queue_minutes,reported_at` +
      `&reported_at=gte.${encodeURIComponent(since)}&order=reported_at.desc&limit=200`
    ) || [];
  } catch {
    return "LIVE AVAILABILITY: the live reports could not be read just now. Say that live availability is unavailable right now and point the user at the Map tab.";
  }
  const fresh = rows.filter((r) => Date.now() - new Date(r.reported_at).getTime() < REPORT_TTL_MS);
  const names = loadStationNames();
  const label = (r) => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(r.reported_at).getTime()) / 60000));
    const q = r.queue_minutes != null ? `, queue about ${r.queue_minutes} min` : "";
    return `- ${names.get(r.station_id) || r.station_id}: ${r.status}${q} (reported ${mins} min ago)`;
  };
  // Did the user name a station? Score each station by distinctive name words
  // present in the question (generic words like "station" or "road" never
  // count, so a general "nearest station with gas?" question never
  // false-matches one station).
  const STOPWORDS = new Set(["station", "limited", "nigeria", "road", "street",
    "avenue", "close", "petrol", "filling", "retail", "company", "energy",
    "motors", "motor", "centre", "center", "conversion", "refuelling",
    "services", "global", "enterprises", "north", "south", "east", "west"]);
  const q = question.toLowerCase();
  let named = null, bestScore = 0;
  for (const [id, name] of names.entries()) {
    const words = new Set(name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
    let score = 0;
    for (const w of words) if (q.includes(w)) score++;
    if (score > bestScore) { bestScore = score; named = [id, name]; }
  }
  if (named) {
    const mine = fresh.filter((r) => r.station_id === named[0]);
    if (mine.length === 0) {
      return `LIVE AVAILABILITY: NO recent report exists for ${named[1]} — no driver has reported gas status there in the last 2 hours. Say exactly that; do NOT guess whether it has gas. Point the user at the Map tab to check nearby stations.`;
    }
    return `LIVE AVAILABILITY — fresh reports (last 2 hours) for ${named[1]}:\n${mine.slice(0, 3).map(label).join("\n")}`;
  }
  if (fresh.length === 0) {
    return "LIVE AVAILABILITY: NO recent report exists for any station — no driver has reported gas status anywhere in the last 2 hours. Say exactly that; do NOT guess whether any station has gas. Point the user at the Map tab.";
  }
  const available = fresh.filter((r) => r.status === "available").slice(0, 8);
  const other = fresh.filter((r) => r.status !== "available").slice(0, 4);
  const lines = [...available, ...other].map(label).join("\n");
  return `LIVE AVAILABILITY — fresh reports (last 2 hours, newest first). Only these stations have known status; every other station is unconfirmed:\n${lines}`;
}

// --- Gemini ----------------------------------------------------------------
const SYSTEM_RULES = `You are the FindCNG assistant, answering questions about CNG (compressed natural gas) in Nigeria and about the FindCNG app. Follow these rules strictly:
1. Every factual claim must come from the VERIFIED KNOWLEDGE BASE below or from a LIVE WEB SEARCH result below. Never use your own general knowledge for Nigerian facts, prices or incidents.
2. Prices ALWAYS carry their date (e.g. "₦380/SCM since September 2025"). Never quote a price without its date.
3. NEVER invent live availability. Use ONLY the LIVE AVAILABILITY block below. If it says no recent report exists, say exactly that and point the user at the Map tab in the FindCNG app. Never guess whether a station has gas.
4. If the answer is not established in the knowledge base or the search results, say "I don't know" plainly — never guess.
5. Never give DIY instructions for gas systems, cylinders, fittings or repairs. Direct the user to a certified installer / accredited conversion centre instead.
6. Short, plain English, about 150 words maximum. No markdown headings; simple sentences. End with the source names for the key facts you used.`;

async function askGemini(apiKey, prompt) {
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`Gemini ${r.status}: ${String(body?.error?.message || "request failed").slice(0, 400)}`);
  }
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error("Gemini returned no answer");
  return text;
}

// --- Handler ---------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!rateLimit(req, "chat", 10, 60_000)) {
    return json(res, 429, { ok: false, error: "Too many questions — please wait a minute and try again." });
  }
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    // Key not set yet — graceful, never an error. The app shows "being set up".
    return json(res, 200, { configured: false, answer: null });
  }
  const question = String((req.body || {}).question || "").trim();
  if (!question) {
    return json(res, 400, { ok: false, error: "question is required" });
  }
  if (question.length > MAX_QUESTION) {
    return json(res, 400, { ok: false, error: `question must be ${MAX_QUESTION} characters or fewer` });
  }
  try {
    const [news, searchResults, availability] = await Promise.all([
      recentNews(),
      webSearch(`${question} CNG Nigeria`),
      AVAILABILITY_RE.test(question) ? availabilityContext(question) : Promise.resolve(null),
    ]);
    const knowledge = loadKnowledge();
    const newsBlock = news.length
      ? "RECENT NEWS (from FindCNG, newest first):\n" + news.map((n) =>
          `- ${n.date} — ${n.title}${n.summary ? ": " + n.summary : ""}`).join("\n")
      : "RECENT NEWS: none available.";
    const searchBlock = searchResults.length
      ? "LIVE WEB SEARCH results (use these for facts newer than the knowledge base; cite the link):\n" + searchResults.map((s) =>
          `- ${s.title} (${s.url})${s.snippet ? " — " + s.snippet : ""}`).join("\n")
      : "LIVE WEB SEARCH: unavailable just now — answer from the knowledge base only.";
    const prompt = `${SYSTEM_RULES}\n\nVERIFIED KNOWLEDGE BASE:\n${knowledge || "(knowledge base unavailable — answer only from search results, or say you don't know.)"}\n\n${newsBlock}\n\n${searchBlock}\n\n${availability ? availability + "\n\n" : ""}USER QUESTION: ${question}`;
    const answer = await askGemini(apiKey, prompt);
    const sources = [
      ...searchResults.map((s) => ({ title: s.title, url: s.url })),
      ...news.filter((n) => n.url).map((n) => ({ title: n.title, url: n.url })),
    ];
    return json(res, 200, {
      ok: true,
      answer,
      sources,
      search_available: searchResults.length > 0,
      configured: true,
    });
  } catch (e) {
    // Log the real cause server-side (status + message only — never the key).
    console.error("chat failed:", e && e.message ? e.message : String(e));
    return json(res, 502, { ok: false, error: "The AI service could not answer right now — please try again in a moment." });
  }
}
