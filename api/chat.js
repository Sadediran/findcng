// POST /api/chat — "Ask anything" AI answers.
// Body: { question, history? } (question max 500 chars; history is the
// recent conversation, [{ role: "user"|"model", text }], page memory only).
//
// A GENERAL assistant, like Gemini itself — it answers ANY question, on
// any topic, with expert knowledge of the FindCNG app and CNG in Nigeria
// layered on top (Saheed, 19 Nov 2026: the CNG-only scope is gone).
// Answers come from Google's Gemini API (free tier, no card, no spend),
// grounded in three live sources assembled server-side before the call:
//   1. data/chat-knowledge.json — the verified FindCNG knowledge base
//      (safety facts, dated prices, programme facts, how FindCNG works).
//   2. Recent news headlines from the news_items table (best effort — the
//      table may not exist yet; skipped silently if it does not).
//   3. For availability questions: fresh availability_reports (last 2 hours
//      only). The LLM is told explicitly when NO recent report exists —
//      it must never invent live availability.
// Plus a best-effort web search (no key) — but ONLY when the question
// needs fresh/external facts (news, prices, Nigeria-specific facts). General
// knowledge questions skip the search entirely, which is what makes them
// fast. The chain is DuckDuckGo Lite, then Bing HTML, then the Wikipedia
// API, tried in turn until one returns results. On ANY search failure the
// answer proceeds without it and search_available:false is returned. Each
// attempt logs its outcome server-side (endpoint + status only, never
// the query).
//
// Nigeria-specific facts (prices, stations, incidents, Pi-CNG/NADDC
// findings) must come from the knowledge base or the search results.
// General knowledge is answered from the model's own knowledge.
//
// Speed (19 Nov 2026): the lite model answers FIRST (it is the fastest),
// 3.8-flash is the fallback; per-attempt timeout 15s; the search runs
// only when needed. If every model fails, the route still answers 200
// with a helpful fallback message — the chat never shows a bare error.
//
// Env: GEMINI_API_KEY (free Google AI Studio key). Without it the route
// answers { configured: false } and the app shows "being set up" —
// graceful, never an error. NO chat logs are stored — no DB writes at all.
import { json, sb, supabaseConfigured, rateLimit, isMissingTableError } from "./_lib.js";
import { readFileSync } from "node:fs";

