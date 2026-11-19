/* FindCNG Nigeria — admin dashboard (Phase 4, §16).
   External script (not inline) so the Content Security Policy can run
   without 'unsafe-inline'. Role-gated: the passcode identifies a role
   (super_admin / data_admin / verifier) and the UI only shows the
   actions that role may perform — the server enforces the same matrix
   in api/admin.js, so hiding a button is never the only protection. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let passcode = sessionStorage.getItem("findcng_admin") || "";
  let role = sessionStorage.getItem("findcng_admin_role") || "";
  let currentLrStatus = "open";
  let currentOpStatus = "pending";
  let currentTab = "overview";
  const loaded = new Set();

  // What each role may do (mirrors api/admin.js ROLE_ACTIONS — the
  // server is the authority; this only decides which buttons to show).
  const CAN = {
    super_admin: { listing_write: true, op_review: true, op_delete: true, av_delete: true },
    data_admin: { listing_write: true, op_review: false, op_delete: false, av_delete: true },
    verifier: { listing_write: false, op_review: true, op_delete: false, av_delete: true },
  };
  const can = (what) => Boolean(role && CAN[role] && CAN[role][what]);
  const ROLE_LABEL = { super_admin: "Super admin", data_admin: "Data admin", verifier: "Verifier" };

  async function call(body) {
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Passcode": passcode },
      body: JSON.stringify(body),
    });
    return r.json();
  }
  function msg(el, text, kind) {
    el.textContent = text;
    el.className = "notice" + (kind ? " " + kind : "");
    el.classList.remove("hidden");
  }
  function timeAgo(iso) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " hr " + (m % 60) + " min ago";
    return Math.floor(h / 24) + " day(s) ago";
  }
  function handleWrongPasscode(j) {
    if (j && j.error === "wrong passcode") {
      sessionStorage.removeItem("findcng_admin");
      sessionStorage.removeItem("findcng_admin_role");
      passcode = ""; role = "";
      $("dashboard").classList.add("hidden");
      $("gate").classList.remove("hidden");
      msg($("gate-msg"), "Wrong passcode.", "err");
      return true;
    }
    return false;
  }

  // ---- Gate + role -------------------------------------------------------
  async function login() {
    passcode = $("passcode").value;
    if (!passcode) { msg($("gate-msg"), "Enter the passcode.", "err"); return; }
    const j = await call({ action: "whoami" });
    if (j && j.error === "wrong passcode") { msg($("gate-msg"), "Wrong passcode.", "err"); return; }
    if (!j || !j.ok || !j.role) { msg($("gate-msg"), "Could not reach the server — try again.", "err"); return; }
    role = j.role;
    sessionStorage.setItem("findcng_admin", passcode);
    sessionStorage.setItem("findcng_admin_role", role);
    openDashboard();
  }
  function openDashboard() {
    $("gate").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    $("role-line").textContent = `Signed in as ${ROLE_LABEL[role] || role}.`;
    $("role-badge").textContent = `Role: ${ROLE_LABEL[role] || role}`;
    showTab(currentTab);
  }
  $("gate-go").addEventListener("click", login);
  $("passcode").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  $("sign-out").addEventListener("click", () => {
    sessionStorage.removeItem("findcng_admin");
    sessionStorage.removeItem("findcng_admin_role");
    passcode = ""; role = "";
    $("passcode").value = "";
    $("dashboard").classList.add("hidden");
    $("gate").classList.remove("hidden");
  });

  // ---- Tabs --------------------------------------------------------------
  function showTab(name) {
    currentTab = name;
    document.querySelectorAll("#tabbar .chip").forEach((c) =>
      c.classList.toggle("on", c.dataset.tab === name));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("hidden", p.id !== "tab-" + name));
    if (name === "overview") loadOverview();
    else if (name === "listing") loadLrQueue();
    else if (name === "availability") loadAvQueue();
    else if (name === "operator") loadOpQueue();
    else if (name === "audit") loadAudit();
    else if (name === "data") loadDataViews();
    else if (name === "postcode") loadPostcode();
  }
  document.querySelectorAll("#tabbar .chip").forEach((c) =>
    c.addEventListener("click", () => showTab(c.dataset.tab)));

  // ---- Overview (analytics — real counts only) ---------------------------
  $("ov-refresh").addEventListener("click", loadOverview);
  async function loadOverview() {
    const m = $("ov-msg");
    m.classList.add("hidden");
    const j = await call({ action: "analytics" });
    if (handleWrongPasscode(j)) return;
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load analytics.", "err"); return; }
    const a = j.analytics || {};
    const tile = (num, label) =>
      `<div class="card" style="margin:0 0 10px"><div class="big-num" style="font-size:28px">${esc(String(num == null ? "—" : num))}</div><p class="small" style="margin:4px 0 0">${esc(label)}</p></div>`;
    $("ov-body").innerHTML =
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">` +
      tile(a.listing_open, "Open listing reports") +
      tile(a.operator_pending, "Pending operator submissions") +
      tile(a.reports_fresh_2h, "Fresh availability reports (2 h)") +
      tile(a.reports_24h, "Availability reports (24 h)") +
      tile(a.confirmations_24h, "Confirmations (24 h)") +
      tile(a.directory_total, "Directory entries") +
      tile(a.directory_with_coords, "Entries with coordinates") +
      tile(a.reports_total, "Availability reports (all time)") +
      `</div>` +
      `<p class="small">Listing reports: ${esc(String(a.listing_resolved))} resolved · ${esc(String(a.listing_dismissed))} dismissed. ` +
      `Operator submissions: ${esc(String(a.operator_approved))} approved · ${esc(String(a.operator_rejected))} rejected.</p>` +
      (a.not_open && a.not_open.length
        ? `<p class="notice">Not open yet: ${a.not_open.map(esc).join(", ")} — run the SQL migration in Supabase (sql/003 for the operator portal and audit log). Those counts read 0 until then.</p>`
        : `<p class="small">All tables are set up. Counts generated ${new Date(a.generated_at).toLocaleString("en-NG")}.</p>`);
  }

  // ---- Listing reports ---------------------------------------------------
  function lrTypeLabel(r) {
    const d = r.details || "";
    if (d.startsWith("[Wrong coordinates]")) return "Wrong coordinates";
    if (d.startsWith("[Updated contact]")) return "Updated contact details";
    if (d.startsWith("[Safety concern]")) return "Safety concern";
    if (d.startsWith("[Missing station]")) return "Missing station";
    return r.report_type;
  }
  function lrDetails(r) {
    const d = r.details || "";
    const m = d.match(/^\[[^\]]+\]\s*/);
    return m ? d.slice(m[0].length) : d;
  }
  document.querySelectorAll("#tab-listing .chip[data-lr-status]").forEach((c) =>
    c.addEventListener("click", () => {
      document.querySelectorAll("#tab-listing .chip[data-lr-status]").forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
      currentLrStatus = c.dataset.lrStatus;
      loadLrQueue();
    }));
  async function loadLrQueue() {
    const m = $("lr-msg");
    m.classList.add("hidden");
    const j = await call({ action: "list_listing_reports", status: currentLrStatus });
    if (handleWrongPasscode(j)) return;
    if (j && j.configured === false) {
      msg(m, "The database is not connected yet — there is no queue to review.", "");
      $("lr-list").innerHTML = ""; $("lr-count").textContent = ""; return;
    }
    if (j && j.error === "not_open") {
      msg(m, "Listing reports are not open yet — run sql/001_listing_reports_and_confirmations.sql in Supabase first.", "");
      $("lr-list").innerHTML = ""; $("lr-count").textContent = ""; return;
    }
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load listing reports.", "err"); return; }
    const rows = j.reports || [];
    $("lr-count").textContent = rows.length + " listing report(s) — " + currentLrStatus +
      (can("listing_write") ? "" : " (your role can read these but not resolve or dismiss them)");
    if (!rows.length) {
      $("lr-list").innerHTML = `<div class="empty"><p><b>Nothing here.</b></p><p>No ${esc(currentLrStatus)} listing reports right now.</p></div>`;
      return;
    }
    $("lr-list").innerHTML = rows.map((r) => `
      <div class="card station" data-id="${r.id}">
        <h3>${r.station_id === "NEW" ? "Suggested new station" : esc(r.station_id)} — ${esc(lrTypeLabel(r))}</h3>
        <p class="meta">${esc(lrDetails(r) || "No details given.")}</p>
        <div class="row"><span class="badge ${r.status === "open" ? "low" : r.status === "resolved" ? "available" : "unconfirmed"}">${esc(r.status)}</span>
        <span class="small">reported ${new Date(r.reported_at).toLocaleString("en-NG")}</span></div>
      </div>`).join("");
    document.querySelectorAll("#lr-list .station").forEach((el) =>
      el.addEventListener("click", () => openLrDetail(el.dataset.id, rows)));
  }
  function openLrDetail(id, rows) {
    const r = rows.find((x) => String(x.id) === String(id));
    if (!r) return;
    $("detail-body").innerHTML = `
      <h2>Listing report — ${r.station_id === "NEW" ? "Suggested new station" : esc(r.station_id)}</h2>
      <p><b>Type:</b> ${esc(lrTypeLabel(r))}<br>
      <b>Details:</b> ${esc(lrDetails(r) || "—")}<br>
      <b>Status:</b> ${esc(r.status)}${r.resolution_note ? " — " + esc(r.resolution_note) : ""}<br>
      <b>Reported:</b> ${new Date(r.reported_at).toLocaleString("en-NG")}<br>
      ${r.station_id === "NEW" ? `<span class="small">No listing to open — this suggests a station that is not in the directory yet. Check the name, address and state against official lists before adding it to the master dataset.</span>`
        : `<a href="index.html?station=${encodeURIComponent(r.station_id)}" target="_blank" rel="noopener">Open the listing ↗</a>`}</p>
      ${r.status === "open" && can("listing_write") ? `
      <div class="field" style="margin-top:14px">
        <label for="lr-note">Resolution note (optional)</label>
        <input type="text" id="lr-note" placeholder="e.g. Fixed the phone number in the dataset">
      </div>
      <p id="detail-msg" class="notice hidden"></p>
      <button class="btn" id="lr-resolve-btn">✓ Mark resolved</button>
      <button class="btn outline" id="lr-dismiss-btn" style="margin-top:8px;background:#fff;color:#a02c2c;border-color:#a02c2c">✕ Dismiss</button>
      <p class="small">Resolving here only closes the report — fix the listing itself in the master dataset (~/workspace/cng-project/data/stations.json) and re-run build-data.py, then redeploy.</p>` : ""}
      ${r.status === "open" && !can("listing_write") ? `<p class="small">Your role can read listing reports but not resolve or dismiss them — that is a data admin or super admin action.</p>` : ""}
      ${can("listing_write") ? `
      <p id="detail-msg2" class="notice hidden"></p>
      <button class="btn outline" id="lr-delete-btn" style="margin-top:8px;background:#fff;color:#a02c2c;border-color:#a02c2c">🗑 Delete this report</button>
      <p class="small">Delete is for spam and test rows only — it removes the report permanently. Use Resolve or Dismiss for real reports.</p>` : ""}`;
    $("detail-backdrop").classList.add("open");
    const rb = $("lr-resolve-btn");
    if (rb) rb.addEventListener("click", async () => {
      const j = await call({ action: "resolve_listing_report", id, note: $("lr-note").value.trim() });
      if (j && j.ok) { $("detail-backdrop").classList.remove("open"); loadLrQueue(); }
      else msg($("detail-msg"), (j && j.error) || "Could not resolve.", "err");
    });
    const db = $("lr-dismiss-btn");
    if (db) db.addEventListener("click", async () => {
      const j = await call({ action: "dismiss_listing_report", id, note: $("lr-note").value.trim() });
      if (j && j.ok) { $("detail-backdrop").classList.remove("open"); loadLrQueue(); }
      else msg($("detail-msg"), (j && j.error) || "Could not dismiss.", "err");
    });
    const del = $("lr-delete-btn");
    if (del) del.addEventListener("click", async () => {
      if (!confirm("Delete this listing report permanently? Use this only for spam or test rows.")) return;
      const j = await call({ action: "delete_listing_report", id });
      if (j && j.ok) { $("detail-backdrop").classList.remove("open"); loadLrQueue(); }
      else msg($("detail-msg2"), (j && j.error) || "Could not delete.", "err");
    });
  }

  // ---- Availability ------------------------------------------------------
  $("av-refresh").addEventListener("click", loadAvQueue);
  async function loadAvQueue() {
    const m = $("av-msg");
    m.classList.add("hidden");
    const j = await call({ action: "list_availability_reports" });
    if (handleWrongPasscode(j)) return;
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load availability reports.", "err"); return; }
    const rows = j.reports || [];
    $("av-count").textContent = rows.length + " recent availability report(s)";
    if (!rows.length) {
      $("av-list").innerHTML = `<div class="empty"><p><b>No reports yet.</b></p><p>No availability reports in the recent history.</p></div>`;
      return;
    }
    $("av-list").innerHTML = rows.map((r) => {
      const fresh = (Date.now() - new Date(r.reported_at).getTime()) <= 2 * 60 * 60 * 1000;
      return `
      <div class="card station">
        <h3>${esc(r.station_id)} — ${esc(r.status)}${fresh ? "" : " <span class=\"small\">(expired)</span>"}${r.source === "operator" ? ` <span class="op-chip">Operator confirmed</span>` : ""}</h3>
        <p class="meta">reported ${timeAgo(r.reported_at)}${r.queue_minutes != null ? ` · queue about ${r.queue_minutes} min` : ""}${r.pressure_ok === true ? " · pressure OK" : r.pressure_ok === false ? " · low pressure" : ""}${r.compressor_ok === true ? " · compressor working" : r.compressor_ok === false ? " · compressor faulty" : ""}</p>
        <div class="row"><span class="badge ${r.status}">${esc(r.status)}</span>
        ${r.burst ? `<span class="burst-flag">⚠ burst — reporter ${esc(r.reporter || "")}</span>` : `<span class="small">reporter ${esc(r.reporter || "—")}</span>`}
        <a href="index.html?station=${encodeURIComponent(r.station_id)}" target="_blank" rel="noopener">Open listing ↗</a></div>
        ${can("av_delete") ? `<p style="margin:8px 0 0"><button class="btn outline small av-delete" data-id="${r.id}" style="background:#fff;color:#a02c2c;border-color:#a02c2c">🗑 Delete report</button></p>` : ""}
      </div>`;
    }).join("");
    document.querySelectorAll(".av-delete").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Delete this availability report permanently? It disappears from the live feed and from history.")) return;
        const dj = await call({ action: "delete_availability_report", id: b.dataset.id });
        if (dj && dj.ok) loadAvQueue();
        else msg(m, (dj && dj.error) || "Could not delete.", "err");
      }));
  }

  // ---- Operator queue ----------------------------------------------------
  const OP_TYPE_LABEL = { register: "Centre registration", claim: "Ownership claim",
    update: "Update request", availability: "Availability update", response: "Response to a report" };
  document.querySelectorAll("#tab-operator .chip[data-op-status]").forEach((c) =>
    c.addEventListener("click", () => {
      document.querySelectorAll("#tab-operator .chip[data-op-status]").forEach((x) => x.classList.remove("on"));
      c.classList.add("on");
      currentOpStatus = c.dataset.opStatus;
      loadOpQueue();
    }));
  async function loadOpQueue() {
    const m = $("op-msg");
    m.classList.add("hidden");
    const j = await call({ action: "list_operator_submissions", status: currentOpStatus });
    if (handleWrongPasscode(j)) return;
    if (j && j.error === "not_open") {
      msg(m, "The operator portal is not open yet — run sql/003_operator_portal.sql in Supabase first.", "");
      $("op-list").innerHTML = ""; $("op-count").textContent = ""; return;
    }
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load operator submissions.", "err"); return; }
    const rows = j.submissions || [];
    $("op-count").textContent = rows.length + " operator submission(s) — " + currentOpStatus +
      (can("op_review") ? "" : " (your role can read these but not approve or reject them)");
    if (!rows.length) {
      $("op-list").innerHTML = `<div class="empty"><p><b>Nothing here.</b></p><p>No ${esc(currentOpStatus)} operator submissions right now.</p></div>`;
      return;
    }
    $("op-list").innerHTML = rows.map((s) => `
      <div class="card station" data-id="${s.id}">
        <h3>${esc(s.business_name)} — ${esc(OP_TYPE_LABEL[s.type] || s.type)}</h3>
        <p class="meta">${s.station_id ? esc(s.station_id) + " · " : ""}${esc(s.contact_name || "")}${s.phone ? " · " + esc(s.phone) : ""}${s.email ? " · " + esc(s.email) : ""}</p>
        <div class="row"><span class="badge ${s.status === "pending" ? "low" : s.status === "approved" ? "available" : "unconfirmed"}">${esc(s.status)}</span>
        <span class="small">sent ${new Date(s.submitted_at).toLocaleString("en-NG")}</span></div>
      </div>`).join("");
    document.querySelectorAll("#op-list .station").forEach((el) =>
      el.addEventListener("click", () => openOpDetail(el.dataset.id, rows)));
  }
  function opPayloadHtml(s) {
    const p = s.payload || {};
    const line = (k, v) => (v == null || v === "" ? "" : `<b>${esc(k)}:</b> ${esc(String(v))}<br>`);
    if (s.type === "register") {
      return line("Address", p.address) + line("State", p.state) + line("Services", p.services) +
        line("Accreditation body", p.accreditation_body) + line("Accreditation number", p.accreditation_number) +
        (p.latitude != null ? line("Coordinates", `${p.latitude}, ${p.longitude}`) : "");
    }
    if (s.type === "availability") {
      return line("Status", p.status) +
        (p.queue_minutes != null ? line("Queue", `about ${p.queue_minutes} min`) : "") +
        (p.pressure_ok === true ? line("Pressure", "OK") : p.pressure_ok === false ? line("Pressure", "low") : "") +
        (p.compressor_ok === true ? line("Compressor", "working") : p.compressor_ok === false ? line("Compressor", "faulty") : "");
    }
    if (s.type === "update") return line("Requested change", p.changes);
    if (s.type === "response") return line("Message", p.message) + line("Listing report", p.listing_report_id);
    if (s.type === "claim") return line("Note", p.note);
    return "";
  }
  function openOpDetail(id, rows) {
    const s = rows.find((x) => String(x.id) === String(id));
    if (!s) return;
    const isClaim = s.type === "claim";
    $("detail-body").innerHTML = `
      <h2>${esc(OP_TYPE_LABEL[s.type] || s.type)} — ${esc(s.business_name)}</h2>
      <p><b>Status:</b> ${esc(s.status)}${s.decision_reason ? " — " + esc(s.decision_reason) : ""}<br>
      <b>Sent:</b> ${new Date(s.submitted_at).toLocaleString("en-NG")}<br>
      ${s.station_id ? `<b>Station:</b> <a href="index.html?station=${encodeURIComponent(s.station_id)}" target="_blank" rel="noopener">${esc(s.station_id)} ↗</a><br>` : ""}
      <b>Contact:</b> ${esc(s.contact_name || "—")}${s.phone ? ` · <a href="tel:${esc(s.phone)}">${esc(s.phone)}</a>` : ""}${s.email ? ` · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ""}<br>
      ${s.proof_reference ? `<b>Documentation reference:</b> ${esc(s.proof_reference)}<br>` : ""}
      ${opPayloadHtml(s)}
      ${s.verification_notes ? `<b>Verification done:</b> ${esc(s.verification_notes)}<br>` : ""}
      ${s.reviewed_at ? `<b>Reviewed:</b> ${new Date(s.reviewed_at).toLocaleString("en-NG")} by ${esc(s.reviewed_by || "—")}<br>` : ""}
      <span class="small">Contact details are private — moderator only, never published.</span></p>
      ${s.status === "pending" && can("op_review") ? `
      <h3 style="margin-top:14px">Verification checklist</h3>
      <p class="small" style="margin-top:0">Tick only the checks you actually did. This is a manual attestation — there is no automatic verification.</p>
      <label class="toggle-row"><span>Checked the documentation reference against the business name and the listing</span>
        <input type="checkbox" id="op-check-docs"></label>
      <label class="toggle-row"><span>Confirmed by phone — spoke to the operator at the number given</span>
        <input type="checkbox" id="op-check-phone"></label>
      <label class="toggle-row"><span>Checked the business against official lists (Pi-CNG registers) where possible</span>
        <input type="checkbox" id="op-check-lists"></label>
      <div class="field" style="margin-top:14px">
        <label for="op-note">Decision note (optional)</label>
        <input type="text" id="op-note" placeholder="e.g. Called 0803…, confirmed; CAC RC matches">
      </div>
      <p id="detail-msg" class="notice hidden"></p>
      <button class="btn" id="op-approve-btn">✓ Approve</button>
      <button class="btn outline" id="op-reject-btn" style="margin-top:8px;background:#fff;color:#a02c2c;border-color:#a02c2c">✕ Reject</button>
      ${isClaim ? `<p class="small"><b>Claims:</b> approve only when the documentation and the phone confirmation both check out. A rejected claim publishes nothing.</p>` : ""}
      ${s.type === "availability" ? `<p class="small"><b>Availability:</b> approving publishes this as an “Operator confirmed” report on the listing immediately. Rejecting publishes nothing.</p>` : ""}
      ${s.type !== "availability" ? `<p class="small"><b>Note:</b> approving records the decision — it does not change the directory. Apply any data change in the master dataset and rebuild, as with listing reports.</p>` : ""}` : ""}
      ${s.status === "pending" && !can("op_review") ? `<p class="small">Your role can read operator submissions but not approve or reject them — that is a verifier or super admin action.</p>` : ""}
      ${can("op_delete") ? `
      <p id="detail-msg2" class="notice hidden"></p>
      <button class="btn outline" id="op-delete-btn" style="margin-top:8px;background:#fff;color:#a02c2c;border-color:#a02c2c">🗑 Delete this submission</button>
      <p class="small">Delete is for spam and test rows only — it removes the submission permanently.</p>` : ""}`;
    $("detail-backdrop").classList.add("open");
    const review = async (decision) => {
      const checks = [];
      if ($("op-check-docs") && $("op-check-docs").checked) checks.push("documentation reference checked");
      if ($("op-check-phone") && $("op-check-phone").checked) checks.push("confirmed by phone");
      if ($("op-check-lists") && $("op-check-lists").checked) checks.push("checked against official lists");
      if (decision === "approve" && isClaim && checks.length < 2) {
        msg($("detail-msg"), "A claim needs at least the documentation check and the phone confirmation before approval — tick the checks you did.", "err");
        return;
      }
      const j = await call({ action: "review_operator_submission", id, decision,
        note: $("op-note").value.trim(), verification: checks.join("; ") || null });
      if (j && j.ok) {
        $("detail-backdrop").classList.remove("open");
        loadOpQueue();
        loaded.delete("overview");
      } else {
        msg($("detail-msg"), (j && j.error) || "Could not review.", "err");
      }
    };
    const ab = $("op-approve-btn");
    if (ab) ab.addEventListener("click", () => review("approve"));
    const rb = $("op-reject-btn");
    if (rb) rb.addEventListener("click", () => review("reject"));
    const del = $("op-delete-btn");
    if (del) del.addEventListener("click", async () => {
      if (!confirm("Delete this operator submission permanently? Use this only for spam or test rows.")) return;
      const j = await call({ action: "delete_operator_submission", id });
      if (j && j.ok) { $("detail-backdrop").classList.remove("open"); loadOpQueue(); }
      else msg($("detail-msg2"), (j && j.error) || "Could not delete.", "err");
    });
  }

  // ---- Audit log ---------------------------------------------------------
  $("au-refresh").addEventListener("click", loadAudit);
  async function loadAudit() {
    const m = $("au-msg");
    m.classList.add("hidden");
    const j = await call({ action: "list_audit_log" });
    if (handleWrongPasscode(j)) return;
    if (j && j.error === "not_open") {
      msg(m, "The audit log is not open yet — run sql/003_operator_portal.sql in Supabase first.", "");
      $("au-list").innerHTML = ""; $("au-count").textContent = ""; return;
    }
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load the audit log.", "err"); return; }
    const rows = j.entries || [];
    $("au-count").textContent = rows.length + " audit entries (newest first)";
    if (!rows.length) {
      $("au-list").innerHTML = `<div class="empty"><p><b>No entries yet.</b></p><p>Admin actions will appear here once the audit log table exists and actions are performed.</p></div>`;
      return;
    }
    $("au-list").innerHTML = rows.map((e) => `
      <div class="card station">
        <h3>${esc(e.action)}${e.target_type ? ` — ${esc(e.target_type)}` : ""}</h3>
        <p class="meta">${esc(e.detail || "—")}</p>
        <div class="row"><span class="badge type">${esc(e.actor_role)}</span>
        <span class="small">${new Date(e.created_at).toLocaleString("en-NG")}</span></div>
      </div>`).join("");
  }

  // ---- Data quality / duplicates / accreditation -------------------------
  $("dq-refresh").addEventListener("click", loadDataViews);
  async function loadDataViews() {
    const m = $("dq-msg");
    m.classList.add("hidden");
    const [qj, dj, aj] = await Promise.all([
      call({ action: "data_quality" }),
      call({ action: "duplicates" }),
      call({ action: "accreditation_review" }),
    ]);
    if (handleWrongPasscode(qj) || handleWrongPasscode(dj) || handleWrongPasscode(aj)) return;
    if (qj && qj.ok) {
      const q = qj.quality;
      const row = (label, num) => `<div class="calc-row"><span>${esc(label)}</span><b>${esc(String(num == null ? "—" : num))}</b></div>`;
      $("dq-body").innerHTML = `<div class="card">` +
        row("Total entries", q.total) +
        row("With coordinates", q.with_coords) +
        row("Without coordinates", q.without_coords) +
        row("Exact pins", q.exact_pins) +
        row("Approximate pins", q.approximate_pins) +
        row("Town pins", q.town_pins) +
        row("With phone", q.with_phone) +
        row("With opening hours", q.with_hours) +
        row("With services", q.with_services) +
        row("With price", q.with_price) +
        row("With photo", q.with_photo) +
        row("Accredited (Pi-CNG register)", q.accredited) +
        row("Single source — needs a second check", q.single_source) +
        row("Stale 2024 list — needs re-verification", q.stale_2024) +
        `</div><p class="small">States with data: ${esc(String(q.states_with_data))} · No-data states: ${(q.no_data_states || []).join(", ") || "—"} · Dataset generated: ${esc(q.generated_at || "—")}</p>`;
    } else {
      msg(m, (qj && qj.error) || "Could not load data quality.", "err");
    }
    if (dj && dj.ok) {
      const groups = dj.groups || [];
      const exact = groups.filter((g) => g.exact_pin);
      $("dup-body").innerHTML =
        `<p class="small">${groups.length} same-coordinate group(s) in total; <b>${exact.length} involve an exact pin</b> and may be one physical place each.</p>` +
        (exact.length ? exact.map((g) => `
          <div class="card station"><h3>⚠ Exact-pin group — ${esc(g.coord)}</h3>
          ${g.entries.map((e) => `<p style="margin:4px 0"><a href="index.html?station=${encodeURIComponent(e.id)}" target="_blank" rel="noopener">${esc(e.id)} — ${esc(e.name)}</a> <span class="small">(${esc(e.state || "")})</span></p>`).join("")}
          <p class="small" style="margin:8px 0 0">Decision needed (Saheed): merge into one listing, or keep both register rows? If merging, fix it in the master dataset and rebuild — never merge from here.</p></div>`).join("")
          : `<p class="small">No exact-pin groups — nothing to review.</p>`) +
        `<p class="small">${groups.length - exact.length} coarse town/approximate group(s) — shared locality centroids, expected, not duplicates.</p>`;
    }
    if (aj && aj.ok) {
      const stale = aj.stale_2024 || [];
      const single = aj.single_source || [];
      const list = (rows) => rows.length
        ? `<div style="max-height:260px;overflow:auto">` + rows.map((s) =>
          `<p style="margin:4px 0"><a href="index.html?station=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">${esc(s.id)} — ${esc(s.name)}</a> <span class="small">(${esc(s.state || "")})</span></p>`).join("") + `</div>`
        : `<p class="small">None.</p>`;
      $("acc-body").innerHTML =
        `<div class="card"><h3 style="margin-top:0">Stale 2024 list — ${stale.length}</h3>${list(stale)}</div>` +
        `<div class="card"><h3 style="margin-top:0">Single source — ${single.length}</h3>${list(single)}</div>`;
    }
  }

  // ---- Postcode monitoring -----------------------------------------------
  $("pc-refresh").addEventListener("click", loadPostcode);
  async function loadPostcode() {
    const m = $("pc-msg");
    m.classList.add("hidden");
    const j = await call({ action: "postcode_status" });
    if (handleWrongPasscode(j)) return;
    if (!j || !j.ok) { msg(m, (j && j.error) || "Could not load postcode status.", "err"); return; }
    const p = j.postcode || {};
    $("pc-body").innerHTML = `<div class="card">` +
      `<div class="calc-row"><span>NIPOST key configured</span><b>${p.configured ? "Yes" : "No"}</b></div>` +
      `<div class="calc-row"><span>Mode</span><b>${esc(p.mode || "—")}</b></div>` +
      `<div class="calc-row"><span>API base override set</span><b>${p.api_base_override ? "Yes" : "No"}</b></div>` +
      `</div><p class="small">${esc(p.mode === "sandbox" ? "Sandbox mode: only NIPOST's published sample codes validate. A live key (verified KYB + granted access) is Saheed's decision — see the Phase 2 report." : p.mode === "live" ? "Live mode: real building codes validate against NIPOST." : "No key is configured — postcode lookup falls back to the built-in 6-digit table + GPS + map tap.")}</p>` +
      `<p class="small">${esc(p.recent_errors || "")}</p>`;
  }

  // ---- Sheet ---------------------------------------------------------------
  $("detail-close").addEventListener("click", () => $("detail-backdrop").classList.remove("open"));
  $("detail-backdrop").addEventListener("click", (e) => { if (e.target === $("detail-backdrop")) $("detail-backdrop").classList.remove("open"); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("detail-backdrop").classList.remove("open");
  });

  // Resume a signed-in session (passcode + role in sessionStorage).
  if (passcode && role) openDashboard();
  else if (passcode) {
    // Passcode stored but role unknown (pre-Phase-4 session): re-check it.
    call({ action: "whoami" }).then((j) => {
      if (j && j.ok && j.role) {
        role = j.role;
        sessionStorage.setItem("findcng_admin_role", role);
        openDashboard();
      } else {
        sessionStorage.removeItem("findcng_admin");
        sessionStorage.removeItem("findcng_admin_role");
        passcode = "";
      }
    });
  }
})();
