#!/usr/bin/env python3
"""End-to-end verification of FindCNG live APIs (zero lasting pollution).
Reads secrets from .env.local; prints only pass/fail + ids, never secrets.
Checks the V1 flows plus the 2.0 additions (confirmations, listing
reports with graceful not_open, stats/sitemap/robots).

NOTE (2.5, 18 Nov 2026): the centre-submission checks (POST /api/submissions,
admin submission list, certificate signed URL, GET /api/centres live counts)
were removed with centre self-registration."""
import json, os, subprocess, sys, time, urllib.request, urllib.error

BASE = "https://findcng.vercel.app"
ENV = {}
with open(os.path.expanduser("~/workspace/findcng/.env.local")) as f:
    for line in f:
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()
SB = ENV["SUPABASE_URL"].rstrip("/")
SRV = ENV["SUPABASE_SERVICE_ROLE_KEY"]
ADMIN = ENV["ADMIN_PASSCODE"]

def call(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    last = (0, {})
    for attempt in range(3):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}
        except Exception as e:
            # Transient egress/proxy drops (RemoteDisconnected etc.) — retry.
            last = (0, {"error": str(e)[:120]})
            time.sleep(2 * (attempt + 1))
    # urllib's chunked reads through the egress proxy truncate
    # intermittently on larger responses (IncompleteRead — /api/news
    # failed 3/3 attempts on 19 Nov 2026) while curl delivers the same
    # URL cleanly in both plain and gzip modes. One curl attempt as a
    # fallback before giving up, so a proxy quirk can't fail a healthy
    # endpoint.
    try:
        cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, url,
               "-H", "Content-Type: application/json", "--max-time", "30"]
        for k, v in (headers or {}).items():
            cmd += ["-H", f"{k}: {v}"]
        if data is not None:
            cmd += ["--data-binary", "@-"]
        p = subprocess.run(cmd, input=data, capture_output=True, timeout=40)
        out = p.stdout.decode("utf-8", "replace")
        *body_lines, code = out.rsplit("\n", 1)
        return int(code), json.loads("".join(body_lines) or "{}")
    except Exception:
        return last

fails = []
def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), "-", name, detail)
    if not cond:
        fails.append(name)

def check_news_feed():
    """News feed (2.2) — GET /api/news returns items newest-first, and
    must pass in BOTH live mode (news_items table exists) and
    static-fallback mode (table missing; the 9 saved seed items).
    Read-only: zero lasting pollution."""
    from datetime import datetime, timezone
    def ts(iso):
        try:
            d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            return d if d.tzinfo is not None else d.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    s, r = call("GET", BASE + "/api/news")
    items = r.get("items", [])
    stamps = [ts(x.get("published_at")) for x in items]
    stamps = [t for t in stamps if t is not None]
    newest_first = all(stamps[i] >= stamps[i + 1] for i in range(len(stamps) - 1))
    shape_ok = all(x.get("title") and x.get("source_url") for x in items)
    check("GET /api/news newest-first (live or static-fallback)",
          s == 200 and r.get("ok") is True and r.get("source") in ("live", "static-fallback")
          and isinstance(items, list) and len(items) >= 1 and newest_first and shape_ok,
          f"HTTP {s} source={r.get('source')} items={len(items)} total={r.get('total')}")
    # Pagination: ?limit=2 returns at most 2 items, same newest item first.
    s2, r2 = call("GET", BASE + "/api/news?limit=2")
    items2 = r2.get("items", [])
    same_first = (not items2 and not items) or (
        items2 and items and items2[0].get("source_url") == items[0].get("source_url"))
    check("GET /api/news?limit=2 paginates",
          s2 == 200 and r2.get("ok") is True and len(items2) <= 2 and same_first,
          f"HTTP {s2} items={len(items2)}")

# 1. GET /api/reports (should be configured now)
s, r = call("GET", BASE + "/api/reports")
check("GET /api/reports configured", s == 200 and r.get("configured") is True, f"HTTP {s}")

# 2. POST a test report
s, r = call("POST", BASE + "/api/reports", {"station_id": "CNG-001", "status": "available", "queue_minutes": 5})
rep = (r.get("report") or {})
rep_id = rep.get("id")
check("POST /api/reports", s == 200 and r.get("ok") is True and rep_id, f"HTTP {s} id={rep_id}")

