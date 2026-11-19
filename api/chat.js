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
//   4. For station questions (Phase 3, §13): the named station's actual
//      directory row from data/stations.json (read-only lookup, gated on
//      directory intent + two distinctive name words). Missing fields
//      are reported as "Information unavailable", never invented.
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
// BACKUP PROVIDER (19 Nov 2026, Saheed's choice — switched from Groq,
// whose sign-up blocked his account with code signup_blocked): when
// OPENROUTER_API_KEY is set (free OpenRouter key, no card), OpenRouter
// answers if the whole Gemini chain fails. Its free models cost $0 and
// the no-credits tier allows 50 requests/day — far more than a fallback
// that only runs when Gemini is down ever needs. Without the key, the
// old lite retry runs instead. Adding the key to Vercel needs a redeploy
// before the functions see it.
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
let stationRows = null;  // Map station_id -> full directory row (read-only grounding, Phase 3)
function loadStationNames() {
  if (stationNames !== null) return stationNames;
  stationNames = new Map();
  stationRows = new Map();
  try {
    const list = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
    for (const s of list) {
      stationNames.set(s.id, `${s.name || s.id}${s.city ? ", " + s.city : ""}${s.state ? " (" + s.state + ")" : ""}`);
      stationRows.set(s.id, s);
    }
  } catch { /* name lookup is a nicety; station ids still work without it */ }
  return stationNames;
}

// Did the user name a station? Score each station by distinctive name
// words present in the question (generic words like "station" or "road"
// never count, so a general "nearest station with gas?" question never
// false-matches one station). Returns { id, name, score } or null.
const NAME_STOPWORDS = new Set(["station", "limited", "nigeria", "road", "street",
  "avenue", "close", "petrol", "filling", "retail", "company", "energy",
  "motors", "motor", "centre", "center", "conversion", "refuelling",
  "services", "global", "enterprises", "north", "south", "east", "west"]);
function findNamedStation(question) {
  const names = loadStationNames();
  const q = question.toLowerCase();
  let named = null, bestScore = 0;
  for (const [id, name] of names.entries()) {
    const words = new Set(name.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 4 && !NAME_STOPWORDS.has(w)));
    let score = 0;
    for (const w of words) if (q.includes(w)) score++;
    if (score > bestScore) { bestScore = score; named = [id, name]; }
  }
  return named ? { id: named[0], name: named[1], score: bestScore } : null;
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
  const named = findNamedStation(question);
  if (named) {
    const mine = fresh.filter((r) => r.station_id === named.id);
    if (mine.length === 0) {
      return `LIVE AVAILABILITY: NO recent report exists for ${named.name} — no driver has reported gas status there in the last 2 hours. Say exactly that; do NOT guess whether it has gas. Point the user at the Map tab to check nearby stations.`;
    }
    return `LIVE AVAILABILITY — fresh reports (last 2 hours) for ${named.name}:\n${mine.slice(0, 3).map(label).join("\n")}`;
  }
  if (fresh.length === 0) {
    return "LIVE AVAILABILITY: NO recent report exists for any station — no driver has reported gas status anywhere in the last 2 hours. Say exactly that; do NOT guess whether any station has gas. Point the user at the Map tab.";
  }
  const available = fresh.filter((r) => r.status === "available").slice(0, 8);
  const other = fresh.filter((r) => r.status !== "available").slice(0, 4);
  const lines = [...available, ...other].map(label).join("\n");
  return `LIVE AVAILABILITY — fresh reports (last 2 hours, newest first). Only these stations have known status; every other station is unconfirmed:\n${lines}`;
}

