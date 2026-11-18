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
// Plus a best-effort web search (no key): a fallback chain — DuckDuckGo
// Lite, then Bing HTML, then the Wikipedia API — tried in turn until one
// returns results. On ANY search failure the answer proceeds without it
// and search_available:false is returned. Each attempt logs its outcome
// server-side (endpoint + status only, never the query).
//
// The model answers GENERAL CNG questions from its own knowledge, but
// Nigeria-specific facts (prices, stations, incidents, Pi-CNG/NADDC
// findings) must come from the knowledge base or the search results.
//
// Env: GEMINI_API_KEY (free Google AI Studio key). Without it the route
// answers { configured: false } and the app shows "being set up" —
// graceful, never an error. NO chat logs are stored — no DB writes at all.
import { json, sb, supabaseConfigured, rateLimit, isMissingTableError } from "./_lib.js";
import { readFileSync } from "node:fs";

// Model chain — 3.8-flash first, 3.5-flash-lite as the overload fallback.
// 18 Nov 2026: gemini-2.5-flash is retired for new API users (Gemini 404);
// Google's own error message directs new users to gemini-3.8-flash. The
// lite model is Google's own recommended simpler alternative, and our
// answers are short and grounded, so it is plenty when 3.8 is overloaded.
const MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const MAX_QUESTION = 500;
// 1200, not 400: on thinking models the thinking tokens count toward the
// output budget, and at 400 the model spent nearly all of it thinking and
// returned one-sentence answers. The prompt still asks for ~150 words.
const MAX_OUTPUT_TOKENS = 1200;
const REPORT_TTL_MS = 2 * 60 * 60 * 1000; // same 2-hour window as the app
// Total budget for the whole search chain. Worst case (8s search + 2 x 25s
// Gemini) still fits the 60s function cap.
const SEARCH_TOTAL_MS = 8000;
// Per-endpoint cap inside the total budget.
const SEARCH_ATTEMPT_MS = 4000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// Per-attempt timeout for one Gemini call. Budget: 2 models x 25s + ~8s
// search stays inside the 60s function cap (no backoff between models —
// the model switch itself is the remedy for overload).
const GEMINI_TIMEOUT_MS = 25000;

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

