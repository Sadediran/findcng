#!/usr/bin/env python3
"""End-to-end verification of FindCNG live APIs (zero lasting pollution).
Reads secrets from .env.local; prints only pass/fail + ids, never secrets.
Checks the V1 flows plus the 2.0 additions (confirmations, listing
reports with graceful not_open, stats/sitemap/robots).

NOTE (2.5, 18 Nov 2026): the centre-submission checks (POST /api/submissions,
admin submission list, certificate signed URL, GET /api/centres live counts)
were removed with centre self-registration."""
import json, os, sys, time, urllib.request, urllib.error

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

print()
print("RESULT:", "ALL PASS — live APIs verified end to end" if not fails else f"{len(fails)} FAILURES: {fails}")
sys.exit(1 if fails else 0)
