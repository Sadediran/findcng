// Shared helpers for the FindCNG API functions.
// Files starting with _ in api/ are not treated as functions by Vercel.
//
// Supabase is accessed via its REST API with the service_role key — no npm
// dependency needed. The service key NEVER leaves the server; the browser
// only ever talks to these /api routes.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const SUPABASE_URL = process.env.SUPABASE_URL || "";
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

export function json(res, status, body, cacheControl) {
  res.setHeader("Content-Type", "application/json");
  // Default no-store (live reports must never be cached); a caller may
  // pass an explicit Cache-Control for cacheable public data
  // (live-centres: edge-cached 1h so the app does not hammer Pi-CNG).
  res.setHeader("Cache-Control", cacheControl || "no-store");
  return res.status(status).json(body);
}

// Supabase REST call. `path` is e.g. "availability_reports?select=*".
export async function sb(path, { method = "GET", body = null, prefer = null } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) {
    const msg = (data && (data.message || data.error)) || `Supabase ${r.status}`;
    const err = new Error(msg);
    err.code = (data && data.code) || null; // e.g. PGRST205 (table not found)
    err.status = r.status;
    throw err;
  }
  return data;
}

// True when a Supabase error means "this table does not exist yet" — the
// 2.0 tables (listing_reports, report_confirmations) until sql/001 is run.
// Routes use it to degrade gracefully instead of crashing.
export function isMissingTableError(e) {
  return e && (e.code === "PGRST205" || e.code === "42P01" ||
    /relation .* does not exist/i.test(String(e.message || "")) ||
    /Could not find the table/i.test(String(e.message || "")));
}

