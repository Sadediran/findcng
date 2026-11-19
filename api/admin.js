// POST /api/admin — moderation of listing reports + availability reports.
// Passcode-gated: every call needs header X-Admin-Passcode matching
// env ADMIN_PASSCODE. No default: when the env var is unset, no passcode
// is accepted (fail closed — see api/_lib.js).
//
// Body: { action: "list_listing_reports", status?: "open"|"resolved"|"dismissed"|"all" }
//       { action: "resolve_listing_report", id, note? }
//       { action: "dismiss_listing_report", id, note? }
//       { action: "delete_listing_report", id }          — hard delete (spam / test rows)
//       { action: "list_availability_reports" }          — recent reports + burst flags
//       { action: "delete_availability_report", id }     — remove an abusive report
//
// Listing-report actions answer { ok: false, error: "not_open" } until
// sql/001_listing_reports_and_confirmations.sql has been run.
// Availability actions need only the availability_reports table
// (supabase/schema.sql). Reporter hashes are returned truncated to 8
// characters — enough for a moderator to spot a pattern, never enough
// to identify anyone.
//
// NOTE (2.5, 18 Nov 2026): the centre-submission half of this route
// (list / approve / reject / certificate, over centre_submissions) was
// removed when centre self-registration was reversed. The
// centre_submissions table is left dormant in Supabase; nothing here
// reads or writes it.
import { json, sb, supabaseConfigured, checkAdminPasscode, rateLimit, isMissingTableError } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  if (!checkAdminPasscode(req)) {
    return json(res, 401, { ok: false, error: "wrong passcode" });
  }
  if (!supabaseConfigured) {
    return json(res, 200, { configured: false, ok: false, error: "Database is not connected yet." });
  }
  try {
    if (!rateLimit(req, "admin", 60)) {
      return json(res, 429, { ok: false, error: "Too many requests — please wait a minute." });
    }
    const b = req.body || {};
    const action = String(b.action || "");
    const id = String(b.id || "").trim();

    if (action === "list_listing_reports") {
      const status = String(b.status || "open");
      const filter = status === "all" ? "" : `&status=eq.${encodeURIComponent(status)}`;
      try {
        const rows = await sb(
          `listing_reports?select=*&order=reported_at.desc&limit=200${filter}`
        );
        return json(res, 200, { configured: true, ok: true, reports: rows || [] });
      } catch (e) {
        if (isMissingTableError(e)) {
          return json(res, 200, { configured: true, ok: false, error: "not_open",
            message: "Listing reports are not open yet — run sql/001_listing_reports_and_confirmations.sql in Supabase." });
        }
        throw e;
      }
    }

    if (action === "delete_listing_report") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      try {
        await sb(`listing_reports?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
        return json(res, 200, { configured: true, ok: true, deleted: id });
      } catch (e) {
        if (isMissingTableError(e)) {
          return json(res, 200, { configured: true, ok: false, error: "not_open" });
        }
        throw e;
      }
    }

    // Availability moderation (Phase 3, §§8/14): the recent report
    // history for authorised moderation. Each row carries a truncated
    // reporter hash, and hashes with 5+ reports in the last hour are
    // flagged as a burst so a flood is visible at a glance. The burst
    // threshold here (5/hour) is lower than the POST guard (6/10 min)
    // on purpose — moderation sees patterns the guard tolerates.
    if (action === "list_availability_reports") {
      const rows = await sb(
        `availability_reports?select=id,station_id,status,queue_minutes,pressure_ok,compressor_ok,reported_at,reporter_hash` +
        `&order=reported_at.desc&limit=200`
      );
      const hourAgo = Date.now() - 60 * 60 * 1000;
      const counts = {};
      (rows || []).forEach((r) => {
        if (r.reporter_hash && new Date(r.reported_at).getTime() >= hourAgo) {
          counts[r.reporter_hash] = (counts[r.reporter_hash] || 0) + 1;
        }
      });
      const flagged = new Set(Object.entries(counts)
        .filter(([, n]) => n >= 5).map(([h]) => h));
      const out = (rows || []).map((r) => ({
        id: r.id,
        station_id: r.station_id,
        status: r.status,
        queue_minutes: r.queue_minutes,
        pressure_ok: r.pressure_ok,
        compressor_ok: r.compressor_ok,
        reported_at: r.reported_at,
        reporter: r.reporter_hash ? String(r.reporter_hash).slice(0, 8) : null,
        burst: flagged.has(r.reporter_hash),
      }));
      return json(res, 200, { configured: true, ok: true, reports: out });
    }

    if (action === "delete_availability_report") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      await sb(`availability_reports?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return json(res, 200, { configured: true, ok: true, deleted: id });
    }

    if (action === "resolve_listing_report" || action === "dismiss_listing_report") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      const note = String(b.note || "").trim().slice(0, 300);
      const newStatus = action === "resolve_listing_report" ? "resolved" : "dismissed";
      try {
        const updated = await sb(`listing_reports?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { status: newStatus, reviewed_at: new Date().toISOString(),
            reviewed_by: "moderator", resolution_note: note || null },
          prefer: "return=representation",
        });
        if (!updated || !updated.length) return json(res, 404, { ok: false, error: "listing report not found" });
        return json(res, 200, { configured: true, ok: true, report: updated[0] });
      } catch (e) {
        if (isMissingTableError(e)) {
          return json(res, 200, { configured: true, ok: false, error: "not_open" });
        }
        throw e;
      }
    }

    return json(res, 400, { ok: false, error: "unknown action" });
  } catch (e) {
    console.error("admin failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { ok: false, error: "Could not reach the database. Please try again." });
  }
}
