// GET  /api/confirmations?report_id=<uuid> — vote counts for one report.
// POST /api/confirmations — one-tap confirm on a live report.
//      Body: { report_id, station_id, vote } where vote is yes | unsure | no.
// One vote per report per reporter per day (enforced by a unique index).
// If the report_confirmations table does not exist yet (sql/001 not run),
// both routes answer { ok: false, error: "not_open" } — the app shows
// "Confirmations aren't open yet" instead of crashing.
import { json, sb, supabaseConfigured, reporterHash, rateLimit, isMissingTableError } from "./_lib.js";

const VOTES = new Set(["yes", "unsure", "no"]);

export default async function handler(req, res) {
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false, error: "not_open" });
  }
  try {
    if (req.method === "GET") {
      const reportId = String(req.query.report_id || "").trim();
      if (!reportId) return json(res, 400, { ok: false, error: "report_id is required" });
      const rows = await sb(
        `report_confirmations?select=vote&report_id=eq.${encodeURIComponent(reportId)}&limit=1000`
      );
      const counts = { yes: 0, unsure: 0, no: 0 };
      (rows || []).forEach((r) => { if (VOTES.has(r.vote)) counts[r.vote]++; });
      return json(res, 200, { configured: true, ok: true, counts });
    }
    if (req.method === "POST") {
      if (!rateLimit(req, "confirmations", 60)) {
        return json(res, 429, { ok: false, error: "Too many confirmations — please wait a minute." });
      }
      const body = req.body || {};
      const reportId = String(body.report_id || "").trim();
      const stationId = String(body.station_id || "").trim();
      const vote = String(body.vote || "").trim();
      if (!reportId || reportId.length > 60) {
        return json(res, 400, { ok: false, error: "report_id is required" });
      }
      if (!stationId || stationId.length > 40) {
        return json(res, 400, { ok: false, error: "station_id is required" });
      }
      if (!VOTES.has(vote)) {
        return json(res, 400, { ok: false, error: "vote must be yes, unsure or no" });
      }
      const row = {
        report_id: reportId,
        station_id: stationId,
        vote,
        reporter_hash: reporterHash(req),
      };
      try {
        await sb("report_confirmations", { method: "POST", body: row, prefer: "return=minimal" });
      } catch (e) {
        if (isMissingTableError(e)) {
          return json(res, 503, { ok: false, error: "not_open",
            message: "Confirmations are not open yet — the database table is still being set up." });
        }
        // Duplicate vote (same reporter, same report): update the vote instead.
        if (e.code === "23505") {
          await sb(`report_confirmations?report_id=eq.${encodeURIComponent(reportId)}` +
            `&reporter_hash=eq.${encodeURIComponent(row.reporter_hash)}`, {
            method: "PATCH", body: { vote, confirmed_at: new Date().toISOString() },
            prefer: "return=minimal",
          });
        } else {
          throw e;
        }
      }
      const rows = await sb(
        `report_confirmations?select=vote&report_id=eq.${encodeURIComponent(reportId)}&limit=1000`
      );
      const counts = { yes: 0, unsure: 0, no: 0 };
      (rows || []).forEach((r) => { if (VOTES.has(r.vote)) counts[r.vote]++; });
      return json(res, 200, { configured: true, ok: true, counts });
    }
    return json(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    if (isMissingTableError(e)) {
      return json(res, 503, { ok: false, error: "not_open",
        message: "Confirmations are not open yet — the database table is still being set up." });
    }
    return json(res, 500, { ok: false, error: "Could not reach the database. " + String(e.message || e).slice(0, 160) });
  }
}