// Anonymous reporter fingerprint: hash of IP + user agent + day. It cannot
// identify a person, rotates daily, and exists only to stop spam.
// NOTE: Vercel may pass the real client IP in x-forwarded-for.
export function reporterHash(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
  const ua = req.headers["user-agent"] || "";
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${ip}|${ua}|${day}`).digest("hex").slice(0, 32);
}

// --- Admin passcode -------------------------------------------------------
// Env ADMIN_PASSCODE. FAILS CLOSED: when the env var is missing or empty,
// no passcode is accepted at all (there is no default — a default
// passcode is a back door). Set it in Vercel (Production, secret) and in
// .env.local (see README). Compared in constant time.
const ADMIN_PASSCODE = (process.env.ADMIN_PASSCODE || "").trim();
export function checkAdminPasscode(req) {
  if (!ADMIN_PASSCODE) return false;
  const given = req.headers["x-admin-passcode"] || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Role-based access (Phase 4, §16) ------------------------------------
// Three roles, each with its own passcode in env (all fail closed when
// unset — a role whose passcode is not configured simply does not
// exist). Roles are passcodes, not accounts: there is no Supabase Auth
// in this stack, so the role IS the actor identity recorded in the
// audit log. The permission matrix lives in api/admin.js (ROLE_ACTIONS);
// this helper only identifies the caller's role.
//   super_admin  ADMIN_PASSCODE        — everything
//   data_admin   DATA_ADMIN_PASSCODE   — listing reports, availability
//                                        moderation, data quality, read
//                                        the operator queue + audit log
//   verifier     VERIFIER_PASSCODE     — operator verification queue,
//                                        accreditation review, availability
//                                        moderation, read listing reports
// Content editor and support administrator (§16) are NOT shipped: there
// is no content-editing or support-ticket surface in this stack yet, so
// inventing roles for them would be a label with no function. They stay
// documented as pending in the README.
const ROLE_PASSCODES = [
  ["super_admin", (process.env.ADMIN_PASSCODE || "").trim()],
  ["data_admin", (process.env.DATA_ADMIN_PASSCODE || "").trim()],
  ["verifier", (process.env.VERIFIER_PASSCODE || "").trim()],
];
function passcodeMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function adminRole(req) {
  const given = req.headers["x-admin-passcode"] || "";
  for (const [role, pass] of ROLE_PASSCODES) {
    if (passcodeMatches(given, pass)) return role;
  }
  return null;
}

// --- Audit log (Phase 4, §16) --------------------------------------------
// Best-effort: the audit_log table exists only after sql/003 is run.
// Until then (or if the insert fails) the action still happens — the
// audit entry is lost, not the admin's work — and the failure is logged
// server-side. `detail` must never contain a passcode, a secret, or a
// submitter's private contact details.
export async function audit(role, action, targetType, targetId, detail) {
  if (!supabaseConfigured) return;
  try {
    await sb("audit_log", {
      method: "POST",
      body: {
        actor_role: String(role || "unknown").slice(0, 40),
        action: String(action || "").slice(0, 80),
        target_type: targetType ? String(targetType).slice(0, 40) : null,
        target_id: targetId ? String(targetId).slice(0, 80) : null,
        detail: detail ? String(detail).slice(0, 500) : null,
      },
    });
  } catch (e) {
    console.error("audit log insert failed:", String((e && e.message) || e).slice(0, 120));
  }
}

// --- Same-origin check (Phase 4, §19 — CSRF defence in depth) ------------
// The public POST routes take no cookies and no ambient credentials, so
// classic CSRF is already weak here; the admin passcode is a custom
// header a cross-origin page cannot set without a CORS preflight the
// server never approves. This check adds one more layer: a POST that
// carries an Origin or Referer from another host is refused. Requests
// with no Origin/Referer (curl, native clients, same-origin fetches
// that omit it) are allowed — blocking them would break legitimate
// non-browser callers, and a browser always sends Origin on a
// cross-origin POST.
export function checkSameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (!origin) return true;
  try {
    const host = new URL(origin).host.toLowerCase();
    const mine = String(req.headers.host || "").toLowerCase();
    return host === mine;
  } catch {
    return false;
  }
}

// --- Station-id validation (Phase 1) ------------------------------------
// POST routes only accept reports/confirmations/listing-reports for
// station ids that exist in data/stations.json — fake ids (e.g. CNG-999)
// used to be accepted and stored. Loaded once per instance; the file is
// bundled into the functions via vercel.json includeFiles. If the file
// cannot be read at all, validation is skipped (fail open, logged) rather
// than blocking every real report — the old behaviour was no validation.
let stationIds = null; // null = not loaded yet (or load failed)
export function loadStationIds() {
  if (stationIds !== null) return stationIds;
  try {
    const list = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
    stationIds = new Set((list || []).map((s) => s.id).filter(Boolean));
  } catch (e) {
    console.error("loadStationIds failed — station validation disabled:",
      String((e && e.message) || e).slice(0, 120));
    return null;
  }
  return stationIds;
}
export function isKnownStation(stationId) {
  const ids = loadStationIds();
  if (ids === null) return true; // file unavailable: fail open (logged above)
  return ids.has(stationId);
}

// Full station rows (Phase 4, §16 — duplicate detection + data quality
// in the admin dashboard). Same file, same fail-open rule as
// loadStationIds: null when the file cannot be read.
let stationRows = null; // null = not loaded yet (or load failed)
export function loadStations() {
  if (stationRows !== null) return stationRows;
  try {
    const list = JSON.parse(readFileSync(new URL("../data/stations.json", import.meta.url), "utf8"));
    stationRows = Array.isArray(list) ? list : [];
  } catch (e) {
    console.error("loadStations failed:", String((e && e.message) || e).slice(0, 120));
    return null;
  }
  return stationRows;
}

// --- Tiny in-memory rate limit (per serverless instance) ------------------
// 30 POSTs per minute per IP per bucket. Weak across instances, but it
// stops casual abuse without any extra service.
const buckets = new Map();
export function rateLimit(req, bucket, limit = 30, windowMs = 60_000) {
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .toString().split(",")[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length <= limit;
}
