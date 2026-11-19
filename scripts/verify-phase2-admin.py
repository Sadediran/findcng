#!/usr/bin/env python3
"""Phase 2 admin + desktop checks (19 Nov 2026). Read-only except the
admin login itself (no reports resolved/dismissed). Reads the passcode
from .env.local transiently, like verify-live.py; never prints it.
Needs the local CONNECT relay (local-proxy.js) running on 127.0.0.1:18080."""
import os, sys
from playwright.sync_api import sync_playwright

BASE = "https://findcng.vercel.app"
OUT = "/tmp/findcng-phase2"
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

with sync_playwright() as pw:
    b = pw.chromium.launch(
        executable_path=os.path.expanduser(
            "~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"),
        args=["--no-sandbox", "--ignore-certificate-errors"],
        proxy={"server": "http://127.0.0.1:18080"})
    # Admin (mobile): log in, duplicates card visible.
    pg = b.new_page(viewport={"width": 390, "height": 844})
    pg.goto(BASE + "/admin.html", wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(1500)
    pg.fill("#passcode", ADMIN)
    pg.click("#gate-go")
    pg.wait_for_timeout(3000)
    body = pg.inner_text("body")
    check("admin: queue opens", "listing report(s)" in body, "")
    check("admin: duplicates card present", "suspected duplicate places" in body, "")
    check("admin: pair 1 (CNG-282/CNG-430)", "CNG-282" in body and "CNG-430" in body, "")
    check("admin: pair 2 (CNG-387/CNG-428)", "CNG-387" in body and "CNG-428" in body, "")
    check("admin: no-merge instruction", "not" in body and "merged" in body, "")
    pg.screenshot(path=f"{OUT}/10-admin-dupes.png", full_page=True)
    # Desktop explorer.
    pg2 = b.new_page(viewport={"width": 1280, "height": 900})
    pg2.goto(BASE + "/?view=postcode", wait_until="domcontentloaded", timeout=60000)
    pg2.wait_for_timeout(2500)
    pg2.fill("#explorer-input", "FC-01-A01-KP-27")
    pg2.click("#explorer-go")
    pg2.wait_for_timeout(6000)
    result = pg2.inner_text("#explorer-result")
    check("desktop: sample confirms assigned", "Confirmed assigned" in result, "")
    pg2.screenshot(path=f"{OUT}/11-explorer-desktop.png", full_page=True)
    b.close()

print()
print("RESULT:", "ALL PASS" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
