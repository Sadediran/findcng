// POST /api/submissions — a centre submits itself for listing.
// Nothing auto-publishes: the row lands in centre_submissions with
// status "pending" and waits for a moderator (see api/admin.js).
//
// Body (JSON): { name, operator?, address, city?, state, lga?, phone,
//   email?, services?, accreditation_body, accreditation_number,
//   certificate (data URL, <=2MB, required), certificate_name?,
//   latitude?, longitude?, submitter_contact?, declaration: true }
//
// The certificate goes to the private Supabase Storage bucket
// "certificates"; the row stores only its path (certificate_path).
// The city is folded into the address column (the schema has no city
// column). If Supabase is not configured the route answers
// { configured: false } and the app keeps the submission on the device.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { json, sb, sbUpload, supabaseConfigured, rateLimit } from "./_lib.js";

const MAX_CERT_BYTES = 2 * 1024 * 1024;
const MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "image/gif": "gif", "application/pdf": "pdf",
};

let stationsCache = null;
function loadStations() {
  if (stationsCache) return stationsCache;
  try {
    stationsCache = JSON.parse(readFileSync(join(process.cwd(), "data", "stations.json"), "utf8"));
  } catch {
    stationsCache = [];
  }
  return stationsCache;
}
function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function duplicateOf(name, address) {
  const nn = norm(name), na = norm(address);
  const aWords = new Set(na.split(" ").filter((w) => w.length > 2));
  return loadStations().find((s) => {
    if (norm(s.name) !== nn) return false;
    const sa = norm(s.address || "");
    const sWords = new Set(sa.split(" ").filter((w) => w.length > 2));
    let hit = 0;
    aWords.forEach((w) => { if (sWords.has(w)) hit++; });
    return hit >= 2 || (na && sa && (na.includes(sa) || sa.includes(na)));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false });
  }
  try {
    if (!rateLimit(req, "submissions", 10)) {
      return json(res, 429, { ok: false, error: "Too many submissions — please wait a minute." });
    }
    const b = req.body || {};
    const str = (v, max = 300) => String(v || "").trim().slice(0, max);
    const name = str(b.name, 120);
    const address = str(b.address, 300);
    const city = str(b.city, 80);
    const state = str(b.state, 80);
    const phone = str(b.phone, 20);
    const body = str(b.accreditation_body, 40);
    const number = str(b.accreditation_number, 120);
    if (!name || !address || !state || !phone || !body || !number) {
      return json(res, 400, { ok: false, error: "Centre name, address, state, phone, accreditation body and number are all required." });
    }
    if (b.declaration !== true) {
      return json(res, 400, { ok: false, error: "The truth declaration is required." });
    }
    // Certificate: data URL, required, <= 2 MB decoded.
    const cert = String(b.certificate || "");
    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(cert);
    if (!m || !MIME_EXT[m[1]]) {
      return json(res, 400, { ok: false, error: "A certificate photo or scan (image or PDF) is required." });
    }
    const buf = Buffer.from(m[2], "base64");
    if (!buf.length || buf.length > MAX_CERT_BYTES) {
      return json(res, 400, { ok: false, error: "The certificate file must be under 2 MB." });
    }
    // Automated pre-check: duplicate.
    const dup = duplicateOf(name, address);
    if (dup) {
      return json(res, 409, {
        ok: false, error: "duplicate",
        message: `This centre looks like it is already listed: ${dup.name} (${dup.address || ""}).`,
      });
    }
    const lat = Number(b.latitude), lng = Number(b.longitude);
    // Upload the certificate first; the row stores only the storage path.
    const certPath = `submissions/${randomUUID()}.${MIME_EXT[m[1]]}`;
    await sbUpload("certificates", certPath, buf, m[1]);
    const row = {
      centre_name: name,
      operator: str(b.operator, 120) || null,
      address: city ? `${address}, ${city}` : address,
      state,
      lga: str(b.lga, 80) || null,
      phone,
      email: str(b.email, 120) || null,
      services: str(b.services, 300) || null,
      accreditation_body: body,
      accreditation_number: number,
      certificate_path: certPath,
      latitude: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null,
      longitude: Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null,
      submitter_contact: str(b.submitter_contact, 120) || null,
      status: "pending",
    };
    const inserted = await sb("centre_submissions", {
      method: "POST", body: row, prefer: "return=representation",
    });
    return json(res, 200, { configured: true, ok: true, id: (inserted || [])[0]?.id || null });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Could not save the submission. " + String(e.message || e).slice(0, 160) });
  }
}