// Model chain — lite FIRST (it is the fastest model, and our answers are
// short), 3.8-flash as the stronger fallback. 18 Nov 2026: gemini-2.5-flash
// is retired for new API users (Gemini 404); Google's own error message
// directs new users to gemini-3.8-flash. 19 Nov 2026: the order was
// flipped lite-first for speed (Saheed: "I want the AI to be very fast").
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const MAX_QUESTION = 500;
// 1200, not 400: on thinking models the thinking tokens count toward the
// output budget, and at 400 the model spent nearly all of it thinking and
// returned one-sentence answers. The prompt still asks for ~150 words.
const MAX_OUTPUT_TOKENS = 1200;
const REPORT_TTL_MS = 2 * 60 * 60 * 1000; // same 2-hour window as the app
// Total budget for the whole search chain. Worst case (5s search + 2 x 15s
// Gemini + 4s wait + 12s retry) still fits the 60s function cap.
const SEARCH_TOTAL_MS = 5000;
// Per-endpoint cap inside the total budget.
const SEARCH_ATTEMPT_MS = 2500;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// Per-attempt timeout for one Gemini call. 15s, not 25s: the lite model
// answers short questions in a few seconds, and a slow attempt is better
// abandoned for the next model than waited on. Budget: 2 models x 15s +
// 4s wait + 12s retry + ~5s search stays inside the 60s function cap.
const GEMINI_TIMEOUT_MS = 15000;
// History: the last few exchanges, so follow-ups ("retry that", "what
// about...?") work. Capped hard — the frontend only ever sends page
// memory, and the server trusts nothing about its shape.
const MAX_HISTORY_TURNS = 12; // messages, i.e. 6 exchanges
const MAX_HISTORY_TEXT = 500; // chars per message

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
// 18 Nov 2026: Bing's HTML sometimes yields junk in the result slots —
// login pages ("Sign in to your account", "My Account", "My Pay Login
// Site") and unrelated portals (a health portal's MyChart page) — which
// reached the prompt's search block and, before their removal, the
// sources list. Drop login/account pages outright, and keep only results
// whose title or snippet touches the CNG/fuel topic.
const JUNK_TITLE_RE = /\b(sign in|log in|login|my account|create account|forgot password|reset password)\b/i;
const JUNK_URL_RE = /\/(login|signin|sign-in|auth|account\/login|my-account)/i;
const SEARCH_TOPIC_RE = /\b(cng|natural gas|lpg|gas|fuel|petrol|diesel|station|conversion|convert|cylinder|engine|vehicle|car|savings|price|nigeria|pi-cng|naddc|refuel|filling|queue|kit)\b/i;
function isUsableResult(r, cngTopic) {
  if (JUNK_TITLE_RE.test(r.title || "") || JUNK_URL_RE.test(r.url || "")) return false;
  // The CNG topic filter applies ONLY to CNG questions. A general question
  // ("What is a noun?") must keep its general results — filtering them to
  // CNG topics would drop every usable hit.
  if (!cngTopic) return true;
  return SEARCH_TOPIC_RE.test(`${r.title || ""} ${r.snippet || ""}`);
}
// Does this question need fresh/external facts? News, prices, incidents,
// Nigeria-specific and CNG-station questions do. General knowledge
// ("What is a noun?"), explanations, greetings and in-app help do not —
// skipping the search is what makes those answers fast.
const SEARCH_NEEDED_RE = /\b(news|latest|today|yesterday|recent|price|cost|naira|₦|incident|explosion|accident|station|pi-cng|naddc|nigeria|lagos|abuja|kano|kaduna|ibadan|benin|port harcourt|enugu|jos|ilorin|owerri|refuel|nearest|near me|conversion centre|filling station|where.*gas|how much.*(save|savings|cost))\b/i;
const CNG_TOPIC_RE = /\b(cng|natural gas|lpg|gas|fuel|petrol|diesel|station|conversion|convert|cylinder|engine|vehicle|car|savings|price|cost|safety|safe|nigeria|findcng|refuel|filling|queue|kit|pi-cng|naddc)\b/i;
function needsSearch(question) {
  return SEARCH_NEEDED_RE.test(question) || CNG_TOPIC_RE.test(question);
}
async function webSearch(question, cngTopic) {
  const started = Date.now();
  // CNG questions get the "CNG Nigeria" scope; general questions search
  // as asked — scoping "What is a noun?" to CNG would return junk.
  const q = cngTopic ? `${question} CNG Nigeria` : question;
  const attempts = [
    { name: "ddg-lite", run: (ms) => searchDDGLite(q, ms) },
    { name: "bing", run: (ms) => searchBing(q, ms) },
    { name: "wikipedia", run: (ms) => searchWikipedia(question, ms) },
  ];
  for (const a of attempts) {
    const remaining = SEARCH_TOTAL_MS - (Date.now() - started);
    if (remaining < 500) break;
    const budget = Math.min(SEARCH_ATTEMPT_MS, remaining);
    try {
      const results = (await a.run(budget)).filter((r) => isUsableResult(r, cngTopic));
      if (results.length) {
        console.error(`chat search: ${a.name} ok (${results.length} results)`);
        return results;
      }
      console.error(`chat search: ${a.name} returned no usable results`);
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
// 19 Nov 2026: the CNG-only scope is GONE (Saheed: "I want it to be very
// diverse like Gemini itself, while it can still give in-app guide").
// The assistant answers ANY question, on any topic, and thinks widely.
// What stays: Nigeria-specific facts must be grounded, prices carry
// dates, live availability is never invented, and no DIY gas instructions.
const SYSTEM_RULES = `You are the FindCNG assistant — a general AI assistant, like Gemini, with expert knowledge of the FindCNG app and of CNG (compressed natural gas) in Nigeria. Answer ANY question the user asks, on any topic, and think widely — you are not limited to one subject. Short, plain English, about 150 words maximum. No markdown headings; simple sentences. Do NOT end with a "Sources:" line — the chat shows no sources at all.
Rules:
1. CONVERSATION MEMORY: the conversation history is part of this chat. Answer follow-ups ("what about...?", "and then?", "retry that") using what was already said — never say you cannot see the previous question.
2. NIGERIA-SPECIFIC FACTS — prices, stations, incidents, Pi-CNG / NADDC findings, FindCNG app facts — must come from the VERIFIED KNOWLEDGE BASE or the LIVE WEB SEARCH results below. Never use your own general knowledge for Nigerian facts, prices or incidents, and never invent station details or prices.
3. GENERAL KNOWLEDGE — science, language, history, maths, how things work, anything else — answer from your own knowledge, the way Gemini would. If you are unsure about a fact, say so rather than guessing.
4. Prices ALWAYS carry their date (e.g. "₦380/SCM since September 2025"). Never quote a price without its date.
5. NEVER invent live availability. Use ONLY the LIVE AVAILABILITY block below. If it says no recent report exists, say exactly that and point the user at the Map tab in the FindCNG app. Never guess whether a station has gas.
6. Never give DIY instructions for gas systems, cylinders, fittings or repairs. Direct the user to a certified installer / accredited conversion centre instead.
7. If you genuinely do not know something, say "I don't know" plainly — never guess. But that is the last resort: think first, and only say it when you truly cannot answer.
8. FINDCNG APP HELP: you know the app — Map tab (live status, nearest stations), Stations tab (134 refuelling stations), Centres tab (617 conversion centres), one-tap Has gas / Out reporting, WhatsApp share, postcode labels. When a question is about using the app, guide the user to the right tab.`;

// Graceful fallback when the model still returns a bare "I don't know."
// (the prompt asks it to think first, but this is the safety net).
const UNKNOWN_MESSAGE = "I don't know — I couldn't find a solid answer for that. Try asking it a different way, or ask me something else.";
const BARE_IDK_RE = /^(i'?m (sorry|afraid)[,.]?\s*)?i (don't|do not) know[.!]?$/i;
function isBareIDontKnow(text) {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= 60 && BARE_IDK_RE.test(t);
}
function stripSourcesLine(text) {
  // Safety net: the prompt tells the model not to append a Sources line
  // (the chat shows no sources at all), but strip one anyway if it
  // appears as a trailing block. Never touches "source" mentions
  // mid-answer, and never strips when the head would be left too short.
  const m = text.match(/\n\s*(?:sources?|references?)\s*[:\-–—][\s\S]*$/i);
  if (!m) return text;
  const head = text.slice(0, m.index).trimEnd();
  if (head.length >= 10 && m[0].length <= 600) return head;
  return text;
}

// Validate the conversation history the frontend sends (page memory only).
// Returns Gemini `contents` turns: alternating user/model roles, starting
// with user, each message truncated. Anything malformed is dropped, and a
// trailing user turn is dropped too — the new question follows it, and
// two user turns in a row would break the alternation Gemini requires.
function parseHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const turns = [];
  for (const m of raw.slice(-MAX_HISTORY_TURNS)) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "model" ? "model" : m.role === "user" ? "user" : null;
    const text = String(m.text || "").trim().slice(0, MAX_HISTORY_TEXT);
    if (!role || !text) continue;
    // Enforce alternation starting with user; drop whatever breaks it.
    if (turns.length === 0 && role !== "user") continue;
    if (turns.length > 0 && turns[turns.length - 1].role === role) continue;
    turns.push({ role, parts: [{ text }] });
  }
  if (turns.length > 0 && turns[turns.length - 1].role === "user") turns.pop();
  return turns;
}

async function askGeminiOnce(apiKey, systemText, contents, model, timeoutMs) {
  const r = await fetch(geminiUrl(model), {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
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

async function askGemini(apiKey, systemText, contents) {
  // Model fallback chain: lite first, then 3.8-flash; on transient overload
  // (503/429) OR a timeout, move straight to the next model. Budget:
  // 2 x 15s + 4s wait + 12s retry + ~5s search stays inside the 60s cap.
  // 18 Nov 2026 ~18:10 WAT: the free tier was so overloaded at peak hours
  // that BOTH models 503'd on about half the requests (Vercel logs show
  // interleaved successes and "high demand" 503s within the same minute).
  // The 503s come back FAST, so when the chain fails fast on overload,
  // wait 4s and try the lite model once more — spikes often clear within
  // seconds. Slow failures (timeouts) never retry.
  const started = Date.now();
  let lastError = null;
  for (let i = 0; i < MODELS.length; i++) {
    try {
      return await askGeminiOnce(apiKey, systemText, contents, MODELS[i], GEMINI_TIMEOUT_MS);
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
    await new Promise((r) => setTimeout(r, 4000));
    return await askGeminiOnce(apiKey, systemText, contents, MODELS[0], 12000);
  }
  throw lastError || new Error("Gemini request failed");
}

// Last resort when every model fails: still answer 200 with a helpful
// message, never a bare error — the chat stays usable and the user is
// told exactly where to look meanwhile. (19 Nov 2026: Saheed — an error
// bubble "is not proper for an AI".)
const FALLBACK_ANSWER = "The AI service is very busy right now, so I couldn't get an answer through — it usually clears in a few seconds, so please ask again. Meanwhile, the Map tab shows live station status, the Stations tab lists all 134 refuelling stations, and the Safety hub answers the most common CNG questions.";

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
  const history = parseHistory((req.body || {}).history);
  const cngTopic = CNG_TOPIC_RE.test(question);
  const doSearch = needsSearch(question);
  try {
    const [news, searchResults, availability] = await Promise.all([
      recentNews(),
      doSearch ? webSearch(question, cngTopic) : Promise.resolve([]),
      AVAILABILITY_RE.test(question) ? availabilityContext(question) : Promise.resolve(null),
    ]);
    const knowledge = loadKnowledge();
    const newsBlock = news.length
      ? "RECENT NEWS (from FindCNG, newest first):\n" + news.map((n) =>
          `- ${n.date} — ${n.title}${n.summary ? ": " + n.summary : ""}`).join("\n")
      : "RECENT NEWS: none available.";
    const searchBlock = !doSearch
      ? "LIVE WEB SEARCH: skipped — this question does not need fresh facts. Answer from your own knowledge."
      : searchResults.length
        ? "LIVE WEB SEARCH results (use these for facts newer than the knowledge base):\n" + searchResults.map((s) =>
            `- ${s.title} (${s.url})${s.snippet ? " — " + s.snippet : ""}`).join("\n")
        : "LIVE WEB SEARCH: unavailable just now — answer from the knowledge base and your own knowledge.";
    const systemText = `${SYSTEM_RULES}\n\nVERIFIED KNOWLEDGE BASE:\n${knowledge || "(knowledge base unavailable — answer general questions from your own knowledge; for Nigeria-specific facts, say you don't know.)"}\n\n${newsBlock}\n\n${searchBlock}${availability ? "\n\n" + availability : ""}`;
    const contents = [...history, { role: "user", parts: [{ text: question }] }];
    let answer = await askGemini(apiKey, systemText, contents);
    // The chat shows no sources at all, so no "Sources:" line belongs
    // in the answer text; strip one if the model appended it anyway.
    answer = stripSourcesLine(answer);
    // A bare "I don't know." helps nobody — replace it with an honest
    // nudge to rephrase or ask something else.
    if (isBareIDontKnow(answer)) {
      answer = UNKNOWN_MESSAGE;
    }
    return json(res, 200, {
      ok: true,
      answer,
      search_available: searchResults.length > 0,
      configured: true,
    });
  } catch (e) {
    // Log the real cause server-side (status + message only — never the key).
    // Then answer 200 with the helpful fallback, never a bare error —
    // the chat stays usable even when the AI service is down.
    console.error("chat failed:", e && e.message ? e.message : String(e));
    return json(res, 200, { ok: true, answer: FALLBACK_ANSWER, degraded: true, configured: true });
  }
}