# 3. Confirm it appears in GET
s, r = call("GET", BASE + "/api/reports")
found = any(x.get("id") == rep_id for x in r.get("reports", [])) if rep_id else False
# GET selects no id column (station_id,status,queue_minutes,...) — match on station+status+queue instead
found2 = any(x.get("station_id") == "CNG-001" and x.get("status") == "available" and x.get("queue_minutes") == 5
             for x in r.get("reports", []))
check("test report visible in GET", found or found2, f"HTTP {s} reports={len(r.get('reports', []))}")

# 4. GET /api/confirmations — ok with counts if sql/001 was run, else honest not_open
if rep_id:
    s, r = call("GET", BASE + f"/api/confirmations?report_id={rep_id}")
    graceful = (s == 200 and r.get("ok") is True and isinstance(r.get("counts"), dict)) or \
               (s == 503 and r.get("error") == "not_open")
    check("GET /api/confirmations (ok or graceful not_open)", graceful, f"HTTP {s} keys={list(r.keys())}")
else:
    check("GET /api/confirmations (ok or graceful not_open)", False, "no test report id")

# 5. POST /api/listing-reports — ok with id if sql/001 was run, else honest not_open
s, r = call("POST", BASE + "/api/listing-reports",
            {"station_id": "CNG-001", "report_type": "other", "details": "TEST DELETE ME"})
lr_id = r.get("id")
graceful = (s == 200 and r.get("ok") is True and lr_id) or (s == 503 and r.get("error") == "not_open")
check("POST /api/listing-reports (ok or graceful not_open)", graceful, f"HTTP {s} id={lr_id}")

# 6. Static 2.0 files live: stats.json, sitemap.xml, robots.txt
s, r = call("GET", BASE + "/data/stats.json")
consistent = (s == 200 and isinstance(r.get("total_records"), int) and r["total_records"] > 0
    and r.get("refuelling_locations", 0) + r.get("conversion_centres", 0) >= r["total_records"]
    and r.get("picng_register_matched", 0) <= r.get("conversion_centres", 0)
    and r.get("states_with_data", 0) <= 37)
check("GET /data/stats.json (consistent categories)", consistent,
      f"HTTP {s} total={r.get('total_records')} refuel={r.get('refuelling_locations')} conv={r.get('conversion_centres')}")
def fetch_text(url):
    """GET a URL as text. urllib truncates large bodies through this VM's
    egress proxy (IncompleteRead), so fall back to curl, which is reliable."""
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return resp.status, resp.read().decode()
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))
    import subprocess
    p = subprocess.run(["curl", "-s", "-w", "\n%{http_code}", url],
                       capture_output=True, text=True, timeout=60)
    body, _, code = p.stdout.rpartition("\n")
    if p.returncode == 0 and code.strip() == "200":
        return 200, body
    raise last

try:
    s, sm = fetch_text(BASE + "/sitemap.xml")
    check("GET /sitemap.xml", s == 200 and "?station=CNG-001" in sm and "?state=Lagos" in sm,
          f"urls={sm.count('<url>')}")
except Exception as e:
    check("GET /sitemap.xml", False, str(e)[:120])
try:
    s, rb = fetch_text(BASE + "/robots.txt")
    check("GET /robots.txt", s == 200 and "Sitemap:" in rb and "Disallow: /admin.html" in rb)
except Exception as e:
    check("GET /robots.txt", False, str(e)[:120])

# 6b. News feed (2.2) — live or static-fallback, newest first
check_news_feed()

def check_chat():
    """Chat smoke test (zero lasting pollution — the chat writes nothing).
    POSTs the fixed safety question 'Is CNG safe?'. If the Gemini key is
    absent, the route must answer configured:false gracefully (HTTP 200,
    answer null). If the key is present, it must return a non-empty answer
    and NO sources field (sources were removed from the chat 18 Nov 2026).
    Also checks the 500-char limit (600 chars -> 400)."""
    s, r = call("POST", BASE + "/api/chat", {"question": "Is CNG safe?"})
    if r.get("configured") is False:
        check("POST /api/chat (no key: graceful configured:false)",
              s == 200 and r.get("answer") is None, f"HTTP {s}")
        return
    answered = (s == 200 and r.get("configured") is True and r.get("ok") is True
                and isinstance(r.get("answer"), str) and len(r["answer"].strip()) > 0
                and "sources" not in r and "Sources:" not in r.get("answer", ""))
    check("POST /api/chat (key set: non-empty answer, no sources)", answered,
          f"HTTP {s} answer_len={len((r.get('answer') or ''))} search={r.get('search_available')}")
    s2, r2 = call("POST", BASE + "/api/chat", {"question": "x" * 600})
    check("POST /api/chat (600 chars -> 400)", s2 == 400, f"HTTP {s2}")

