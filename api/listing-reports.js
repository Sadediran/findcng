// POST /api/listing-reports — flag a directory entry as wrong, closed or
//      moved. Body: { station_id, report_type, details? } where report_type
//      is incorrect | closed | moved | other.
// No account, no identity. Reports land in listing_reports with status
// "open" for the moderator (see api/admin.js list_listing_reports).
// If the listing_reports table does not exist yet (sql/001 not run), the
// route answers { ok: false, error: "not_open" } — the app shows
// "Listing reports aren't open yet" instead of crashing or silently
// dropping the report.
import { json, sb, supabaseConfigured, reporterHash, rateLimit, isMissingTableError, isKnownStation } from "./_lib.js";

const TYPES = new Set(["incorrect", "closed", "moved", "other"]);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false, error: "not_open" });
  }
  try {
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
    if (!isKnownStation(stationId)) {
      return json(res, 400, { ok: false, error: "unknown station_id" });
    }
    if (!TYPES.has(type)) {
      return json(res, 400, { ok: false, error: "report_type must be incorrect, closed, moved or other" });
    }
    const row = {
      station_id: stationId,
      report_type: type,
      details: details || null,
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
