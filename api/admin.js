// POST /api/admin — FindCNG admin dashboard API (Phase 4, §16).
// Role-gated: every call needs header X-Admin-Passcode matching one of
// the role passcodes in env (see api/_lib.js adminRole). No default:
// a role whose env var is unset does not exist (fail closed).
//
// Roles and what each may do (enforced here, not just in the UI):
//   super_admin — everything below.
//   data_admin  — listing reports (list/resolve/dismiss/delete),
//                 availability moderation (list/delete), data quality,
//                 duplicates, accreditation review (read), operator
//                 queue (read), audit log (read), analytics (read).
//   verifier    — operator queue (list/approve/reject),
//                 accreditation review (read), availability moderation
//                 (list/delete), listing reports (read), audit log
//                 (read), analytics (read).
// Content editor and support administrator (§16) are not shipped: this
// stack has no content-editing or support-ticket surface, so those
// roles would be labels with no function. Documented as pending.
//
// Actions:
//   whoami                       — { role } for the caller's passcode
//   list_listing_reports         — status?: open|resolved|dismissed|all
//   resolve_listing_report       — { id, note? }
//   dismiss_listing_report       — { id, note? }
//   delete_listing_report        — { id } (spam / test rows only)
//   list_availability_reports    — recent reports + burst flags
//   delete_availability_report   — { id }
//   list_operator_submissions    — status?: pending|approved|rejected|all
//   review_operator_submission   — { id, decision: approve|reject,
//                                    note?, verification? } — approval
//                                    of an "availability" submission
//                                    publishes an availability report
//                                    with source 'operator'; approval
//                                    of any other type records the
//                                    decision only (the directory is
//                                    static data — the moderator applies
//                                    data changes in the master dataset
//                                    and rebuilds, as with listing
//                                    reports). Rejection never publishes.
//   delete_operator_submission   — { id } (spam / test rows only)
//   list_audit_log               — recent admin actions (super_admin +
//                                  data_admin + verifier may read)
//   analytics                    — real counts only, computed live
//   postcode_status              — NIPOST mode + key presence (the key
//                                  itself is NEVER returned)
//   duplicates                   — same-coordinate exact-pin groups
//                                  computed from data/stations.json
//   data_quality                 — completeness counts from the dataset
//   accreditation_review         — centres needing re-verification
//
// Every mutating action is written to audit_log (best-effort — the
// table exists only after sql/003 is run; a failed audit insert never
// blocks the action). Listing-report actions answer
// { ok: false, error: "not_open" } until sql/001 has been run;
// operator and audit-log actions answer "not_open" until sql/003.
// Reporter hashes are returned truncated to 8 characters.
// Operator contact details (phone, email) are returned ONLY to admin
// roles — never by any public endpoint.
import { json, sb, supabaseConfigured, adminRole, audit, rateLimit, isMissingTableError, loadStations, checkSameOrigin } from "./_lib.js";
import { readFileSync } from "node:fs";

// --- Permission matrix ----------------------------------------------------
// action -> roles allowed. "all" = every authenticated role.
const ROLE_ACTIONS = {
  whoami: ["super_admin", "data_admin", "verifier"],
  list_listing_reports: ["super_admin", "data_admin", "verifier"],
  resolve_listing_report: ["super_admin", "data_admin"],
  dismiss_listing_report: ["super_admin", "data_admin"],
  delete_listing_report: ["super_admin", "data_admin"],
  list_availability_reports: ["super_admin", "data_admin", "verifier"],
  delete_availability_report: ["super_admin", "data_admin", "verifier"],
  list_operator_submissions: ["super_admin", "data_admin", "verifier"],
  review_operator_submission: ["super_admin", "verifier"],
  delete_operator_submission: ["super_admin"],
  list_audit_log: ["super_admin", "data_admin", "verifier"],
  analytics: ["super_admin", "data_admin", "verifier"],
  postcode_status: ["super_admin", "data_admin", "verifier"],
  duplicates: ["super_admin", "data_admin", "verifier"],
  data_quality: ["super_admin", "data_admin", "verifier"],
  accreditation_review: ["super_admin", "data_admin", "verifier"],
};

// The timestamp on availability rows is `reported_at` (there is no
// created_at column on availability_reports — the Phase 3 note about
// "created_at: null" was a consumer looking for a field that does not
// exist; reported_at is the field and it is always populated).