check_chat()

# 7. Cleanup via Supabase REST (service key) — report row, listing-report row
hdrs = {"apikey": SRV, "Authorization": f"Bearer {SRV}"}
if rep_id:
    s, _ = call("DELETE", f"{SB}/rest/v1/availability_reports?id=eq.{rep_id}", headers=hdrs)
    check("cleanup: test report deleted", s in (200, 204), f"HTTP {s}")
if lr_id:
    s, _ = call("DELETE", f"{SB}/rest/v1/listing_reports?id=eq.{lr_id}", headers=hdrs)
    check("cleanup: test listing report deleted", s in (200, 204), f"HTTP {s}")
# 8. Confirm the test report is gone
s, r = call("GET", BASE + "/api/reports")
gone = not any(x.get("station_id") == "CNG-001" and x.get("status") == "available" and x.get("queue_minutes") == 5
               for x in r.get("reports", []))
check("test report gone after cleanup", gone)

# --- Phase 1 checks (19 Nov 2026) -------------------------------------------
# 9. Station-id validation: fake ids are rejected (400), not stored.
s, r = call("POST", BASE + "/api/reports", {"station_id": "CNG-999", "status": "available"})
check("POST /api/reports rejects unknown station_id", s == 400 and r.get("error") == "unknown station_id", f"HTTP {s}")
s, r = call("POST", BASE + "/api/listing-reports",
            {"station_id": "CNG-999", "report_type": "other", "details": "phase1 check"})
check("POST /api/listing-reports rejects unknown station_id", s == 400 and r.get("error") == "unknown station_id", f"HTTP {s}")

# 10. Dedupe: the same station + status filed twice within 2 minutes
# returns the first report (duplicate: true), not a second row. A
# changed status always files fresh (checked by the second post below
# using a different status — it must NOT be a duplicate).
s1, r1 = call("POST", BASE + "/api/reports", {"station_id": "CNG-002", "status": "low", "queue_minutes": 7})
dup_id = (r1.get("report") or {}).get("id")
s2, r2 = call("POST", BASE + "/api/reports", {"station_id": "CNG-002", "status": "low", "queue_minutes": 7})
check("duplicate report returns duplicate:true, same id",
      s1 == 200 and r1.get("ok") is True and s2 == 200 and r2.get("duplicate") is True
      and (r2.get("report") or {}).get("id") == dup_id,
      f"HTTP {s1}/{s2} id={dup_id}")
s3, r3 = call("POST", BASE + "/api/reports", {"station_id": "CNG-002", "status": "available"})
chg_id = (r3.get("report") or {}).get("id")
check("changed status files fresh (not a duplicate)",
      s3 == 200 and r3.get("ok") is True and r3.get("duplicate") is not True and chg_id and chg_id != dup_id,
      f"HTTP {s3} id={chg_id}")
for rid in (dup_id, chg_id):
    if rid:
        s, _ = call("DELETE", f"{SB}/rest/v1/availability_reports?id=eq.{rid}", headers=hdrs)
        check(f"cleanup: dedupe test report {rid[:8]} deleted", s in (200, 204), f"HTTP {s}")

# 11. Admin passcode still works after the fail-closed change (read-only list).
s, r = call("POST", BASE + "/api/admin", {"action": "list_listing_reports", "status": "open"},
            headers={"X-Admin-Passcode": ADMIN})
check("POST /api/admin with real passcode lists reports",
      s == 200 and r.get("ok") is True and isinstance(r.get("reports"), list),
      f"HTTP {s} reports={len(r.get('reports', [])) if isinstance(r.get('reports'), list) else '?'}")

# 12. Security headers + Phase 1 shell (hero, service-worker cache version).
# Headers via curl -I (urllib truncates chunked reads through the egress
# proxy — IncompleteRead — so the body check uses fetch_text's curl fallback).
try:
    p = subprocess.run(["curl", "-s", "-I", "--max-time", "30", BASE + "/"],
                       capture_output=True, text=True, timeout=40)
    hdrs_lower = p.stdout.lower()
    check("security headers present",
          "x-content-type-options: nosniff" in hdrs_lower
          and "referrer-policy: strict-origin-when-cross-origin" in hdrs_lower
          and "x-frame-options: sameorigin" in hdrs_lower,
          "curl -I " + BASE)
except Exception as e:
    check("security headers present", False, str(e)[:120])
