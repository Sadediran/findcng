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
import { json, sb, supabaseConfigured, reporterHash, rateLimit, isKnownStation } from "./_lib.js";

const STATUSES = new Set(["available", "low", "finished", "closed"]);
// Same station + same status within this window is a duplicate
// (double-tap, retry storm) — return the latest report instead of
// inserting another row. A changed status always files fresh, so a
// "Back to normal" after a "finished" is never suppressed.
// NOTE (19 Nov 2026): the window is deliberately reporter-agnostic.
// The first version keyed on reporter_hash (IP + UA + day), but the
// hash is unstable in practice — the VM's egress proxy rotates its
// outbound IP per request, and mobile networks renumber too — so the
// hash version never matched a second tap. Same station + same status
// within 2 minutes carries no new information anyway: the visible
// state is identical, and the reporter can re-file after the window.
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
// Suspicious-pattern guard (Phase 3, §8): one reporter filing reports
// for many stations in a few minutes is not a driver at a station — it
// is a script or a prank. 6+ reports from one reporter hash in 10
// minutes is refused. The threshold is deliberately high (a real driver
// reports one station, maybe two), and the check is best-effort: the
// hash is IP-based, so a flood from rotating IPs still gets through —
// the admin availability queue (api/admin.js) is the backstop, where a
// moderator can see the pattern and delete the rows.
const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_MAX_REPORTS = 6;

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
      // Phase 1: reject reports for stations that do not exist — fake ids
      // used to be accepted and stored. (LIVE- ids are not in the file:
      // the app never files reports for live entries, so this matches.)
      if (!isKnownStation(stationId)) {
        return json(res, 400, { ok: false, error: "unknown station_id" });
      }
      let queue = body.queue_minutes;
      queue = queue === null || queue === undefined || queue === "" ? null
        : Math.max(0, Math.min(600, Math.floor(Number(queue))));
      if (Number.isNaN(queue)) queue = null;
      const tri = (v) => (v === true ? true : v === false ? false : null);
      const hash = reporterHash(req);
      // Duplicate guard: the latest report for this station is the same
      // status and less than 2 minutes old — the first report stands,
      // no second row is written.
      try {
        const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
        const recent = await sb(
          `availability_reports?select=id,status,reported_at&station_id=eq.${encodeURIComponent(stationId)}` +
          `&reported_at=gte.${encodeURIComponent(since)}` +
          `&order=reported_at.desc&limit=1`
        );
        if (recent && recent.length && recent[0].status === status) {
          return json(res, 200, { configured: true, ok: true, report: recent[0], duplicate: true });
        }
      } catch (e) {
        // The dedupe check must never block a real report — log and file it.
        console.error("reports dedupe check failed:", String((e && e.message) || e).slice(0, 120));
      }
      // Burst guard: refuse when this reporter has already filed
      // BURST_MAX_REPORTS in the window. A failure here must never block
      // a real report — log and continue.
      try {
        const sinceBurst = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
        const burst = await sb(
          `availability_reports?select=id&reporter_hash=eq.${encodeURIComponent(hash)}` +
          `&reported_at=gte.${encodeURIComponent(sinceBurst)}&limit=${BURST_MAX_REPORTS + 1}`
        );
        if (burst && burst.length > BURST_MAX_REPORTS) {
          console.error("reports burst guard: reporter filed", burst.length,
            "reports in 10 min — refusing");
          return json(res, 429, { ok: false, error: "Too many reports in a short time — please wait a few minutes." });
        }
      } catch (e) {
        console.error("reports burst check failed:", String((e && e.message) || e).slice(0, 120));
      }
      const row = {
        station_id: stationId,
        status,
        queue_minutes: queue,
        pressure_ok: tri(body.pressure_ok),
        compressor_ok: tri(body.compressor_ok),
        reporter_hash: hash,
      };
      const inserted = await sb("availability_reports", {
        method: "POST", body: row, prefer: "return=representation",
      });
      return json(res, 200, { configured: true, ok: true, report: (inserted || [])[0] || null });
    }
    return json(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    // Generic message to the caller — Supabase errors can leak schema
    // details (table/constraint names). The real cause goes to the logs.
    console.error("reports failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { ok: false, error: "Could not reach the database. Please try again." });
  }
}
