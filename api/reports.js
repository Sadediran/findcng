// GET  /api/reports — recent availability reports (last 3 hours; the client
//      filters to the 2-hour live window). The id column is included so the
//      client can attach one-tap confirmations to a specific report.
//      GET /api/reports?station=CNG-XXX — that station's reports from the
//      last 30 days (for the reliability indicator; "no history yet" when
//      there are none — the client never fakes history).
// POST /api/reports — file a report. Body: { station_id, status,
//      queue_minutes?, pressure_ok?, compressor_ok? }.
// No account, no identity. If Supabase is not configured the routes answer
// { configured: false } and the app shows an honest error (no silent
// on-device saving — a report the user thinks is shared must be shared).
import { json, sb, supabaseConfigured, reporterHash, rateLimit } from "./_lib.js";

const STATUSES = new Set(["available", "low", "finished", "closed"]);

export default async function handler(req, res) {
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, reports: [] });
  }
  try {
    if (req.method === "GET") {
      const station = String(req.query.station || "").trim();
      if (station) {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const rows = await sb(
          `availability_reports?select=id,station_id,status,queue_minutes,reported_at` +
          `&station_id=eq.${encodeURIComponent(station)}&reported_at=gte.${encodeURIComponent(since)}` +
          `&order=reported_at.desc&limit=500`
        );
        return json(res, 200, { configured: true, reports: rows || [] });
      }
      const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const rows = await sb(
        `availability_reports?select=id,station_id,status,queue_minutes,pressure_ok,compressor_ok,reported_at` +
        `&reported_at=gte.${encodeURIComponent(since)}&order=reported_at.desc&limit=2000`
      );
      return json(res, 200, { configured: true, reports: rows || [] });
    }
    if (req.method === "POST") {
      if (!rateLimit(req, "reports")) {
        return json(res, 429, { ok: false, error: "Too many reports — please wait a minute." });
      }
      const body = req.body || {};
      const stationId = String(body.station_id || "").trim();
      const status = String(body.status || "").trim();
      if (!stationId || stationId.length > 40) {
        return json(res, 400, { ok: false, error: "station_id is required" });
      }
      if (!STATUSES.has(status)) {
        return json(res, 400, { ok: false, error: "status must be available, low, finished or closed" });
      }
      let queue = body.queue_minutes;
      queue = queue === null || queue === undefined || queue === "" ? null
        : Math.max(0, Math.min(600, Math.floor(Number(queue))));
      if (Number.isNaN(queue)) queue = null;
      const tri = (v) => (v === true ? true : v === false ? false : null);
      const row = {
        station_id: stationId,
        status,
        queue_minutes: queue,
        pressure_ok: tri(body.pressure_ok),
        compressor_ok: tri(body.compressor_ok),
        reporter_hash: reporterHash(req),
      };
      const inserted = await sb("availability_reports", {
        method: "POST", body: row, prefer: "return=representation",
      });
      return json(res, 200, { configured: true, ok: true, report: (inserted || [])[0] || null });
    }
    return json(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Could not reach the database. " + String(e.message || e).slice(0, 160) });
  }
}
