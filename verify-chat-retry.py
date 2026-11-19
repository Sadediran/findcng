#!/usr/bin/env python3
"""Retry the live /api/chat until Gemini's free-tier spike clears, then
verify the new behaviour: general answer, Saheed's failed CNG question,
and a history follow-up ("Retry my above question")."""
import json
import subprocess
import time

URL = "https://findcng.vercel.app/api/chat"
FALLBACK_START = "The AI service is very busy"


def ask(q, hist=None):
    body = {"question": q}
    if hist:
        body["history"] = hist
    t0 = time.time()
    p = subprocess.run(
        ["curl", "-s", "-m", "70", "-X", "POST", URL,
         "-H", "Content-Type: application/json", "-d", json.dumps(body)],
        capture_output=True, text=True)
    el = round(time.time() - t0, 1)
    try:
        j = json.loads(p.stdout)
    except Exception:
        return {"error": "unparseable: " + p.stdout[:200], "elapsed": el}
    j["elapsed"] = el
    return j


def is_real(r):
    ans = r.get("answer") or ""
    return bool(r.get("ok") and not r.get("degraded") and ans
                and not ans.startswith(FALLBACK_START))


for attempt in range(1, 7):
    r = ask("What is a noun?")
    ok = is_real(r)
    print(f"attempt {attempt} {time.strftime('%H:%M:%S')} "
          f"elapsed={r.get('elapsed')} ok={r.get('ok')} "
          f"degraded={r.get('degraded')} success={ok}", flush=True)
    if ok:
        print("GENERAL ANSWER:", (r.get("answer") or "")[:300], flush=True)
        r2 = ask("Is CNG cylinder also measured in KG?")
        print("CNG Q elapsed:", r2.get("elapsed"),
              "degraded:", r2.get("degraded"), flush=True)
        print("CNG ANSWER:", (r2.get("answer") or "")[:300], flush=True)
        hist = [{"role": "user", "text": "Is CNG cylinder also measured in KG?"},
                {"role": "model", "text": r2.get("answer") or ""}]
        r3 = ask("Retry my above question", hist)
        print("HISTORY Q elapsed:", r3.get("elapsed"),
              "degraded:", r3.get("degraded"), flush=True)
        print("HISTORY ANSWER:", (r3.get("answer") or "")[:300], flush=True)
        print("VERIFY DONE: SUCCESS", flush=True)
        break
    if attempt < 6:
        time.sleep(60)
else:
    print("VERIFY DONE: STILL DOWN AFTER 6 ATTEMPTS", flush=True)
