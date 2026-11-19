#!/usr/bin/env python3
"""Phase 3 live UI verification for FindCNG (19 Nov 2026).
Drives the DEPLOYED site in headless Chromium (Playwright) and checks the
CNG Intelligence dashboard, the availability confidence system, the
calculator v2 maths, and the reporting + submission-tracking flows end to
end, then screenshots each state for human viewing.

Creates test rows (one availability report + confirmations + listing
reports) and DELETES every one afterwards via the admin API — zero
lasting pollution. Saheed's own reports (CNG-018/021/009) are never
touched: all test rows use CNG-002/CNG-003.
Screenshots go to /tmp/findcng-phase3/."""
import json, os, re, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

BASE = "https://findcng.vercel.app"
OUT = "/tmp/findcng-phase3"
os.makedirs(OUT, exist_ok=True)

ENV = {}
with open(os.path.expanduser("~/workspace/findcng/.env.local")) as f:
    for line in f:
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()
ADMIN = ENV["ADMIN_PASSCODE"]

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

def expected_confidence(age_min, counts):
    """Mirror of js/app.js confidenceFor (age in minutes)."""
    yes, no = counts.get("yes", 0), counts.get("no", 0)
    net = yes - no
    if no > yes and no >= 1:
        return "Disputed report"
    if age_min <= 30 and net >= 2:
        return "High confidence"
    if (age_min <= 60 and net >= 1) or age_min <= 15:
        return "Medium confidence"
    return "Low confidence"

# --- Test data: one fresh report on CNG-002 (NIPCO 2nd East Circular Rd) ---
s, r = api("POST", BASE + "/api/reports",
           {"station_id": "CNG-002", "status": "available", "queue_minutes": 10})
rep_id = (r.get("report") or {}).get("id")
print("INFO — test report id:", rep_id)
if not rep_id:
    print("FATAL — could not create the test report; aborting UI checks")
    sys.exit(1)

