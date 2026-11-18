// POST /api/admin — moderation of listing reports.
// Passcode-gated: every call needs header X-Admin-Passcode matching
// env ADMIN_PASSCODE (default "findcng-admin" — change it, see README).
//
// Body: { action: "list_listing_reports", status?: "open"|"resolved"|"dismissed"|"all" }
//       { action: "resolve_listing_report", id, note? }
//       { action: "dismiss_listing_report", id, note? }
//
// Listing-report actions answer { ok: false, error: "not_open" } until
// sql/001_listing_reports_and_confirmations.sql has been run.
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
    return json(res, 500, { ok: false, error: "Could not reach the database. " + String(e.message || e).slice(0, 160) });
  }
}
