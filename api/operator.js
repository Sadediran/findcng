// POST /api/operator — operator portal submissions (Phase 4, §15).
//      An operator registers a business, claims an existing listing,
//      requests an update, submits an availability update, or responds
//      to a user report about their station. EVERY submission lands in
//      operator_submissions with status "pending" for a moderator —
//      NOTHING is published, and NOTHING is marked "Operator confirmed",
//      until an admin approves that exact submission (api/admin.js).
//      An operator cannot claim another station without verification:
//      a claim requires a business documentation reference
//      (proof_reference) plus a contact the moderator can reach for a
//      phone confirmation; the verification is a MANUAL checklist the
//      moderator completes in the admin dashboard — there is no
//      automated verification, and none is claimed.
//      Body (all types): { type, business_name, contact_name?,
//      phone?, email?, station_id?, proof_reference?, details?,
//      status?, queue_minutes?, pressure_ok?, compressor_ok?,
//      listing_report_id?, address?, state?, services?,
//      accreditation_body?, accreditation_number?, latitude?,
//      longitude? }. Per-type requirements are enforced below.
// GET  /api/operator?id=<uuid> — submission tracking: the submitter
//      checks their submission's status with the reference the app
//      showed them. Returns public fields only — phone, email and
//      reporter_hash are NEVER exposed.
// GET  /api/operator?station=CNG-XXX — public claim state for a
//      listing: { claimed: true/false, business_name? } — true only
//      when an APPROVED claim exists for that station. The detail page
//      shows an "Operator-verified listing" badge from this.
// If the operator_submissions table does not exist yet (sql/003 not
// run), POST and GET?id answer { ok: false, error: "not_open" } and
// the portal shows "not open yet" — nothing is silently dropped.
// GET?station degrades to { claimed: false }: with no table there are
// no approved claims, so that is the true state.
import { json, sb, supabaseConfigured, reporterHash, rateLimit, isMissingTableError, isKnownStation, checkSameOrigin } from "./_lib.js";