try:
    with sync_playwright() as pw:
        launch_kwargs = dict(
            executable_path=os.path.expanduser(
                "~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"),
            args=["--no-sandbox", "--ignore-certificate-errors"],
            proxy={"server": "http://127.0.0.1:18080"})
        b = pw.chromium.launch(**launch_kwargs)
        # accept_downloads=True: the calculator download test needs the
        # browser to actually emit the download event (with the default
        # False, Chromium blocks the download and expect_download times
        # out — found by the first run of this script).
        ctx = b.new_context(viewport={"width": 390, "height": 844}, accept_downloads=True)
        pg = ctx.new_page()
        console_errors = []
        pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: console_errors.append(str(e)))

        # 1. Intelligence dashboard renders with real figures.
        pg.goto(BASE + "/?view=intelligence", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3500)
        body = pg.inner_text("#intelligence-body")
        check("intelligence: national overview (721 / 134 / 617 / 30 of 37)",
              "721" in body and "134" in body and "617" in body and "30 of 37" in body, body[:200].replace("\n", " | "))
        # STRICT: the empty state ("no fresh driver report in the last
        # 2 hours") must NOT pass — only the "1 station(s)" line counts.
        # Reports arrive after the directory, so poll for up to 15 s.
        live_ok = False
        for _ in range(15):
            if "1 station(s) have a fresh driver report" in pg.inner_text("#intelligence-body"):
                live_ok = True
                break
            pg.wait_for_timeout(1000)
        check("intelligence: live-right-now counts the fresh report", live_ok, "")
        check("intelligence: no separate operational register (honest)",
              "does not keep a separate" in body and "operational" in body, "")
        check("intelligence: pin precision (95 / 343 / 71)",
              "95" in body and "343" in body and "71" in body, "")
        check("intelligence: state table (Lagos 190, FCT 152)",
              "Lagos" in body and "190" in body and "Federal Capital Territory" in body and "152" in body, "")
        check("intelligence: gaps + directory-vs-infrastructure disclaimer",
              "gaps in the DIRECTORY" in body and "may still have CNG stations" in body, "")
        check("intelligence: no-data states named (Bauchi, Zamfara)",
              "Bauchi" in body and "Zamfara" in body, "")
        check("intelligence: postcode areas (300001 Benin City GPO)",
              "300001" in body and "Benin City GPO" in body, "")
        check("intelligence: growth baseline (single snapshot, honest)",
              "Baseline recorded" in body and "No trend is drawn from a single day" in body, "")
        check("intelligence: freshness (Pi-CNG register dates)",
              "18 Nov 2026" in body and "15 Oct 2026" in body, "")
        pg.screenshot(path=f"{OUT}/01-intelligence.png", full_page=True)

        # 1b. State sort works: A–Z puts Abia first.
        pg.select_option("#intel-sort", "az")
        pg.wait_for_timeout(1500)
        rows = pg.inner_text("#intelligence-body")
        check("intelligence: A–Z sort puts Abia first",
              rows.index("Abia") < rows.index("Adamawa") < rows.index("Lagos"), "")
        pg.select_option("#intel-sort", "mapped")
        pg.wait_for_timeout(1500)
        pg.screenshot(path=f"{OUT}/02-intelligence-mapped.png", full_page=True)

        # 1c. ?view=coverage (old Phase 1 URL) still lands on intelligence.
        pg.goto(BASE + "/?view=coverage", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        check("coverage URL aliases to intelligence",
              pg.is_visible("#view-intelligence") and "CNG Intelligence" in pg.inner_text("body"), "")

        # 2. Calculator v2 — worked example 1 (defaults).
        # car, 100 km/day x 26 days, 10 km/L, 11 km/SCM, petrol 1370, CNG 380:
        # litres 260 -> 356,200; scm 236.36 -> 89,818; saving 266,382/mo;
        # daily 10,245; annual 3,196,582; 75%; payback 2-3 months.
        pg.goto(BASE + "/?view=calculator", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        out = pg.inner_text("#calc-out")
        check("calculator ex1: monthly saving ₦266,382", "₦266,382" in out, out[:400].replace("\n", " | "))
        check("calculator ex1: petrol ₦356,200 / CNG ₦89,818",
              "₦356,200" in out and "₦89,818" in out, "")
        check("calculator ex1: daily ₦10,245 + annual ₦3,196,582 + 75%",
              "₦10,245" in out and "₦3,196,582" in out and "75%" in out, "")
        check("calculator ex1: payback 2–3 months", "2–3 months" in out, "")
        check("calculator ex1: monthly saving row present", "Monthly saving" in out, "")
        check("calculator: km/SCM input present, default 11 km/SCM",
              float(pg.input_value("#calc-kmpscm")) == 11.0, pg.input_value("#calc-kmpscm"))
        pg.screenshot(path=f"{OUT}/03-calculator.png", full_page=True)

        # 2b. Worked example 2 — edited CNG use changes the result.
        # km/SCM 13 -> scm 200 -> CNG 76,000 -> saving 280,200 (79%).
        pg.fill("#calc-kmpscm", "13")
        pg.wait_for_timeout(800)
        out2 = pg.inner_text("#calc-out")
        check("calculator ex2: km/SCM 13 -> CNG ₦76,000, saving ₦280,200, 79%",
              "₦76,000" in out2 and "₦280,200" in out2 and "79%" in out2, out2[:400].replace("\n", " | "))
        # 2c. Download button produces a real .txt file.
        with pg.expect_download(timeout=10000) as dl:
            pg.click("#calc-download")
        d = dl.value
        check("calculator: download summary (.txt)", d.suggested_filename == "findcng-savings-summary.txt",
              d.suggested_filename)
        dpath = d.path()
        with open(dpath, encoding="utf-8") as fh:
            txt = fh.read()
        check("calculator: downloaded summary has the worked numbers",
              "₦280,200" in txt and "estimate, not a guarantee" in txt, txt[:200].replace("\n", " | "))

        # 3. Confidence on the detail page — fresh report, no confirmations.
        # Minutes old, no votes -> Medium confidence.
        pg.goto(BASE + "/?station=CNG-002", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3000)
        pg.wait_for_selector("#confidence-line .conf-chip", timeout=15000)
        conf = pg.inner_text("#confidence-line")
        check("detail: confidence chip present (Medium, minutes old, unconfirmed)",
              "Medium confidence" in conf, conf[:200])
        check("detail: confidence why names age + source",
              "Reported" in conf and "Community reported" in conf, conf[:200])
        check("detail: no confirmations yet", "No confirmations yet" in pg.inner_text("#station-detail"), "")
        pg.screenshot(path=f"{OUT}/04-detail-medium.png", full_page=True)

        # 3b. Two yes confirmations -> High confidence (adaptive: read the
        # real counts first — the reporter hash may collide across votes).
        api("POST", BASE + "/api/confirmations",
            {"report_id": rep_id, "station_id": "CNG-002", "vote": "yes"})
        api("POST", BASE + "/api/confirmations",
            {"report_id": rep_id, "station_id": "CNG-002", "vote": "yes"})
        api("POST", BASE + "/api/confirmations",
            {"report_id": rep_id, "station_id": "CNG-002", "vote": "yes"})
        time.sleep(1)
        s, r = api("GET", BASE + f"/api/confirmations?report_id={rep_id}")
        counts = (r.get("counts") or {})
        print("INFO — counts after 3 yes votes:", counts)
        age_min = 5  # the report is minutes old; the level check uses <=30
        expected = expected_confidence(age_min, counts)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_timeout(3000)
        pg.wait_for_selector("#confidence-line .conf-chip", timeout=15000)
        conf = pg.inner_text("#confidence-line")
        check(f"detail: confidence matches its inputs ({expected}, counts {counts})",
              expected in conf, conf[:200])
        check("detail: confirm counts shown",
              f"✓ {counts.get('yes', 0)}" in pg.inner_text("#station-detail"), "")
        pg.screenshot(path=f"{OUT}/05-detail-confirmed.png", full_page=True)

        # 3c. Disputed: enough no votes to outweigh the yes votes.
        for _ in range(4):
            api("POST", BASE + "/api/confirmations",
                {"report_id": rep_id, "station_id": "CNG-002", "vote": "no"})
        time.sleep(1)
        s, r = api("GET", BASE + f"/api/confirmations?report_id={rep_id}")
        counts = (r.get("counts") or {})
        print("INFO — counts after no votes:", counts)
        expected = expected_confidence(age_min, counts)
        pg.reload(wait_until="domcontentloaded")
        pg.wait_for_timeout(3000)
        pg.wait_for_selector("#confidence-line .conf-chip", timeout=15000)
        conf = pg.inner_text("#confidence-line")
        check(f"detail: confidence follows disputed counts ({expected}, counts {counts})",
              expected in conf, conf[:200])
        pg.screenshot(path=f"{OUT}/06-detail-disputed.png", full_page=True)

        # 4. Home feed: fresh report + confidence chip + confirm button.
        pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3500)
        home_live = pg.inner_text("#home-live")
        check("home feed: fresh report shown (2nd East Circular)",
              "2nd East Circular" in home_live, home_live[:300].replace("\n", " | "))
        check("home feed: confidence chip shown",
              pg.locator("#home-live .conf-chip").count() >= 1, "")
        check("home feed: confirm button present",
              pg.locator("#home-live .home-confirm").count() >= 1, "")
        pg.screenshot(path=f"{OUT}/07-home-live.png", full_page=True)
        pg.click("#home-live .home-confirm")
        pg.wait_for_timeout(2000)
        toast = pg.inner_text("#toast")
        check("home feed: confirm button posts a confirmation",
              "confirmation is counted" in toast, toast[:120])

        # 5. Listing sheet: new types + reference + tracking.
        pg.goto(BASE + "/?station=CNG-003", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        pg.click("text=Report an incorrect listing")
        pg.wait_for_timeout(800)
        sheet = pg.inner_text("#listing-backdrop")
        check("listing sheet: new types visible (coordinates, contact, safety)",
              "map pin" in sheet.lower() and "updated contact" in sheet.lower()
              and "safety concern" in sheet.lower(), sheet[:400].replace("\n", " | "))
        check("listing sheet: missing type hidden for an existing listing",
              "Suggest a station" not in sheet, "")
        pg.check('input[name="listing-type"][value="coordinates"]')
        pg.fill("#listing-details", "PHASE3 UI TEST — pin is on the wrong side of the road")
        pg.click("#listing-submit")
        pg.wait_for_timeout(3000)
        check("listing sheet: success shows a reference",
              pg.is_visible("#listing-success")
              and re.match(r"^[0-9a-f-]{36}$", pg.input_value("#listing-ref") or ""), pg.input_value("#listing-ref"))
        lr_ref = pg.input_value("#listing-ref")
        pg.screenshot(path=f"{OUT}/08-listing-success.png", full_page=True)
        pg.click("#listing-success-close")
        # Track it from Help (auto-filled from this device).
        pg.goto(BASE + "/?view=help", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2000)
        check("help: check-a-report auto-filled with the reference",
              pg.input_value("#lr-check-input") == lr_ref, pg.input_value("#lr-check-input")[:20])
        pg.click("#lr-check-go")
        pg.wait_for_timeout(3000)
        tracked = pg.inner_text("#lr-check-result")
        check("help: status check shows open + Wrong coordinates",
              "open" in tracked and "Wrong coordinates" in tracked, tracked[:200].replace("\n", " | "))
        pg.screenshot(path=f"{OUT}/09-help-tracking.png", full_page=True)

        # 5b. Missing-station suggestion flow from Help.
        pg.click("text=Suggest it here")
        pg.wait_for_timeout(800)
        check("missing flow: sheet title + only the missing type",
              "Suggest a missing station" in pg.inner_text("#listing-backdrop")
              and pg.locator("[data-lr-row='missing']:visible").count() == 1
              and pg.locator("[data-lr-row='incorrect']:visible").count() == 0, "")
        pg.fill("#listing-details", "PHASE3 UI TEST — Test Station, 1 Test Road, Ikeja, Lagos")
        pg.click("#listing-submit")
        pg.wait_for_timeout(3000)
        check("missing flow: success shows a reference",
              pg.is_visible("#listing-success")
              and re.match(r"^[0-9a-f-]{36}$", pg.input_value("#listing-ref") or ""), "")
        missing_ref = pg.input_value("#listing-ref")
        pg.screenshot(path=f"{OUT}/10-missing-success.png", full_page=True)
        pg.click("#listing-success-close")

        # 6. Admin: availability queue shows the test report; listing queue
        # shows the two test listing reports with mapped type labels.
        pg.goto(BASE + "/admin.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(1500)
        pg.fill("#passcode", ADMIN)
        pg.click("#gate-go")
        pg.wait_for_timeout(4000)
        admin = pg.inner_text("#queue")
        check("admin: availability queue shows the CNG-002 test report",
              "CNG-002" in admin and "available" in admin, "")
        check("admin: listing queue shows mapped labels (Wrong coordinates, Missing station)",
              "Wrong coordinates" in admin and "Missing station" in admin, admin[:500].replace("\n", " | "))
        pg.screenshot(path=f"{OUT}/11-admin.png", full_page=True)

        # 7. Home regression + desktop intelligence.
        pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(2500)
        home = pg.inner_text("body")
        check("home: hero + stats intact", "Find CNG. Find Confidence." in home and "721" in home, "")
        pg2 = b.new_page(viewport={"width": 1280, "height": 900})
        pg2.goto(BASE + "/?view=intelligence", wait_until="domcontentloaded", timeout=60000)
        pg2.wait_for_timeout(3000)
        check("desktop: intelligence loads",
              "National overview" in pg2.inner_text("#intelligence-body"), "")
        # The CNG-002 test report is still live here (cleanup runs after),
        # so a fresh desktop load must also pick it up in "Live right now".
        live2_ok = False
        for _ in range(15):
            if "1 station(s) have a fresh driver report" in pg2.inner_text("#intelligence-body"):
                live2_ok = True
                break
            pg2.wait_for_timeout(1000)
        check("desktop: live-right-now counts the fresh report", live2_ok, "")
        pg2.screenshot(path=f"{OUT}/12-intelligence-desktop.png", full_page=True)
        pg2.close()

        # 8. Console errors from our own code.
        ours = [e for e in console_errors
                if "findcng" in e.lower() or "uncaught" in e.lower()
                or "referenceerror" in e.lower() or "typeerror" in e.lower()]
        print("INFO — console errors captured:", len(console_errors))
        for e in console_errors[:10]:
            print("  console:", e[:200])
        check("no JS errors from app code", not ours, str(ours[:2]))
        b.close()
finally:
    # --- Cleanup: every test row deleted by id ---
    s, r = api("POST", BASE + "/api/admin",
               {"action": "delete_availability_report", "id": rep_id},
               headers={"X-Admin-Passcode": ADMIN})
    print("cleanup — test availability report deleted:", s, r.get("ok"))
    for ref in (locals().get("lr_ref"), locals().get("missing_ref")):
        if ref:
            s, r = api("POST", BASE + "/api/admin",
                       {"action": "delete_listing_report", "id": ref},
                       headers={"X-Admin-Passcode": ADMIN})
            print(f"cleanup — test listing report {ref[:8]} deleted:", s, r.get("ok"))
    # Saheed's reports untouched?
    for sid in ("CNG-018", "CNG-021", "CNG-009"):
        s, r = api("GET", BASE + f"/api/reports?station={sid}")
        n = len(r.get("reports", []))
        check(f"Saheed's report {sid} intact (1 row)", n == 1, f"rows={n}")

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
