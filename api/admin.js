// POST /api/admin — moderation of the centre-submission queue.
// Passcode-gated: every call needs header X-Admin-Passcode matching
// env ADMIN_PASSCODE (default "findcng-admin" — change it, see README).
//
// Body: { action: "list", status?: "pending"|"approved"|"rejected"|"all" }
//       { action: "approve", id }
//       { action: "reject", id, reason }
//       { action: "certificate", id }  -> short-lived signed URL (1h)
//       { action: "list_listing_reports", status?: "open"|"resolved"|"dismissed"|"all" }
//       { action: "resolve_listing_report", id, note? }
//       { action: "dismiss_listing_report", id, note? }
//
// Approve sets status + verification_date (today) — the centre then
// appears in /api/centres and in the public directory with its badge.
// Listing-report actions answer { ok: false, error: "not_open" } until
// sql/001_listing_reports_and_confirmations.sql has been run.
import { json, sb, sbSignedUrl, supabaseConfigured, checkAdminPasscode, rateLimit, isMissingTableError } from "./_lib.js";

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

    if (action === "list") {
      const status = String(b.status || "pending");
      const filter = status === "all" ? "" : `&status=eq.${encodeURIComponent(status)}`;
      const rows = await sb(
        `centre_submissions?select=*&order=submitted_at.desc&limit=200${filter}`
      );
      return json(res, 200, { configured: true, ok: true, submissions: rows || [] });
    }

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

    if (!id) return json(res, 400, { ok: false, error: "id is required" });
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    if (action === "approve") {
      const updated = await sb(`centre_submissions?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { status: "approved", reviewed_at: now, reviewed_by: "moderator", verification_date: today, decision_reason: null },
        prefer: "return=representation",
      });
      if (!updated || !updated.length) return json(res, 404, { ok: false, error: "submission not found" });
      return json(res, 200, { configured: true, ok: true, submission: updated[0] });
    }

    if (action === "reject") {
      const reason = String(b.reason || "").trim().slice(0, 300);
      if (!reason) return json(res, 400, { ok: false, error: "A reason is required so the centre can fix it and re-apply." });
      const updated = await sb(`centre_submissions?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { status: "rejected", reviewed_at: now, reviewed_by: "moderator", decision_reason: reason, verification_date: null },
        prefer: "return=representation",
      });
      if (!updated || !updated.length) return json(res, 404, { ok: false, error: "submission not found" });
      return json(res, 200, { configured: true, ok: true, submission: updated[0] });
    }

    if (action === "certificate") {
      const rows = await sb(`centre_submissions?select=certificate_path&id=eq.${encodeURIComponent(id)}`);
      const path = rows?.[0]?.certificate_path;
      if (!path) return json(res, 404, { ok: false, error: "no certificate on file" });
      const url = await sbSignedUrl("certificates", path, 3600);
      return json(res, 200, { configured: true, ok: true, url });
    }

    return json(res, 400, { ok: false, error: "unknown action" });
  } catch (e) {
    return json(res, 500, { ok: false, error: "Could not reach the database. " + String(e.message || e).slice(0, 160) });
  }
}