const TYPES = new Set(["register", "claim", "update", "availability", "response"]);
const STATUSES = new Set(["available", "low", "finished", "closed"]);
// Same type + station (or same business name for registrations) within
// this window is a duplicate (double-tap, retry storm) — return the
// first submission instead of inserting another row. Reporter-agnostic,
// like the availability and listing-report dedupes.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// The 36 states + FCT, canonical names. A registration's state must be
// one of these (case-insensitive); the moderator still checks the rest.
const STATES = new Set(["Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara"]);
function canonicalState(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (STATES.has(t)) return t;
  const lower = t.toLowerCase();
  if (lower === "fct" || lower === "abuja") return "Federal Capital Territory";
  for (const st of STATES) if (st.toLowerCase() === lower) return st;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+]?[\d\s()-]{7,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

export default async function handler(req, res) {
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false, error: "not_open" });
  }
  try {
    // --- Public claim state (detail-page badge) -----------------------
    if (req.method === "GET" && req.query.station) {
      const stationId = clean(req.query.station, 40);
      if (!stationId) return json(res, 400, { ok: false, error: "station is required" });
      try {
        const rows = await sb(
          `operator_submissions?select=business_name&type,status` +
          `&station_id=eq.${encodeURIComponent(stationId)}&type=eq.claim&status=eq.approved` +
          `&order=reviewed_at.desc&limit=1`
        );
        if (rows && rows.length) {
          return json(res, 200, { ok: true, claimed: true, business_name: rows[0].business_name });
        }
        return json(res, 200, { ok: true, claimed: false });
      } catch (e) {
        if (isMissingTableError(e)) return json(res, 200, { ok: true, claimed: false });
        throw e;
      }
    }
    // --- Submission tracking ------------------------------------------
    if (req.method === "GET") {
      if (!rateLimit(req, "operator-get", 60)) {
        return json(res, 429, { ok: false, error: "Too many checks — please wait a minute." });
      }
      const id = clean(req.query.id, 60);
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      try {
        const rows = await sb(
          `operator_submissions?select=id,type,station_id,business_name,status,submitted_at,reviewed_at,decision_reason` +
          `&id=eq.${encodeURIComponent(id)}&limit=1`
        );
        if (!rows || !rows.length) {
          return json(res, 404, { ok: false, error: "submission not found" });
        }
        return json(res, 200, { configured: true, ok: true, submission: rows[0] });
      } catch (e) {
        if (isMissingTableError(e)) {
          return json(res, 503, { ok: false, error: "not_open",
            message: "The operator portal is not open yet — the database table is still being set up." });
        }
        throw e;
      }
    }
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "method not allowed" });
    }
    if (!checkSameOrigin(req)) {
      return json(res, 403, { ok: false, error: "cross-origin requests are not accepted" });
    }
    if (!rateLimit(req, "operator", 10)) {
      return json(res, 429, { ok: false, error: "Too many submissions — please wait a minute." });
    }
    const b = req.body || {};
    const type = clean(b.type, 20);
    if (!TYPES.has(type)) {
      return json(res, 400, { ok: false, error: "type must be register, claim, update, availability or response" });
    }
    const businessName = clean(b.business_name, 200);
    if (businessName.length < 2) {
      return json(res, 400, { ok: false, error: "business_name is required" });
    }
    const contactName = clean(b.contact_name, 120) || null;
    const phone = clean(b.phone, 30) || null;
    const email = clean(b.email, 120) || null;
    if (phone && !PHONE_RE.test(phone)) {
      return json(res, 400, { ok: false, error: "phone number does not look valid" });
    }
    if (email && !EMAIL_RE.test(email)) {
      return json(res, 400, { ok: false, error: "email address does not look valid" });
    }
    const stationId = clean(b.station_id, 40) || null;
    const details = clean(b.details, 2000);
    const proofReference = clean(b.proof_reference, 300) || null;

    // Per-type validation + payload. The payload is the only thing the
    // moderator acts on; contact fields stay in their own columns.
    let payload = {};
    if (type === "register") {
      if (stationId) {
        return json(res, 400, { ok: false, error: "a registration has no station_id — it is a new centre" });
      }
      const address = clean(b.address, 500);
      const state = canonicalState(b.state);
      if (address.length < 10) {
        return json(res, 400, { ok: false, error: "address must describe where the centre is" });
      }
      if (!state) {
        return json(res, 400, { ok: false, error: "state must be a Nigerian state or the FCT" });
      }
      let lat = b.latitude == null || b.latitude === "" ? null : Number(b.latitude);
      let lng = b.longitude == null || b.longitude === "" ? null : Number(b.longitude);
      if (lat != null && (Number.isNaN(lat) || lat < 4.2 || lat > 13.9)) {
        return json(res, 400, { ok: false, error: "latitude must be inside Nigeria (4.2 to 13.9)" });
      }
      if (lng != null && (Number.isNaN(lng) || lng < 2.7 || lng > 14.7)) {
        return json(res, 400, { ok: false, error: "longitude must be inside Nigeria (2.7 to 14.7)" });
      }
      if ((lat == null) !== (lng == null)) {
        return json(res, 400, { ok: false, error: "latitude and longitude go together — send both or neither" });
      }
      payload = {
        address, state,
        services: clean(b.services, 500) || null,
        accreditation_body: clean(b.accreditation_body, 200) || null,
        accreditation_number: clean(b.accreditation_number, 200) || null,
        latitude: lat, longitude: lng,
      };
    } else {
      // claim / update / availability / response — all about one listing.
      if (!stationId) {
        return json(res, 400, { ok: false, error: "station_id is required" });
      }
      if (!isKnownStation(stationId)) {
        return json(res, 400, { ok: false, error: "unknown station_id" });
      }
      if (!phone && !email) {
        return json(res, 400, { ok: false, error: "a phone number or email is required so the moderator can reach you" });
      }
      if (type === "claim") {
        // The ownership check: a documentation reference the moderator
        // verifies by hand (business registration, accreditation
        // certificate, utility bill in the business name, or similar),
        // plus the phone confirmation step in the admin checklist.
        if (!proofReference || proofReference.length < 10) {
          return json(res, 400, { ok: false, error: "proof_reference is required — a business documentation reference the moderator can check (at least 10 characters)" });
        }
        payload = { note: details || null };
      } else if (type === "update") {
        if (details.length < 10) {
          return json(res, 400, { ok: false, error: "details must describe the change you are requesting" });
        }
        payload = { changes: details };
      } else if (type === "availability") {
        const status = clean(b.status, 20);
        if (!STATUSES.has(status)) {
          return json(res, 400, { ok: false, error: "status must be available, low, finished or closed" });
        }
        let queue = b.queue_minutes;
        queue = queue === null || queue === undefined || queue === "" ? null
          : Math.max(0, Math.min(600, Math.floor(Number(queue))));
        if (Number.isNaN(queue)) queue = null;
        const tri = (v) => (v === true ? true : v === false ? false : null);
        payload = { status, queue_minutes: queue, pressure_ok: tri(b.pressure_ok), compressor_ok: tri(b.compressor_ok) };
      } else { // response
        if (details.length < 10) {
          return json(res, 400, { ok: false, error: "details must say what you want the moderator to know" });
        }
        const reportId = clean(b.listing_report_id, 60) || null;
        if (reportId && !UUID_RE.test(reportId)) {
          return json(res, 400, { ok: false, error: "listing_report_id must be a report reference" });
        }
        payload = { message: details, listing_report_id: reportId };
      }
    }

    // Duplicate guard: same type + station (or same business name for a
    // registration) filed within the window returns the first row.
    try {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
      const filter = type === "register"
        ? `&business_name=eq.${encodeURIComponent(businessName)}`
        : `&station_id=eq.${encodeURIComponent(stationId)}`;
      const recent = await sb(
        `operator_submissions?select=id,type,station_id,business_name,status,submitted_at` +
        `&type=eq.${encodeURIComponent(type)}${filter}` +
        `&submitted_at=gte.${encodeURIComponent(since)}&order=submitted_at.desc&limit=1`
      );
      if (recent && recent.length) {
        return json(res, 200, { configured: true, ok: true, id: recent[0].id, duplicate: true });
      }
    } catch (e) {
      if (isMissingTableError(e)) {
        return json(res, 503, { ok: false, error: "not_open",
          message: "The operator portal is not open yet — the database table is still being set up." });
      }
      // The dedupe check must never block a real submission — log and file it.
      console.error("operator dedupe check failed:", String((e && e.message) || e).slice(0, 120));
    }

    const row = {
      type,
      station_id: stationId,
      business_name: businessName,
      contact_name: contactName,
      phone,
      email,
      payload,
      proof_reference: proofReference,
      status: "pending",
      reporter_hash: reporterHash(req),
    };
    try {
      const inserted = await sb("operator_submissions", {
        method: "POST", body: row, prefer: "return=representation",
      });
      return json(res, 200, { configured: true, ok: true, id: (inserted || [])[0]?.id || null });
    } catch (e) {
      if (isMissingTableError(e)) {
        return json(res, 503, { ok: false, error: "not_open",
          message: "The operator portal is not open yet — the database table is still being set up." });
      }
      throw e;
    }
  } catch (e) {
    console.error("operator failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { ok: false, error: "Could not save the submission. Please try again." });
  }
}
