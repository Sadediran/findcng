// POST /api/listing-reports — flag a directory entry, or suggest a
//      missing station. Body: { station_id, report_type, details? }.
//      report_type is one of:
//        incorrect  — name / address / phone wrong
//        coordinates — the map pin (or the location) is wrong
//        contact    — updated phone / contact details for the listing
//        closed     — closed for good
//        moved      — moved to a different address
//        safety     — a safety concern about this place
//        missing    — suggest a station/centre that is not listed yet
//                     (station_id is the literal string "NEW"; details
//                     must name the place, its address and its state)
//        other      — anything else
//      The listing_reports table (sql/001) only allows the four original
//      types, so the newer types are stored under the closest original
//      type with a machine-readable tag at the start of `details`
//      ("[Wrong coordinates] ", "[Updated contact] ", "[Safety concern] ",
//      "[Missing station] "). The admin queue renders the tag back as the
//      type. No migration is needed, and no report is ever lost because
//      of a CHECK constraint.
// GET  /api/listing-reports?id=<uuid> — submission tracking (Phase 3,
//      §14): the submitter checks their report's status with the
//      reference the app showed them. Returns public fields only —
//      reporter_hash is NEVER exposed.
// No account, no identity. Reports land in listing_reports with status
// "open" for the moderator (see api/admin.js). If the listing_reports
// table does not exist yet (sql/001 not run), the routes answer
// { ok: false, error: "not_open" } — the app shows "not open yet"
// instead of crashing or silently dropping the report.
import { json, sb, supabaseConfigured, reporterHash, rateLimit, isMissingTableError, isKnownStation } from "./_lib.js";

// UI type -> { db type, details tag }. Types without a tag are stored
// as-is (they are the four the table's CHECK constraint allows).
const TYPES = {
  incorrect:   { db: "incorrect", tag: null },
  coordinates: { db: "incorrect", tag: "[Wrong coordinates] " },
  contact:     { db: "incorrect", tag: "[Updated contact] " },
  closed:      { db: "closed",    tag: null },
  moved:       { db: "moved",     tag: null },
  safety:      { db: "other",     tag: "[Safety concern] " },
  missing:     { db: "other",     tag: "[Missing station] " },
  other:       { db: "other",     tag: null },
};
// Same station + same stored type within this window is a duplicate
// (double-tap, retry storm) — return the existing report instead of
// inserting another row. Reporter-agnostic, like the availability
// dedupe: two different people flagging the same wrong listing within
// 10 minutes carry no new information, and the first report stands.
// Missing-station suggestions are never deduped (each one is a
// different place).
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false, error: "not_open" });
  }
  try {
    // --- Status check (submission tracking) ---------------------------
    if (req.method === "GET") {
      if (!rateLimit(req, "listing-reports-get", 60)) {
        return json(res, 429, { ok: false, error: "Too many checks — please wait a minute." });
      }
      const id = String(req.query.id || "").trim();
      if (!id || id.length > 60) {
        return json(res, 400, { ok: false, error: "id is required" });
      }
      const rows = await sb(
        `listing_reports?select=id,station_id,report_type,details,status,reported_at,reviewed_at,resolution_note` +
        `&id=eq.${encodeURIComponent(id)}&limit=1`
      );
      if (!rows || !rows.length) {
        return json(res, 404, { ok: false, error: "report not found" });
      }
      return json(res, 200, { configured: true, ok: true, report: rows[0] });
    }
    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: "method not allowed" });
    }
    if (!rateLimit(req, "listing-reports", 20)) {
      return json(res, 429, { ok: false, error: "Too many reports — please wait a minute." });
    }
    const body = req.body || {};
    const stationId = String(body.station_id || "").trim();
    const type = String(body.report_type || "").trim();
    const details = String(body.details || "").trim().slice(0, 1000);
    if (!stationId || stationId.length > 40) {
      return json(res, 400, { ok: false, error: "station_id is required" });
    }
    const mapped = TYPES[type];
    if (!mapped) {
      return json(res, 400, { ok: false, error: "report_type must be incorrect, coordinates, contact, closed, moved, safety, missing or other" });
    }
    if (type === "missing") {
      // A missing station has no listing id — the client sends "NEW".
      // Details must actually describe the place, or the moderator
      // cannot act on it.
      if (stationId !== "NEW") {
        return json(res, 400, { ok: false, error: "a missing-station suggestion uses station_id NEW" });
      }
      if (details.length < 10) {
        return json(res, 400, { ok: false, error: "details must name the station, its address and its state" });
      }
    } else {
      if (stationId === "NEW") {
        return json(res, 400, { ok: false, error: "station_id NEW is only for missing-station suggestions" });
      }
      if (!isKnownStation(stationId)) {
        return json(res, 400, { ok: false, error: "unknown station_id" });
      }
    }
    const storedDetails = (mapped.tag || "") + details;
    // Duplicate guard (station-bound types only): the same station +
    // same stored type filed within the window returns the first row.
    if (type !== "missing") {
      try {
        const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
        const recent = await sb(
          `listing_reports?select=id,station_id,report_type,details,status,reported_at` +
          `&station_id=eq.${encodeURIComponent(stationId)}&report_type=eq.${encodeURIComponent(mapped.db)}` +
          `&reported_at=gte.${encodeURIComponent(since)}&order=reported_at.desc&limit=1`
        );
        if (recent && recent.length) {
          return json(res, 200, { configured: true, ok: true, id: recent[0].id, duplicate: true });
        }
      } catch (e) {
        // The dedupe check must never block a real report — log and file it.
        console.error("listing-reports dedupe check failed:", String((e && e.message) || e).slice(0, 120));
      }
    }
    const row = {
      station_id: stationId,
      report_type: mapped.db,
      details: storedDetails || null,
      reporter_hash: reporterHash(req),
      status: "open",
    };
    const inserted = await sb("listing_reports", {
      method: "POST", body: row, prefer: "return=representation",
    });
    return json(res, 200, { configured: true, ok: true, id: (inserted || [])[0]?.id || null });
  } catch (e) {
    if (isMissingTableError(e)) {
      return json(res, 503, { ok: false, error: "not_open",
        message: "Listing reports are not open yet — the database table is still being set up." });
    }
    console.error("listing-reports failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { ok: false, error: "Could not save the report. Please try again." });
  }
}