// --- Web search (no key, best effort, fallback chain) ---------------------
// 18 Nov 2026 diagnosis: the old parser matched only double-quoted
// class="result-link", but DDG Lite now serves single quotes — so the
// parser silently returned zero results on EVERY call, which is why
// search_available was always false (see searchDDGLite). The chain below
// (DDG Lite -> Bing HTML -> Wikipedia API) still stands: DDG Lite is also
// flaky under repeated requests (timeouts, slow-walking) and may block
// Vercel's datacenter IPs outright — unverifiable from the VM.
// NOT in the chain: html.duckduckgo.com/html (empty replies and timeouts
// even from the VM) and Mojeek (serves a CAPTCHA page). Both dead.
// Each attempt logs its outcome server-side (endpoint + status only —
// never the query). The coordinator checks the Vercel function logs after
// deploy to see which endpoint actually works from Vercel's network.
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
function bingLink(href) {
  // Bing wraps result links as /ck/a?!...&u=<2-char prefix + base64 target>&ntb=1.
  // The "u" value carries a 2-character prefix before the base64 payload
  // ("a1aHR0cHM6..." -> "https://..."), so strip it first; fall back to
  // decoding the whole value in case Bing ever drops the prefix.
  try {
    const u = new URL(decodeEntities(href), "https://www.bing.com");
    const enc = u.searchParams.get("u");
    if (enc) {
      for (const candidate of [enc.slice(2), enc]) {
        try {
          const target = Buffer.from(candidate, "base64").toString("utf8");
          if (/^https?:\/\/[^\s"'<>]+$/i.test(target)) return target;
        } catch { /* try the next candidate */ }
      }
      return null;
    }
    return /^https?:\/\//i.test(href) && !u.hostname.endsWith("bing.com") ? href : null;
  } catch { return null; }
}
// lite.duckduckgo.com returns simple HTML: <a ... class='result-link'
// href="..."> + <td class='result-snippet'>. Tiny regex parser.
//
// ROOT CAUSE found 18 Nov 2026: DDG Lite switched its result markup to
// SINGLE quotes (class='result-link', class='result-snippet') while the
// old parser only matched double quotes — so it silently returned zero
// results on every call, which is why search_available was always false.
// The regexes below accept either quote style, and the link regex no
// longer assumes class comes before href (DDG now puts href first).
// Vercel IP-based blocking may ALSO be a factor — unverifiable from the
// VM — which is why the Bing + Wikipedia fallbacks stay in the chain.
async function searchDDGLite(query, timeoutMs) {
  // Full browser headers: with the old "compatible; FindCNG/2.2" UA, Node's
  // fetch timed out against DDG Lite even from a VM network, while a
  // browser UA + Accept headers returned 200 with results.
  const r = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  const re = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    if (!/class=['"]result-link['"]/i.test(m[1])) continue;
    const hm = m[1].match(/href=(["'])(.*?)\1/);
    const url = hm ? ddgLink(decodeEntities(hm[2])) : null;
    const title = stripTags(m[2]);
    if (url && title) out.push({ title, url, snippet: "" });
  }
  // Attach the snippet that follows each link, when present.
  const snip = /<td class=['"]result-snippet['"]>([\s\S]*?)<\/td>/gi;
  let i = 0;
  while ((m = snip.exec(html)) && i < out.length) {
    out[i].snippet = stripTags(m[1]).slice(0, 200);
    i++;
  }
  return out;
}
// www.bing.com/search returns real results from a VM network; the markup
// is heavy but the pattern is stable: <h2><a ... href="...ck/a...">Title</a>
// </h2> plus <div class="b_caption"><p>snippet</p></div> in the same order.
async function searchBing(query, timeoutMs) {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const out = [];
  const re = /<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    const url = bingLink(m[1]);
    const title = stripTags(m[2]);
    if (url && title) out.push({ title, url, snippet: "" });
  }
  const snip = /<div class="b_caption"><p[^>]*>([\s\S]*?)<\/p>/gi;
  let i = 0;
  while ((m = snip.exec(html)) && i < out.length) {
    out[i].snippet = stripTags(m[1]).slice(0, 200);
    i++;
  }
  return out;
}
// Wikipedia's search API needs no key and answers reliably from datacenter
// IPs. Encyclopedic, so it suits general CNG questions, not news — it is
// the last resort, not the first. Leading question words are stripped so
// "How does CNG work?" searches for "CNG work".
async function searchWikipedia(question, timeoutMs) {
  let clean = question.replace(/[?.!]+$/g, "").trim();
  let prev;
  do {
    prev = clean;
    clean = clean.replace(/^(what|how|why|when|where|who|is|are|was|were|do|does|did|can|could|should|would|the|a|an)\s+/i, "");
  } while (clean !== prev);
  if (clean.length < 3) return [];
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(clean)}&srlimit=5&format=json`, {
    headers: { "User-Agent": "FindCNG/2.4 (https://findcng.vercel.app)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j?.query?.search || []).map((s) => ({
    title: s.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`,
    snippet: stripTags(s.snippet || "").slice(0, 200),
  }));
}
async function webSearch(question) {
  const started = Date.now();
  const attempts = [
    { name: "ddg-lite", run: (ms) => searchDDGLite(`${question} CNG Nigeria`, ms) },
    { name: "bing", run: (ms) => searchBing(`${question} CNG Nigeria`, ms) },
    { name: "wikipedia", run: (ms) => searchWikipedia(question, ms) },
  ];
  for (const a of attempts) {
    const remaining = SEARCH_TOTAL_MS - (Date.now() - started);
    if (remaining < 500) break;
    const budget = Math.min(SEARCH_ATTEMPT_MS, remaining);
    try {
      const results = await a.run(budget);
      if (results.length) {
        console.error(`chat search: ${a.name} ok (${results.length} results)`);
        return results;
      }
      console.error(`chat search: ${a.name} returned no results`);
    } catch (e) {
      console.error(`chat search: ${a.name} failed: ${String(e && e.message ? e.message : e).slice(0, 120)}`);
    }
  }
  return [];
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
1. NIGERIA-SPECIFIC FACTS — prices, stations, incidents, Pi-CNG / NADDC findings, FindCNG app facts — must come from the VERIFIED KNOWLEDGE BASE or the LIVE WEB SEARCH results below. Never use your own general knowledge for Nigerian facts, prices or incidents, and never invent station details or prices.
2. GENERAL CNG KNOWLEDGE — how CNG works, how it affects engines, safety principles, how conversions work, practice in other countries — you MAY answer from your own knowledge. If you are unsure about a general fact, say so rather than guessing.
3. Prices ALWAYS carry their date (e.g. "₦380/SCM since September 2025"). Never quote a price without its date.
4. NEVER invent live availability. Use ONLY the LIVE AVAILABILITY block below. If it says no recent report exists, say exactly that and point the user at the Map tab in the FindCNG app. Never guess whether a station has gas.
5. If a Nigeria-specific answer is not established in the knowledge base or the search results, say "I don't know" plainly — never guess. A general CNG question you genuinely cannot answer also gets a plain "I don't know".
6. Never give DIY instructions for gas systems, cylinders, fittings or repairs. Direct the user to a certified installer / accredited conversion centre instead.
7. SCOPE: this chat answers CNG questions only. If the question is not about CNG, fuel, vehicles or the FindCNG app (for example "What is a noun?"), do NOT answer it and do NOT reply with a bare "I don't know". Instead say you answer questions about CNG — fuel savings, safety, stations and conversions in Nigeria — and suggest a CNG question to try.
8. Short, plain English, about 150 words maximum. No markdown headings; simple sentences. Do NOT end with a "Sources:" line — the app shows sources separately.`;

// Graceful fallback when the model still returns a bare "I don't know."
// (the prompt asks for the scope message, but this is the safety net).
// Off-topic questions get the scope message; on-topic ones get an honest
// "not covered yet" with a nudge toward what the chat does answer.
const SCOPE_MESSAGE = "I answer questions about CNG — fuel savings, safety, stations and conversions in Nigeria. Try asking how much you could save by switching to CNG, whether CNG is safe, or where to find a conversion centre near you.";
const UNKNOWN_CNG_MESSAGE = "I don't know — that isn't covered in the FindCNG knowledge base yet. Try asking about CNG safety, fuel savings, stations or conversions.";
const CNG_TOPIC_RE = /\b(cng|natural gas|lpg|gas|fuel|petrol|diesel|station|conversion|convert|cylinder|engine|vehicle|car|savings|price|cost|safety|safe|nigeria|findcng|refuel|filling|queue|kit|pi-cng|naddc)\b/i;
const BARE_IDK_RE = /^(i'?m (sorry|afraid)[,.]?\s*)?i (don't|do not) know[.!]?$/i;
function isBareIDontKnow(text) {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= 60 && BARE_IDK_RE.test(t);
}
function stripSourcesLine(text) {
  // Safety net: the prompt tells the model not to append a Sources line
  // (the app shows sources behind a toggle), but strip one anyway if it
  // appears as a trailing block. Never touches "source" mentions
  // mid-answer, and never strips when the head would be left too short.
  const m = text.match(/\n\s*(?:sources?|references?)\s*[:\-–—][\s\S]*$/i);
  if (!m) return text;
  const head = text.slice(0, m.index).trimEnd();
  if (head.length >= 10 && m[0].length <= 600) return head;
  return text;
}

async function askGeminiOnce(apiKey, prompt, model, timeoutMs) {
  const r = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // 18 Nov 2026: 3.8-flash is a thinking model — its default thinking
      // level (medium) made live calls run past 45s. "low" keeps answers
      // fast; our answers are short and grounded, not reasoning tasks.
      // NO temperature: Google's guidance for Gemini 3 models is to leave
      // temperature at its default (1.0) — lowering it "may cause looping
      // or degraded performance", and our temperature: 0.2 calls hung.
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "low" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`Gemini ${model} ${r.status}: ${String(body?.error?.message || "request failed").slice(0, 400)}`);
  }
  const text = body?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "").join("").trim();
  if (!text) throw new Error(`Gemini ${model} returned no answer`);
  return text;
}

async function askGemini(apiKey, prompt) {
  // Model fallback chain: try each model once; on transient overload
  // (503/429) OR a timeout, move straight to the next model. Budget:
  // 2 x 25s + ~8s search stays inside the 60s function cap.
  // 18 Nov 2026 ~18:10 WAT: the free tier was so overloaded at peak hours
  // that BOTH models 503'd on about half the requests (Vercel logs show
  // interleaved successes and "high demand" 503s within the same minute).
  // The 503s come back FAST (~10s for the whole chain), so when the chain
  // fails fast on overload, wait 6s and try the lite model once more —
  // spikes often clear within seconds. Worst case (20s + 6s + 20s + 8s
  // search) still fits the 60s cap; slow failures (timeouts) never retry.
  const started = Date.now();
  let lastError = null;
  for (let i = 0; i < MODELS.length; i++) {
    try {
      return await askGeminiOnce(apiKey, prompt, MODELS[i], GEMINI_TIMEOUT_MS);
    } catch (e) {
      // Transient failures (overload OR timeout) fall through to the next
      // model; anything else stops the chain immediately.
      if (i < MODELS.length - 1 && /503|429|abort|timeout/i.test(e.message)) { lastError = e; continue; }
      lastError = e;
      break;
    }
  }
  const elapsed = Date.now() - started;
  if (lastError && /503|429/.test(lastError.message) && elapsed < 20000) {
    console.error(`chat retry: chain failed in ${elapsed}ms on overload, retrying lite model once`);
    await new Promise((r) => setTimeout(r, 6000));
    return await askGeminiOnce(apiKey, prompt, MODELS[MODELS.length - 1], 20000);
  }
  throw lastError || new Error("Gemini request failed");
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
      webSearch(question),
      AVAILABILITY_RE.test(question) ? availabilityContext(question) : Promise.resolve(null),
    ]);
    const knowledge = loadKnowledge();
    const newsBlock = news.length
      ? "RECENT NEWS (from FindCNG, newest first):\n" + news.map((n) =>
          `- ${n.date} — ${n.title}${n.summary ? ": " + n.summary : ""}`).join("\n")
      : "RECENT NEWS: none available.";
    const searchBlock = searchResults.length
      ? "LIVE WEB SEARCH results (use these for facts newer than the knowledge base):\n" + searchResults.map((s) =>
          `- ${s.title} (${s.url})${s.snippet ? " — " + s.snippet : ""}`).join("\n")
      : "LIVE WEB SEARCH: unavailable just now — answer from the knowledge base and your own general CNG knowledge.";
    const prompt = `${SYSTEM_RULES}\n\nVERIFIED KNOWLEDGE BASE:\n${knowledge || "(knowledge base unavailable — answer general CNG questions from your own knowledge and search results; for Nigeria-specific facts, say you don't know.)"}\n\n${newsBlock}\n\n${searchBlock}\n\n${availability ? availability + "\n\n" : ""}USER QUESTION: ${question}`;
    let answer = await askGemini(apiKey, prompt);
    // The app shows sources behind a toggle, so no "Sources:" line belongs
    // in the answer text; strip one if the model appended it anyway.
    answer = stripSourcesLine(answer);
    // A bare "I don't know." helps nobody: off-topic questions get the
    // graceful scope message, on-topic ones an honest "not covered yet".
    if (isBareIDontKnow(answer)) {
      answer = CNG_TOPIC_RE.test(question) ? UNKNOWN_CNG_MESSAGE : SCOPE_MESSAGE;
    }
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
