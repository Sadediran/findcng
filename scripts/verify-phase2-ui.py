#!/usr/bin/env python3
"""Phase 2 live UI verification for FindCNG (19 Nov 2026).
Drives the DEPLOYED site in headless Chromium (Playwright) and checks the
Postcode Explorer flows end to end, then screenshots each state for human
viewing. Read-only: no reports, no test rows, nothing written anywhere.
Screenshots go to /tmp/findcng-phase2/."""
import sys, time
from playwright.sync_api import sync_playwright

BASE = "https://findcng.vercel.app"
OUT = "/tmp/findcng-phase2"
import os
os.makedirs(OUT, exist_ok=True)

fails = []
def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), "-", name, detail)
    if not cond:
        fails.append(name)

with sync_playwright() as pw:
    # Chromium cannot do egress-proxy auth, so drive it through the
    # local test-only CONNECT relay (local-proxy.js on 127.0.0.1:18080),
    # which adds the proxy auth server-side. The relay must be running.
    launch_kwargs = dict(
        executable_path=os.path.expanduser(
            "~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"),
        # Test-only browser flag: the VM egress proxy intercepts TLS, so
        # Chromium needs --ignore-certificate-errors here (curl uses the
        # proxy CA bundle via CURL_CA_BUNDLE; Chromium has no such env var).
        args=["--no-sandbox", "--ignore-certificate-errors"],
        proxy={"server": "http://127.0.0.1:18080"})
    b = pw.chromium.launch(**launch_kwargs)
    pg = b.new_page(viewport={"width": 390, "height": 844})
    console_errors = []
    pg.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: console_errors.append(str(e)))

    # 1. Explorer loads, mode line says sandbox.
    pg.goto(BASE + "/?view=postcode", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    mode = pg.inner_text("#explorer-mode")
    check("explorer mode line says sandbox", "sandbox" in mode.lower(), mode[:100])
    pg.screenshot(path=f"{OUT}/01-explorer.png", full_page=True)

    # 2. Sandbox sample code -> segments named + confirmed assigned.
    pg.fill("#explorer-input", "FC-01-A01-KP-27")
    pg.click("#explorer-go")
    pg.wait_for_timeout(6000)
    result = pg.inner_text("#explorer-result")
    check("sample: state named (Federal Capital Territory)", "Federal Capital Territory" in result, "")
    check("sample: LGA named (Abaji)", "Abaji" in result, "")
    check("sample: district listed", "listed" in result, "")
    check("sample: confirmed assigned (sandbox)", "Confirmed assigned" in result and "sandbox" in result, result[:300].replace("\n", " | "))
    check("sample: L1-only autofill note", "L1-only" in result, "")
    check("sample: discovery block present", "Find CNG near this postcode" in result, "")
    pg.screenshot(path=f"{OUT}/02-explorer-sample.png", full_page=True)

    # 3. Format example -> structure valid, not found in sandbox.
    pg.fill("#explorer-input", "FC 02 A09 DB 09")
    pg.click("#explorer-go")
    pg.wait_for_timeout(6000)
    result = pg.inner_text("#explorer-result")
    check("format example: LGA named (Abuja Municipal)", "Abuja Municipal" in result, "")
    check("format example: not found in sandbox (honest)", "Not found in the sandbox" in result, result[:300].replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/03-explorer-notfound.png", full_page=True)

    # 4. Edo code -> ED named Edo, LGA 12 named Oredo.
    pg.fill("#explorer-input", "ED 12 A01 AA 01")
    pg.click("#explorer-go")
    pg.wait_for_timeout(6000)
    result = pg.inner_text("#explorer-result")
    check("Edo code: state named Edo", "Edo" in result, "")
    check("Edo code: LGA 12 named Oredo", "Oredo" in result, "")
    pg.screenshot(path=f"{OUT}/04-explorer-edo.png", full_page=True)

    # 5. Invalid input -> clear error, no crash.
    pg.fill("#explorer-input", "hello")
    pg.click("#explorer-go")
    pg.wait_for_timeout(1000)
    msg = pg.inner_text("#explorer-msg")
    check("invalid input: helpful error", "postcode" in msg.lower(), msg[:120])
    pg.fill("#explorer-input", "FC 00 A01 AA 01")
    pg.click("#explorer-go")
    pg.wait_for_timeout(1000)
    msg = pg.inner_text("#explorer-msg")
    check("00 segment rejected", "01 to 99" in msg, msg[:120])

    # 6. 6-digit code -> place + nearest stations with distances.
    pg.fill("#explorer-input", "300001")
    pg.click("#explorer-go")
    pg.wait_for_timeout(3000)
    result = pg.inner_text("#explorer-result")
    check("6-digit: Benin City GPO", "Benin City GPO" in result, "")
    check("6-digit: nearest stations with distances", "Nearest mapped stations" in result and (" km" in result or " m" in result), result[:300].replace("\n", " | "))
    pg.screenshot(path=f"{OUT}/05-explorer-six.png", full_page=True)

    # 7. Autocomplete: typing F suggests FC (sandbox only).
    pg.fill("#explorer-input", "F")
    pg.wait_for_timeout(2000)
    sugg = pg.inner_text("#explorer-suggest")
    check("autocomplete suggests FC for 'F'", "FC" in sugg, sugg[:120])
    pg.click(".suggest-chip")
    pg.wait_for_timeout(500)
    check("suggestion fills the input", pg.input_value("#explorer-input").strip() == "FC", pg.input_value("#explorer-input"))
    pg.screenshot(path=f"{OUT}/06-explorer-suggest.png", full_page=True)

    # 8. Station detail shows the verification card.
    pg.goto(BASE + "/?station=CNG-282", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    detail = pg.inner_text("#station-detail")
    check("detail CNG-282: verification card", "Verification" in detail, "")
    check("detail CNG-282: accredited + date", "Officially accredited" in detail and "18 Nov 2026" in detail, "")
    check("detail CNG-282: source shown", "Source:" in detail, "")
    pg.screenshot(path=f"{OUT}/07-detail-282.png", full_page=True)

    # 9. A stale-2024-list entry shows needs re-verification (not valid).
    pg.goto(BASE + "/?station=CNG-001", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    detail = pg.inner_text("#station-detail")
    pg.screenshot(path=f"{OUT}/08-detail-001.png", full_page=True)
    print("INFO — CNG-001 detail snippet:", detail[:400].replace("\n", " | "))

    # 10. Home still loads (no regression on the demo-critical view).
    pg.goto(BASE + "/", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    home = pg.inner_text("body")
    check("home: hero intact", "Find CNG. Find Confidence." in home, "")
    check("home: stats intact", "721" in home, "")
    pg.screenshot(path=f"{OUT}/09-home.png", full_page=True)

    # 11. Console errors (map tile failures through the egress proxy are
    # expected noise — the app falls back to street tiles; only fail on
    # JS errors from our own code).
    ours = [e for e in console_errors if "findcng" in e.lower() or "uncaught" in e.lower() or "referenceerror" in e.lower() or "typeerror" in e.lower()]
    print("INFO — console errors captured:", len(console_errors))
    for e in console_errors[:10]:
        print("  console:", e[:200])
    check("no JS errors from app code", not ours, str(ours[:2]))
    b.close()

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