// --- Station grounding (Phase 3, §13) -------------------------------------
// Read-only lookup in data/stations.json: when the user asks about a
// specific station (where it is, its address, phone, accreditation),
// the answer is grounded in the actual directory row — never the
// model's own knowledge, which would invent addresses. Gated twice:
// the question must show directory intent AND match at least two
// distinctive name words, so "Where is the nearest station?" never
// false-matches one station. Missing fields are reported as
// "Information unavailable", never invented.
const DIRECTORY_RE = /\b(where is|where's|address|located|location|find|directions|phone|call|contact|accredit|opening|hours|open now|near me|nearest)\b/i;
function stationContext(question) {
  if (!DIRECTORY_RE.test(question)) return null;
  const named = findNamedStation(question);
  if (!named || named.score < 2) return null;
  loadStationNames();
  const s = stationRows && stationRows.get(named.id);
  if (!s) return null;
  const typeLabel = s.type === "refuelling" ? "Refuelling station"
    : s.type === "conversion" ? "Conversion centre"
    : s.type === "both" ? "Refuelling station + conversion centre"
    : (s.type || "Information unavailable");
  const acc = s.acc ? "Officially accredited — Pi-CNG accredited centres register (checked 18 Nov 2026)"
    : s.refReg ? "On the Pi-CNG refuelling stations register (updated 15 Oct 2026)"
    : s.confidence === "stale-2024-list" ? "Needs re-verification — from a 2024 list, not re-checked against a current source"
    : s.confidence === "single-source" ? "Single source — needs a second check"
    : "Not on the Pi-CNG register — no accreditation is claimed for this entry";
  const unavailable = "Information unavailable";
  return `STATION (from the FindCNG directory — verified data, use ONLY these details for this station):\n` +
    `- Name: ${s.name || unavailable}\n` +
    `- Address: ${s.address || unavailable}\n` +
    `- City, State: ${[s.city, s.state].filter(Boolean).join(", ") || unavailable}\n` +
    `- Type: ${typeLabel}\n` +
    `- Accreditation: ${acc}\n` +
    `- Phone: ${s.phone || unavailable}\n` +
    `- Opening hours: ${typeof s.hours === "string" ? s.hours : unavailable}\n` +
    `If a detail above says "Information unavailable", say exactly that — never invent a phone number, hours, price or exact location. For live gas status use the LIVE AVAILABILITY block, not this one.`;
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
8. FINDCNG APP HELP: you know the app — Map tab (live status, nearest stations), Stations tab (134 refuelling stations), Centres tab (617 conversion centres), one-tap Has gas / Out reporting, WhatsApp share, postcode labels, CNG Intelligence dashboard (national overview, state comparison, gaps, growth). When a question is about using the app, guide the user to the right tab.
9. STATION DETAILS: when the STATION block below names a station, use ONLY those details for its address, city, state, type and accreditation. If a detail is not listed there (phone, hours, price), say "Information unavailable" — never invent it. If no STATION block is given, do not guess a station's location — point the user at the Stations tab or the Map tab to find it.`;

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

async function askGeminiChain(apiKey, systemText, contents) {
  // Tries lite, then 3.8-flash; on transient overload (503/429) OR a
  // timeout, moves straight to the next model. Returns the answer or
  // throws the last error — the caller decides the next step (OpenRouter, or
  // the lite retry when OpenRouter is not configured).
  // 18 Nov 2026 ~18:10 WAT: the free tier was so overloaded at peak hours
  // that BOTH models 503'd on about half the requests (Vercel logs show
  // interleaved successes and "high demand" 503s within the same minute).
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
  throw lastError || new Error("Gemini request failed");
}

// --- OpenRouter (free backup, 19 Nov 2026) ---------------------------------
// OpenAI-compatible chat completions. The same system prompt + history go
// to OpenRouter, mapped to the OpenAI message shape (Gemini "model" turns
// become "assistant" turns). Model "openrouter/free" is OpenRouter's own
// router across its free models — the free lineup rotates every few
// weeks, so routing beats pinning one model that can be delisted (live
// list checked 19 Nov 2026: 13 free models, all $0, incl. Gemma 4 and
// Nemotron 3). HTTP-Referer + X-Title are OpenRouter's recommended app
// headers. Free models cost $0, so the token budget is generous: a
// reasoning model behind the router may spend some of it thinking.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_TIMEOUT_MS = 15000;
const OPENROUTER_MAX_TOKENS = 2500;

async function askOpenRouter(apiKey, systemText, contents) {
  const messages = [
    { role: "system", content: systemText },
    ...contents.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.parts.map((p) => p.text || "").join(""),
    })),
  ];
  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://findcng.vercel.app",
      "X-Title": "FindCNG",
    },
    body: JSON.stringify({ model: OPENROUTER_MODEL, messages, max_tokens: OPENROUTER_MAX_TOKENS }),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`OpenRouter ${r.status}: ${String(body?.error?.message || "request failed").slice(0, 300)}`);
  }
  const text = String(body?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("OpenRouter returned no answer");
  return text;
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
  const openRouterKey = (process.env.OPENROUTER_API_KEY || "").trim();
  try {
    const [news, searchResults, availability] = await Promise.all([
      recentNews(),
      doSearch ? webSearch(question, cngTopic) : Promise.resolve([]),
      AVAILABILITY_RE.test(question) ? availabilityContext(question) : Promise.resolve(null),
    ]);
    const knowledge = loadKnowledge();
    const station = stationContext(question);
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
    const systemText = `${SYSTEM_RULES}\n\nVERIFIED KNOWLEDGE BASE:\n${knowledge || "(knowledge base unavailable — answer general questions from your own knowledge; for Nigeria-specific facts, say you don't know.)"}\n\n${newsBlock}\n\n${searchBlock}${availability ? "\n\n" + availability : ""}${station ? "\n\n" + station : ""}`;
    const contents = [...history, { role: "user", parts: [{ text: question }] }];
    // Answer chain: Gemini lite -> Gemini flash -> (OpenRouter if
    // configured, else one lite retry after a short wait on fast
    // overload). Budget with OpenRouter: 5s search + 15s + 15s + 15s =
    // 50s; without: 5s + 15s + 15s + 4s wait + 12s retry = 51s — both
    // inside the 60s function cap.
    let answer;
    let provider = "gemini";
    const geminiStarted = Date.now();
    try {
      answer = await askGeminiChain(apiKey, systemText, contents);
    } catch (geminiError) {
      const geminiElapsed = Date.now() - geminiStarted;
      if (openRouterKey) {
        console.error(`chat gemini failed (${String(geminiError.message).slice(0, 120)}), trying OpenRouter`);
        answer = await askOpenRouter(openRouterKey, systemText, contents);
        provider = "openrouter";
        console.error("chat answered by openrouter");
      } else if (/503|429/.test(geminiError.message) && geminiElapsed < 20000) {
        // No backup provider: the 503s come back FAST, so wait 4s and try
        // the lite model once more — spikes often clear within seconds.
        // Slow failures (timeouts) never retry.
        console.error(`chat retry: chain failed in ${geminiElapsed}ms on overload, retrying lite model once`);
        await new Promise((r) => setTimeout(r, 4000));
        answer = await askGeminiOnce(apiKey, systemText, contents, MODELS[0], 12000);
      } else {
        throw geminiError;
      }
    }
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
      provider,
      search_available: searchResults.length > 0,
      configured: true,
    });
  } catch (e) {
    // Log the real cause server-side (status + message only — never the key).
    // Then answer 200 with the helpful fallback, never a bare error —
    // the chat stays usable even when every AI service is down.
    console.error("chat failed:", e && e.message ? e.message : String(e));
    return json(res, 200, { ok: true, answer: FALLBACK_ANSWER, provider: "fallback", degraded: true, configured: true });
  }
}