try:
    s, body = fetch_text(BASE + "/")
    check("homepage carries the Phase 1 hero", s == 200 and "Find CNG. Find Confidence." in body)
except Exception as e:
    check("homepage carries the Phase 1 hero", False, str(e)[:120])
try:
    s, sw = fetch_text(BASE + "/sw.js")
    check("sw.js cache is findcng-v3.1.0", s == 200 and "findcng-v3.1.0" in sw)
except Exception as e:
    check("sw.js cache is findcng-v3.1.0", False, str(e)[:120])
try:
    s, sm = fetch_text(BASE + "/sitemap.xml")
    check("sitemap lists the new views",
          s == 200 and "?view=coverage" in sm and "?view=postcode" in sm, f"urls={sm.count('<url>')}")
except Exception as e:
    check("sitemap lists the new views", False, str(e)[:120])

# --- Phase 2 checks (19 Nov 2026): NIPOST postcode proxy -------------------
# Read-only: lookups write nothing. Expectations are the SANDBOX truths
# verified 19 Nov 2026 — the sandbox only resolves NIPOST's published
# sample codes, and our test key is granted L1 only.
def check_postcode():
    s, r = call("POST", BASE + "/api/postcode", {"action": "status"})
    check("POST /api/postcode status reports mode",
          s == 200 and r.get("configured") is True and r.get("mode") in ("sandbox", "live"),
          f"HTTP {s} mode={r.get('mode')}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "lookup", "code": "FC-01-A01-KP-27"})
    res = r.get("result") or {}
    check("sandbox sample FC-01-A01-KP-27 validates true",
          s == 200 and res.get("valid") is True and res.get("status") == "valid",
          f"HTTP {s} valid={res.get('valid')}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "lookup", "code": "FC 02 A09 DB 09"})
    res = r.get("result") or {}
    check("format example FC 02 A09 DB 09 is not_found in sandbox (expected)",
          s == 200 and res.get("valid") is False and res.get("status") == "not_found",
          f"HTTP {s} valid={res.get('valid')} status={res.get('status')}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "lookup", "code": "FC-01-A01-KP-27", "level": 2})
    # L2 on the current L1-only key answers not_granted (the client falls
    # back to L1); a future L2-granted key would return address fields.
    # Either outcome proves the proxy handles the level honestly.
    ok = (s == 200 and ((r.get("error") == "not_granted") or ((r.get("result") or {}).get("valid") is True)))
    check("L2 lookup handled honestly (not_granted on L1-only key, or valid)",
          ok, f"HTTP {s} error={r.get('error')} valid={(r.get('result') or {}).get('valid')}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "states"})
    states = ((r.get("result") or {}).get("states") or [])
    ed = [x for x in states if x.get("code") == "ED"]
    check("states reference lists 37 states incl. ED=Edo",
          s == 200 and len(states) == 37 and ed and ed[0].get("name") == "Edo",
          f"HTTP {s} states={len(states)}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "lgas", "state": "ED"})
    lgas = ((r.get("result") or {}).get("lgas") or [])
    oredo = [x for x in lgas if x.get("code") == "12"]
    check("lgas reference lists Edo LGAs incl. 12=Oredo",
          s == 200 and len(lgas) == 18 and oredo and oredo[0].get("name") == "Oredo",
          f"HTTP {s} lgas={len(lgas)}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "districts", "state": "FC", "lga": "01"})
    dists = ((r.get("result") or {}).get("districts") or [])
    check("districts reference lists FC/01 incl. A01",
          s == 200 and any(x.get("code") == "A01" for x in dists),
          f"HTTP {s} districts={len(dists)}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "search", "q": "F"})
    sugg = ((r.get("result") or {}).get("suggestions") or [])
    check("autocomplete for 'F' suggests FC",
          s == 200 and any(x.get("code") == "FC" for x in sugg),
          f"HTTP {s} suggestions={len(sugg)}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "reverse", "lat": 9.0579, "lng": 7.4951})
    res = r.get("result") or {}
    check("reverse lookup answers honestly (found:false in sandbox)",
          s == 200 and res.get("found") is False,
          f"HTTP {s} found={res.get('found')}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "bogus"})
    check("unknown postcode action -> 400", s == 400, f"HTTP {s}")
    s, r = call("POST", BASE + "/api/postcode", {"action": "lookup", "code": ""})
    check("empty postcode code -> 400", s == 400, f"HTTP {s}")

check_postcode()

print()
print("RESULT:", "ALL PASS — live APIs verified end to end" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
