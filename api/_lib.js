// Shared helpers for the FindCNG API functions.
// Files starting with _ in api/ are not treated as functions by Vercel.
//
// Supabase is accessed via its REST API with the service_role key — no npm
// dependency needed. The service key NEVER leaves the server; the browser
// only ever talks to these /api routes.
import { createHash, timingSafeEqual } from "node:crypto";

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
// Env ADMIN_PASSCODE; default "findcng-admin" — Saheed MUST change it in
// Vercel (see README). Compared in constant time.
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "findcng-admin";
export function checkAdminPasscode(req) {
  const given = req.headers["x-admin-passcode"] || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_PASSCODE);
  return a.length === b.length && timingSafeEqual(a, b);
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
