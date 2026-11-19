#!/usr/bin/env python3
"""Phase 4 live UI verification for FindCNG (19 Nov 2026).
Drives the DEPLOYED site in headless Chromium (Playwright) and checks the
operator portal, the multilingual safety hub, the role-based admin
dashboard, the Content Security Policy, offline behaviour, and the
§23 regression subset (home, calculator, postcode explorer, intelligence).

sql/003 state: the operator portal + audit log need sql/003
(operator_submissions, audit_log). This script detects whether it has
been run: when it has not, the checks assert the honest "not open yet"
states; when it has, the checks drive the full submit -> queue ->
approve flow in the browser. Either way nothing is assumed.

Creates at most one listing report (CNG-002, for the verifier read-only
check) and DELETES it afterwards via the admin API — zero lasting
pollution. Saheed's own reports (CNG-018/021/009) are never touched and
are re-verified intact at the end.
Screenshots go to /tmp/findcng-phase4/."""
import json, os, re, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

BASE = "https://findcng.vercel.app"
OUT = "/tmp/findcng-phase4"
os.makedirs(OUT, exist_ok=True)

ENV = {}
with open(os.path.expanduser("~/workspace/findcng/.env.local")) as f:
    for line in f:
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()
SUPER = ENV["ADMIN_PASSCODE"]
DATA = ENV["DATA_ADMIN_PASSCODE"]
VER = ENV["VERIFIER_PASSCODE"]

fails = []
def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), "-", name, detail)
    if not cond:
        fails.append(name)

