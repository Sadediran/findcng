#!/usr/bin/env python3
"""Phase 3 AI-assistant tests against the LIVE /api/chat endpoint.

Separate from verify-live.py because LLM answers are non-deterministic:
each case checks for the facts that MUST be present (or MUST NOT be
invented) and prints the full answer so a human can judge the wording.

Cases (19 Nov 2026):
  (a) station grounding — a named station must be answered from the
      directory (Benin City + East Circular / Avbiama for CNG-002).
  (b) phone-unavailable — CNG-002 has NO phone in the directory, so the
      answer must say it is not listed and must NOT invent a number.
  (c) refusal-to-invent — CNG-004 (Agbor Road) has no fresh report, so
      the answer must say there is no recent report, not claim gas.
  (d) grounded availability — a fresh 'available' test report on CNG-002
      is created first; the answer must say available + recency. The
      test report is deleted afterwards (finally block).
  (e) counts — "How many stations does FindCNG list?" must say 721.
  (f) price — CNG price must be N380/SCM with the September 2025 date.
  (g) general knowledge — "What is the capital of France?" must say Paris.

A "fallback" provider (all AI services down) makes a case INCONCLUSIVE,
not a pass: the grounding cannot be verified from a canned answer.
Rate limit is 10 questions/minute/IP; the calls are spaced out.
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error

BASE = "https://findcng.vercel.app"
ENV = {}
with open(os.path.expanduser("~/workspace/findcng/.env.local")) as f:
    for line in f:
        line = line.strip()
        if line and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            ENV[k.strip()] = v.strip()
ADMIN = ENV["ADMIN_PASSCODE"]

fails = []
PHONE_RE = re.compile(r"(?:\+?234[\s\-]?|0)[789][01]\d[\s\-]?\d{3}[\s\-]?\d{4}\b")

def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'} - {name} {detail[:400]}")
    if not cond:
        fails.append(name)

def call(method, url, body=None, headers=None, timeout=75):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(2):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}
        except Exception:
            time.sleep(3)
    try:
        cmd = ["curl", "-s", "-w", "\n%{http_code}", "-X", method, url,
               "-H", "Content-Type: application/json", "--max-time", str(timeout)]
        for k, v in (headers or {}).items():
            cmd += ["-H", f"{k}: {v}"]
        if data is not None:
            cmd += ["--data-binary", "@-"]
        p = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout + 10)
        out = p.stdout.decode("utf-8", "replace")
        *body_lines, code = out.rsplit("\n", 1)
        return int(code), json.loads("".join(body_lines) or "{}")
    except Exception as e:
        return 0, {"error": str(e)[:120]}

def ask(q):
    """One chat question. Returns (answer, provider, degraded)."""
    s, r = call("POST", BASE + "/api/chat", {"question": q})
    if s != 200 or not r.get("ok"):
        return None, f"HTTP {s} {r.get('error', '')}", True
    return r.get("answer") or "", r.get("provider"), bool(r.get("degraded"))

def main():
    rep_id = None
    try:
        # (d) needs its fresh report created BEFORE the availability
        # question — create it up front so (c) and (d) run against the
        # same live state (CNG-004 still has no report of its own).
        s, r = call("POST", BASE + "/api/reports",
                    {"station_id": "CNG-002", "status": "available", "queue_minutes": 10})
        rep_id = (r.get("report") or {}).get("id")
        check("setup: fresh test report on CNG-002", s == 200 and bool(rep_id), f"HTTP {s} id={rep_id}")
        time.sleep(2)

        # (a) station grounding.
        a, prov, deg = ask("Where is the NIPCO station on 2nd East Circular Road in Benin City?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        check("chat (a) grounding: Benin City + East Circular/Avbiama",
              not deg and a and "Benin City" in a and ("East Circular" in a or "Avbiama" in a),
              f"provider={prov}")
        time.sleep(8)

        # (b) phone-unavailable — CNG-002 has no phone in the directory.
        a, prov, deg = ask("What is the phone number of the NIPCO station on 2nd East Circular Road in Benin City?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        no_phone = bool(re.search(r"not listed|information unavailable|no phone|don't have|does not list|isn't listed", a or "", re.I))
        invented = bool(PHONE_RE.search(a or ""))
        check("chat (b) phone: says not listed, invents no number",
              not deg and a and no_phone and not invented,
              f"provider={prov} invented={invented}")
        time.sleep(8)

        # (c) refusal-to-invent — CNG-004 Agbor Road has no fresh report.
        a, prov, deg = ask("Is there gas at the NIPCO station on Agbor Road in Benin City right now?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        refusal = bool(re.search(r"no recent report|no fresh report|no report|can't confirm|cannot confirm|don't know|do not know|no live|not sure|no driver", a or "", re.I))
        positive_claim = bool(re.search(r"gas (is|was) available|gas available right now|yes, (there is|it has) gas", a or "", re.I))
        check("chat (c) refusal: says no recent report, claims no gas",
              not deg and a and refusal and not positive_claim,
              f"provider={prov}")
        time.sleep(8)

        # (d) grounded availability — the fresh CNG-002 report is live.
        a, prov, deg = ask("Is there gas at the NIPCO station on 2nd East Circular Road in Benin City right now?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        check("chat (d) grounded availability: available + recency",
              not deg and a and "available" in a.lower()
              and bool(re.search(r"just now|minute|reported|recent|latest", a, re.I)),
              f"provider={prov}")
        time.sleep(8)

        # (e) counts.
        a, prov, deg = ask("How many stations does FindCNG list?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        check("chat (e) counts: 721", not deg and a and "721" in a, f"provider={prov}")
        time.sleep(8)

        # (f) price.
        a, prov, deg = ask("How much does CNG cost per SCM for a car in Nigeria?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        check("chat (f) price: N380 + September 2025",
              not deg and a and "380" in a and bool(re.search(r"September|Sep\.? 2025", a)),
              f"provider={prov}")
        time.sleep(8)

        # (g) general knowledge.
        a, prov, deg = ask("What is the capital of France?")
        print(f"  [provider={prov} degraded={deg}] {a}")
        check("chat (g) general knowledge: Paris", not deg and a and "Paris" in a, f"provider={prov}")
    finally:
        if rep_id:
            # Admin passcode goes in the X-Admin-Passcode header, NOT the
            # body (the first run of this script sent it in the body and
            # got 401, leaving an orphaned test report behind).
            s, r = call("POST", BASE + "/api/admin",
                        {"action": "delete_availability_report", "id": rep_id},
                        headers={"X-Admin-Passcode": ADMIN})
            print(f"cleanup — test availability report deleted: {s} {r.get('ok')}")
        # Saheed's 3 real reports must still be intact. GET /api/reports
        # only returns FRESH reports (2h window), so check the admin
        # history list instead — his reports are hours old by now.
        s, r = call("POST", BASE + "/api/admin",
                    {"action": "list_availability_reports"},
                    headers={"X-Admin-Passcode": ADMIN})
        rows = r.get("reports", []) if isinstance(r, dict) else []
        for sid in ("CNG-018", "CNG-021", "CNG-009"):
            n = sum(1 for row in rows if row.get("station_id") == sid)
            check(f"Saheed's report {sid} intact (1 row)", n == 1, f"rows={n}")

    print()
    if fails:
        print(f"RESULT: {len(fails)} FAILING — {fails}")
        sys.exit(1)
    print("RESULT: ALL PASS")

if __name__ == "__main__":
    main()