function notOpen(res, what) {
  return json(res, 200, { configured: true, ok: false, error: "not_open",
    message: `${what} — run the SQL migration in Supabase first.` });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "method not allowed" });
  }
  const role = adminRole(req);
  if (!role) {
    return json(res, 401, { ok: false, error: "wrong passcode" });
  }
  if (!checkSameOrigin(req)) {
    return json(res, 403, { ok: false, error: "cross-origin requests are not accepted" });
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

    if (!ROLE_ACTIONS[action]) {
      return json(res, 400, { ok: false, error: "unknown action" });
    }
    if (!ROLE_ACTIONS[action].includes(role)) {
      return json(res, 403, { ok: false, error: `role ${role} may not perform ${action}` });
    }

    if (action === "whoami") {
      return json(res, 200, { configured: true, ok: true, role });
    }

    // ---- Listing reports -------------------------------------------------
    if (action === "list_listing_reports") {
      const status = String(b.status || "open");
      const filter = status === "all" ? "" : `&status=eq.${encodeURIComponent(status)}`;
      try {
        const rows = await sb(
          `listing_reports?select=*&order=reported_at.desc&limit=200${filter}`
        );
        return json(res, 200, { configured: true, ok: true, reports: rows || [] });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "Listing reports are not open yet (sql/001)");
        throw e;
      }
    }

    if (action === "delete_listing_report") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      try {
        await sb(`listing_reports?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
        await audit(role, "delete_listing_report", "listing_report", id, "spam/test row deleted");
        return json(res, 200, { configured: true, ok: true, deleted: id });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "Listing reports are not open yet (sql/001)");
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
            reviewed_by: role, resolution_note: note || null },
          prefer: "return=representation",
        });
        if (!updated || !updated.length) return json(res, 404, { ok: false, error: "listing report not found" });
        await audit(role, action, "listing_report", id, note || "");
        return json(res, 200, { configured: true, ok: true, report: updated[0] });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "Listing reports are not open yet (sql/001)");
        throw e;
      }
    }

    // ---- Availability moderation -----------------------------------------
    // Recent history for authorised moderation. Each row carries a
    // truncated reporter hash, and hashes with 5+ reports in the last
    // hour are flagged as a burst so a flood is visible at a glance.
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
      await audit(role, "delete_availability_report", "availability_report", id, "report deleted by moderator");
      return json(res, 200, { configured: true, ok: true, deleted: id });
    }

    // ---- Operator submissions --------------------------------------------
    if (action === "list_operator_submissions") {
      const status = String(b.status || "pending");
      const filter = status === "all" ? "" : `&status=eq.${encodeURIComponent(status)}`;
      try {
        const rows = await sb(
          `operator_submissions?select=*&order=submitted_at.desc&limit=200${filter}`
        );
        return json(res, 200, { configured: true, ok: true, submissions: rows || [] });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "The operator portal is not open yet (sql/003)");
        throw e;
      }
    }

    if (action === "delete_operator_submission") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      try {
        await sb(`operator_submissions?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
        await audit(role, "delete_operator_submission", "operator_submission", id, "spam/test row deleted");
        return json(res, 200, { configured: true, ok: true, deleted: id });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "The operator portal is not open yet (sql/003)");
        throw e;
      }
    }

    // The review decision. Approve = this exact submission is accepted;
    // reject = it is refused and nothing is published. Approval of an
    // "availability" submission publishes one availability report with
    // source 'operator' — the ONLY way an operator-confirmed report
    // exists. Approval of register/claim/update/response records the
    // decision; the directory itself is static data, so the moderator
    // applies any data change in the master dataset and rebuilds (the
    // admin UI says this next to the button). The verification checklist
    // the moderator completes is stored in verification_notes — it is a
    // manual attestation, honestly labelled as such.
    if (action === "review_operator_submission") {
      if (!id) return json(res, 400, { ok: false, error: "id is required" });
      const decision = String(b.decision || "").trim();
      if (decision !== "approve" && decision !== "reject") {
        return json(res, 400, { ok: false, error: "decision must be approve or reject" });
      }
      const note = String(b.note || "").trim().slice(0, 300);
      const verification = String(b.verification || "").trim().slice(0, 500);
      try {
        const rows = await sb(`operator_submissions?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
        const sub = (rows || [])[0];
        if (!sub) return json(res, 404, { ok: false, error: "operator submission not found" });
        if (sub.status !== "pending") {
          return json(res, 409, { ok: false, error: `submission already ${sub.status}` });
        }
        const newStatus = decision === "approve" ? "approved" : "rejected";
        let publishedReportId = null;
        if (decision === "approve" && sub.type === "availability") {
          const p = sub.payload || {};
          if (!p.status || !["available", "low", "finished", "closed"].includes(p.status)) {
            return json(res, 400, { ok: false, error: "this availability submission has no valid status — reject it instead" });
          }
          // Insert with source 'operator'. If the source column does not
          // exist yet (sql/003 not fully run), the insert fails with a
          // missing-column error — the submission stays pending and the
          // moderator is told to run the migration, rather than the
          // report being published as community by mistake.
          try {
            const inserted = await sb("availability_reports", {
              method: "POST",
              body: {
                station_id: sub.station_id,
                status: p.status,
                queue_minutes: p.queue_minutes == null ? null : p.queue_minutes,
                pressure_ok: p.pressure_ok == null ? null : p.pressure_ok,
                compressor_ok: p.compressor_ok == null ? null : p.compressor_ok,
                reporter_hash: null,
                source: "operator",
              },
              prefer: "return=representation",
            });
            publishedReportId = (inserted || [])[0]?.id || null;
          } catch (e2) {
            if (e2.code === "PGRST204" || /Could not find the 'source' column/i.test(String(e2.message || ""))) {
              return json(res, 503, { ok: false, error: "not_open",
                message: "Operator availability needs the source column — run sql/003 in Supabase first. The submission stays pending." });
            }
            throw e2;
          }
        }
        const updated = await sb(`operator_submissions?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: { status: newStatus, reviewed_at: new Date().toISOString(),
            reviewed_by: role, decision_reason: note || null,
            verification_notes: verification || null },
          prefer: "return=representation",
        });
        await audit(role, `operator_${decision}`, "operator_submission", id,
          `${sub.type}${sub.station_id ? " " + sub.station_id : ""} — ${sub.business_name}` +
          (publishedReportId ? ` — published availability report ${publishedReportId}` : "") +
          (note ? ` — ${note}` : ""));
        return json(res, 200, { configured: true, ok: true, submission: (updated || [])[0] || null,
          published_report_id: publishedReportId });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "The operator portal is not open yet (sql/003)");
        throw e;
      }
    }

    // ---- Audit log -------------------------------------------------------
    if (action === "list_audit_log") {
      try {
        const rows = await sb(`audit_log?select=*&order=created_at.desc&limit=200`);
        return json(res, 200, { configured: true, ok: true, entries: rows || [] });
      } catch (e) {
        if (isMissingTableError(e)) return notOpen(res, "The audit log is not open yet (sql/003)");
        throw e;
      }
    }

    // ---- Analytics (real counts only) ------------------------------------
    // Every figure is counted live from the database or the dataset.
    // Tables that do not exist yet report 0 with not_open flags — never
    // a guessed number.
    if (action === "analytics") {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const hour2Ago = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const out = { generated_at: new Date().toISOString(), not_open: [] };
      async function count(table, filter) {
        try {
          const rows = await sb(`${table}?select=id${filter || ""}&limit=10000`);
          return Array.isArray(rows) ? rows.length : 0;
        } catch (e) {
          if (isMissingTableError(e)) { out.not_open.push(table); return 0; }
          throw e;
        }
      }
      out.reports_24h = await count("availability_reports", `&reported_at=gte.${encodeURIComponent(dayAgo)}`);
      out.reports_fresh_2h = await count("availability_reports", `&reported_at=gte.${encodeURIComponent(hour2Ago)}`);
      out.reports_total = await count("availability_reports");
      out.listing_open = await count("listing_reports", "&status=eq.open");
      out.listing_resolved = await count("listing_reports", "&status=eq.resolved");
      out.listing_dismissed = await count("listing_reports", "&status=eq.dismissed");
      out.operator_pending = await count("operator_submissions", "&status=eq.pending");
      out.operator_approved = await count("operator_submissions", "&status=eq.approved");
      out.operator_rejected = await count("operator_submissions", "&status=eq.rejected");
      out.confirmations_24h = await count("report_confirmations", `&confirmed_at=gte.${encodeURIComponent(dayAgo)}`);
      const stations = loadStations();
      out.directory_total = stations ? stations.length : null;
      out.directory_with_coords = stations ? stations.filter((s) => s.lat != null && s.lng != null).length : null;
      return json(res, 200, { configured: true, ok: true, analytics: out });
    }

    // ---- Postcode integration monitoring ---------------------------------
    // Mode + key presence only. The key itself is NEVER returned, and
    // neither is any prefix of it — "configured: true/false" is the
    // whole answer. Recent NIPOST errors are not stored anywhere (the
    // proxy does not log upstream bodies), so there is no error list to
    // show — the panel says so honestly instead of inventing one.
    if (action === "postcode_status") {
      const key = (process.env.NIPOST_API_KEY || "").trim();
      const base = (process.env.NIPOST_API_BASE || "").trim();
      return json(res, 200, { configured: true, ok: true, postcode: {
        configured: Boolean(key),
        mode: !key ? "unconfigured" : key.startsWith("nipost_live_") ? "live" : "sandbox",
        api_base_override: Boolean(base),
        recent_errors: "not stored — the postcode proxy logs errors server-side only (Vercel logs), never in the database",
      } });
    }

    // ---- Duplicate detection ---------------------------------------------
    // Same-coordinate groups at 4 decimal places (~11 m), from the live
    // dataset. Groups involving an exact pin are flagged as possible
    // duplicates of one physical place; coarse town/approximate groups
    // are expected (shared locality centroids) and labelled as such.
    // NOTHING is merged here — merging happens in the master dataset,
    // by Saheed's decision, never from the admin panel.
    if (action === "duplicates") {
      const stations = loadStations();
      if (!stations) {
        return json(res, 200, { configured: true, ok: true, groups: [], note: "station data could not be loaded" });
      }
      const byCoord = new Map();
      stations.forEach((s) => {
        if (s.lat == null || s.lng == null) return;
        const key = `${Number(s.lat).toFixed(4)},${Number(s.lng).toFixed(4)}`;
        if (!byCoord.has(key)) byCoord.set(key, []);
        byCoord.get(key).push({ id: s.id, name: s.name, state: s.state,
          precision: s.coord_precision || null });
      });
      const groups = [...byCoord.entries()]
        .filter(([, v]) => v.length > 1)
        .map(([coord, entries]) => ({
          coord,
          entries,
          exact_pin: entries.some((e) => e.precision === "exact"),
        }))
        .sort((a, b) => (b.exact_pin - a.exact_pin) || (b.entries.length - a.entries.length));
      return json(res, 200, { configured: true, ok: true, groups,
        total_groups: groups.length,
        exact_pin_groups: groups.filter((g) => g.exact_pin).length });
    }

    // ---- Data quality ----------------------------------------------------
    // Completeness counts computed from the live dataset + stats.json.
    // No invented figures: every number is counted here.
    if (action === "data_quality") {
      const stations = loadStations();
      if (!stations) {
        return json(res, 200, { configured: true, ok: false, error: "station data could not be loaded" });
      }
      let stats = null;
      try {
        stats = JSON.parse(readFileSync(new URL("../data/stats.json", import.meta.url), "utf8"));
      } catch { /* stats.json is optional here */ }
      const withCoords = stations.filter((s) => s.lat != null && s.lng != null);
      const q = {
        total: stations.length,
        with_coords: withCoords.length,
        without_coords: stations.length - withCoords.length,
        exact_pins: stations.filter((s) => s.coord_precision === "exact").length,
        approximate_pins: stations.filter((s) => s.coord_precision === "approximate").length,
        town_pins: stations.filter((s) => s.coord_precision === "town").length,
        with_phone: stations.filter((s) => s.phone).length,
        with_hours: stations.filter((s) => s.hours).length,
        with_services: stations.filter((s) => s.services).length,
        with_price: stations.filter((s) => s.price != null).length,
        with_photo: stations.filter((s) => s.photo && s.photo.url).length,
        accredited: stations.filter((s) => s.acc).length,
        single_source: stations.filter((s) => s.confidence === "single-source").length,
        stale_2024: stations.filter((s) => s.confidence === "stale-2024-list").length,
        states_with_data: stats ? (stats.states_with_data ?? null) : null,
        no_data_states: stats ? (stats.no_data_states ?? null) : null,
        generated_at: stats ? (stats.generated_at ?? null) : null,
      };
      return json(res, 200, { configured: true, ok: true, quality: q });
    }

    // ---- Accreditation review --------------------------------------------
    // Centres whose accreditation needs re-verification (stale 2024-list
    // entries) and single-source entries — the verifier's worklist.
    // Read-only: re-verification itself means checking the centre
    // against a current official source and updating the master dataset.
    if (action === "accreditation_review") {
      const stations = loadStations();
      if (!stations) {
        return json(res, 200, { configured: true, ok: false, error: "station data could not be loaded" });
      }
      const stale = stations
        .filter((s) => s.confidence === "stale-2024-list")
        .map((s) => ({ id: s.id, name: s.name, state: s.state, address: s.address, confidence: s.confidence }));
      const single = stations
        .filter((s) => s.confidence === "single-source")
        .map((s) => ({ id: s.id, name: s.name, state: s.state, address: s.address, confidence: s.confidence }));
      return json(res, 200, { configured: true, ok: true,
        stale_2024: stale, single_source: single,
        counts: { stale_2024: stale.length, single_source: single.length } });
    }

    return json(res, 400, { ok: false, error: "unknown action" });
  } catch (e) {
    console.error("admin failed:", String((e && e.message) || e).slice(0, 200));
    return json(res, 500, { ok: false, error: "Could not reach the database. Please try again." });
  }
}