def api(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def admin(action, code, extra=None):
    b = {"action": action}
    if extra:
        b.update(extra)
    return api("POST", BASE + "/api/admin", b, {"X-Admin-Passcode": code})

# sql/003 live? 404 on a nonexistent id = table exists; 503 = not run.
_, probe = api("GET", BASE + "/api/operator?id=00000000-0000-0000-0000-000000000000")
SQL003 = probe.get("error") != "not_open"
print("sql/003 live:", SQL003)

test_lr_id = None
try:
    with sync_playwright() as pw:
        launch_kwargs = dict(
            executable_path=os.path.expanduser(
                "~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"),
            proxy={"server": "http://127.0.0.1:18080"})
        b = pw.chromium.launch(**launch_kwargs)

        # ---------- mobile: home regression + operator + safety ----------
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errors = []
        pg.on("console", lambda m: errors.append(m.text)
              if m.type == "error" and "ERR_CERT_AUTHORITY_INVALID" not in m.text
              and "ERR_FAILED" not in m.text else None)
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(BASE + "/", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(4000)
        check("home: hero + stats under CSP", "Find CNG. Find Confidence." in pg.content()
              and "721" in pg.content())
        check("home: no CSP violations", not any("Content Security Policy" in e for e in errors),
              str([e for e in errors if "CSP" in e or "Security Policy" in e][:2]))
        check("home: no JS errors from app code", not errors, str(errors[:3]))
        check("home: live feed empty state is honest",
              "No gas report in the last 2 hours" in pg.content())
        check("home: offline banner hidden while online", not pg.is_visible("#offline-bar"))
        check("home: skip link present", pg.locator(".skip-link").count() == 1)

        # Operator portal: type switching + station picker + validation.
        pg.click('button[data-view="more"]')
        pg.wait_for_timeout(500)
        pg.click('button[data-view-link="operator"]')
        pg.wait_for_timeout(800)
        check("operator: portal opens from More menu", pg.is_visible("#view-operator.active"))
        check("operator: register form shows address/state",
              pg.is_visible("#op-address-field") and pg.is_visible("#op-state-field"))
        check("operator: state select has 37 states",
              pg.locator("#op-state option").count() == 38)
        pg.click('button[data-op-type="claim"]')
        pg.wait_for_timeout(400)
        check("operator: claim shows station picker + proof",
              pg.is_visible("#op-station-field") and pg.is_visible("#op-proof-field")
              and not pg.is_visible("#op-address-field"))
        pg.fill("#op-station-search", "NIPCO Benin")
        pg.wait_for_timeout(900)
        check("operator: multi-word station search finds NIPCO Benin",
              pg.locator(".op-pick").count() >= 1, str(pg.locator(".op-pick").count()))
        pg.locator(".op-pick").first.click()
        pg.wait_for_timeout(400)
        picked = pg.inner_text("#op-station-selected") or ""
        m = re.search(r"CNG-\d+", picked)
        picked_station = m.group(0) if m else None
        check("operator: picking a station selects it",
              picked_station is not None, picked[:80])
        pg.screenshot(path=OUT + "/01-operator-claim.png")
        # Client-side validation: empty business name.
        pg.click("#op-submit")
        pg.wait_for_timeout(400)
        check("operator: empty business name is refused in the form",
              "business name" in (pg.inner_text("#op-msg") or "").lower())
        # Fill a full claim and submit: without sql/003 the honest
        # not-open message shows; with sql/003 a reference shows.
        pg.fill("#op-business", "PHASE4 UI TEST OP")
        pg.fill("#op-phone", "08030000000")
        pg.fill("#op-proof", "PHASE4 UI TEST CAC RC 999999")
        pg.click("#op-submit")
        pg.wait_for_timeout(2500)
        if SQL003:
            check("operator: claim submits and shows a reference",
                  pg.is_visible("#op-success") and pg.input_value("#op-ref") != "")
            op_ref = pg.input_value("#op-ref")
            pg.screenshot(path=OUT + "/02-operator-success.png")
        else:
            check("operator: submit without sql/003 shows honest not-open",
                  "not open yet" in (pg.inner_text("#op-msg") or "").lower(),
                  pg.inner_text("#op-msg")[:100])
            op_ref = None
        # Status check.
        if op_ref:
            pg.fill("#op-check-input", op_ref)
            pg.click("#op-check-go")
            pg.wait_for_timeout(2000)
            check("operator: status check shows pending",
                  "pending" in (pg.inner_text("#op-check-result") or "").lower())
        else:
            pg.fill("#op-check-input", "00000000-0000-0000-0000-000000000000")
            pg.click("#op-check-go")
            pg.wait_for_timeout(2000)
            check("operator: status check without sql/003 shows not-open",
                  "not open yet" in (pg.inner_text("#op-check-result") or "").lower())

        # Safety hub: all five languages + review banner.
        pg.goto(BASE + "/?view=safety", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(3000)
        pg.click('button[data-lang="ha"]')
        pg.wait_for_timeout(500)
        check("safety: Hausa renders + review banner shows",
              "tsarin CNG" in pg.content() and pg.is_visible("#safety-review-note"))
        pg.screenshot(path=OUT + "/03-safety-hausa.png")
        pg.click('button[data-lang="yo"]')
        pg.wait_for_timeout(500)
        check("safety: Yoruba renders + review banner shows",
              pg.is_visible("#safety-review-note")
              and "Is CNG safe?" not in (pg.inner_text("#safety-title") or ""))
        pg.click('button[data-lang="ig"]')
        pg.wait_for_timeout(500)
        check("safety: Igbo renders + review banner shows",
              pg.is_visible("#safety-review-note"))
        pg.click('button[data-lang="pcm"]')
        pg.wait_for_timeout(500)
        check("safety: Pidgin still works, banner hidden",
              "Di short answer" in pg.content() and not pg.is_visible("#safety-review-note"))
        pg.click('button[data-lang="en"]')
        pg.wait_for_timeout(500)
        check("safety: English restores + banner hidden",
              "certified CNG system is safe" in pg.content()
              and not pg.is_visible("#safety-review-note"))

        # Calculator regression (defaults: car 100 km/day x 26 days).
        pg.goto(BASE + "/?view=calculator", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(2500)
        check("calculator: default saving is N266,382/month",
              "266,382" in pg.content())
        # Postcode explorer regression: sandbox sample validates.
        pg.goto(BASE + "/?view=postcode", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(2500)
        pg.click("#explorer-sample")
        pg.wait_for_timeout(4000)
        check("postcode: sandbox sample confirms assigned",
              "Confirmed assigned" in pg.content())
        # Intelligence regression.
        pg.goto(BASE + "/?view=intelligence", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(3000)
        check("intelligence: national overview renders",
              "721" in pg.content() and "National overview" in pg.content())

        # Offline behaviour: banner + live withdrawal + auto-sync.
        pg.goto(BASE + "/", wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(3500)
        pg.context.set_offline(True)
        # The offline event fires in the page; give it a moment.
        pg.wait_for_timeout(1500)
        check("offline: banner shows", pg.is_visible("#offline-bar"))
        check("offline: home feed withdraws live reports",
              "You are offline" in pg.content())
        pg.click('button[data-view="outages"]')
        pg.wait_for_timeout(800)
        check("offline: outages view shows no stale list",
              "Live outages need a connection" in pg.content())
        pg.screenshot(path=OUT + "/04-offline.png")
        pg.context.set_offline(False)
        pg.wait_for_timeout(4000)
        check("offline: banner hides on reconnect", not pg.is_visible("#offline-bar"))

        # ---------- admin dashboard: super admin ----------
        apg = b.new_page(viewport={"width": 390, "height": 844})
        aerrors = []
        apg.on("console", lambda m: aerrors.append(m.text)
               if m.type == "error" and "ERR_CERT_AUTHORITY_INVALID" not in m.text
               and "ERR_FAILED" not in m.text else None)
        apg.on("pageerror", lambda e: aerrors.append(str(e)))
        apg.goto(BASE + "/admin.html", wait_until="networkidle", timeout=60000)
        apg.wait_for_timeout(1500)
        apg.fill("#passcode", SUPER)
        apg.click("#gate-go")
        apg.wait_for_timeout(2500)
        check("admin: super login opens the dashboard",
              apg.is_visible("#dashboard") and "Super admin" in apg.content())
        # The analytics call runs several Supabase queries — wait for the
        # tiles to render rather than a fixed sleep.
        try:
            apg.wait_for_selector("text=Open listing reports", timeout=20000)
        except Exception:
            pass
        check("admin: overview tiles show real counts",
              "721" in apg.content() and "Open listing reports" in apg.content())
        apg.screenshot(path=OUT + "/05-admin-overview.png")
        # Operator tab.
        apg.click('button[data-tab="operator"]')
        apg.wait_for_timeout(2000)
        if SQL003:
            check("admin: operator queue lists the UI test claim",
                  "PHASE4 UI TEST OP" in apg.content())
            # Approve it as super admin (with the checklist ticked).
            apg.locator("#op-list .station").first.click()
            apg.wait_for_timeout(800)
            apg.check("#op-check-docs")
            apg.check("#op-check-phone")
            apg.click("#op-approve-btn")
            apg.wait_for_timeout(2500)
            check("admin: approving the claim closes the sheet",
                  not apg.locator("#detail-backdrop.open").count())
            s, j = api("GET", BASE + f"/api/operator?station={picked_station}")
            check("admin: approved claim publishes claimed:true",
                  j.get("claimed") is True and j.get("business_name") == "PHASE4 UI TEST OP",
                  str(j))
            # Cleanup: delete the submission + verify claimed:false again.
            s, j = admin("list_operator_submissions", SUPER, {"status": "approved"})
            mine = [x for x in j.get("submissions", []) if x.get("business_name") == "PHASE4 UI TEST OP"]
            for row in mine:
                admin("delete_operator_submission", SUPER, {"id": row["id"]})
            s, j = api("GET", BASE + f"/api/operator?station={picked_station}")
            check("admin: claim deleted -> claimed:false again", j.get("claimed") is False, str(j))
        else:
            check("admin: operator queue shows honest not-open",
                  "not open yet" in apg.content().lower())
        # Audit tab.
        apg.click('button[data-tab="audit"]')
        apg.wait_for_timeout(2000)
        if SQL003:
            check("admin: audit log lists entries",
                  "audit entries" in apg.content().lower())
        else:
            check("admin: audit log shows honest not-open",
                  "not open yet" in apg.content().lower())
        # Data tab.
        apg.click('button[data-tab="data"]')
        apg.wait_for_timeout(3000)
        check("admin: data quality counts render",
              "Total entries" in apg.content() and "721" in apg.content())
        check("admin: duplicates show both exact-pin pairs",
              "CNG-282" in apg.content() and "CNG-387" in apg.content())
        check("admin: accreditation review lists stale centres",
              "Stale 2024 list" in apg.content())
        apg.screenshot(path=OUT + "/06-admin-data.png")
        # Postcode tab.
        apg.click('button[data-tab="postcode"]')
        apg.wait_for_timeout(2000)
        check("admin: postcode tab shows sandbox mode, no key",
              "sandbox" in apg.content().lower() and "nipost_" not in apg.content())
        # Availability tab: Saheed's 3 reports intact.
        apg.click('button[data-tab="availability"]')
        apg.wait_for_timeout(2000)
        av_text = apg.content()
        check("admin: availability history holds Saheed's 3 reports",
              "CNG-018" in av_text and "CNG-021" in av_text and "CNG-009" in av_text)
        check("admin: no JS errors", not aerrors, str(aerrors[:3]))

        # ---------- admin dashboard: verifier (read-only listing reports) --
        # Create one test listing report so the verifier has a row to open.
        s, r = api("POST", BASE + "/api/listing-reports",
                   {"station_id": "CNG-002", "report_type": "other",
                    "details": "PHASE4 UI TEST — verifier read-only check"})
        test_lr_id = r.get("id")
        vpg = b.new_page(viewport={"width": 390, "height": 844})
        vpg.goto(BASE + "/admin.html", wait_until="networkidle", timeout=60000)
        vpg.wait_for_timeout(1200)
        vpg.fill("#passcode", VER)
        vpg.click("#gate-go")
        vpg.wait_for_timeout(2500)
        check("admin: verifier login shows Verifier role",
              vpg.is_visible("#dashboard") and "Verifier" in vpg.content())
        vpg.click('button[data-tab="listing"]')
        vpg.wait_for_timeout(2000)
        check("admin: verifier sees the open listing report",
              test_lr_id is not None and "CNG-002" in vpg.content())
        vpg.locator("#lr-list .station").first.click()
        vpg.wait_for_timeout(800)
        check("admin: verifier has NO resolve/dismiss buttons on a listing",
              vpg.locator("#lr-resolve-btn").count() == 0
              and vpg.locator("#lr-dismiss-btn").count() == 0)
        check("admin: verifier sees the read-only note",
              "can read listing reports but not resolve" in vpg.content())
        vpg.screenshot(path=OUT + "/07-admin-verifier.png")
        vpg.click("#detail-close")

        # ---------- admin dashboard: data admin ----------
        dpg = b.new_page(viewport={"width": 1280, "height": 900})
        dpg.goto(BASE + "/admin.html", wait_until="networkidle", timeout=60000)
        dpg.wait_for_timeout(1200)
        dpg.fill("#passcode", DATA)
        dpg.click("#gate-go")
        dpg.wait_for_timeout(2500)
        check("admin: data admin login shows Data admin role (desktop)",
              dpg.is_visible("#dashboard") and "Data admin" in dpg.content())
        dpg.click('button[data-tab="listing"]')
        dpg.wait_for_timeout(2000)
        dpg.locator("#lr-list .station").first.click()
        dpg.wait_for_timeout(800)
        check("admin: data admin HAS resolve/dismiss buttons",
              dpg.locator("#lr-resolve-btn").count() == 1
              and dpg.locator("#lr-dismiss-btn").count() == 1)
        dpg.screenshot(path=OUT + "/08-admin-dataadmin.png")

        # ---------- desktop: operator portal + home ----------
        dsk = b.new_page(viewport={"width": 1280, "height": 900})
        dsk.goto(BASE + "/?view=operator", wait_until="networkidle", timeout=60000)
        dsk.wait_for_timeout(3000)
        check("desktop: operator portal renders",
              dsk.is_visible("#view-operator.active") and dsk.is_visible("#op-business"))
        dsk.screenshot(path=OUT + "/09-operator-desktop.png")
        b.close()
finally:
    # Cleanup: delete the verifier test listing report by id.
    if test_lr_id:
        s, j = admin("delete_listing_report", SUPER, {"id": test_lr_id})
        check("cleanup: verifier test listing report deleted",
              s == 200 and j.get("ok") is True, f"HTTP {s}")
    # Re-verify Saheed's 3 reports are intact.
    s, j = admin("list_availability_reports", SUPER)
    rows = j.get("reports", []) or []
    mine = {(x.get("station_id"), x.get("status")) for x in rows}
    check("Saheed's reports intact after UI tests",
          ("CNG-018", "available") in mine and ("CNG-021", "available") in mine
          and ("CNG-009", "finished") in mine, f"rows={len(rows)}")
    # And the older CNG-156 history row is untouched.
    check("older CNG-156 history row untouched",
          ("CNG-156", "available") in mine, f"rows={len(rows)}")

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
