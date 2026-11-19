#!/usr/bin/env python3
"""Verify conversation memory live: ask Saheed's cylinder question, then
ask 'Retry my above question' WITH that exchange as history. Success =
the retry re-answers about cylinders instead of saying it cannot see the
previous question."""
import json
import subprocess
import time

URL = "https://findcng.vercel.app/api/chat"
FALLBACK_START = "The AI service is very busy"
Q1 = "Is CNG cylinder also measured in KG?"


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
        return {"error": "unparseable", "elapsed": el}
    j["elapsed"] = el
    return j


def is_real(r):
    ans = r.get("answer") or ""
    return bool(r.get("ok") and not r.get("degraded") and ans
                and not ans.startswith(FALLBACK_START))


for attempt in range(1, 6):
    r1 = ask(Q1)
    print(f"attempt {attempt} {time.strftime('%H:%M:%S')} "
          f"Q1 elapsed={r1.get('elapsed')} real={is_real(r1)}", flush=True)
    if is_real(r1):
        hist = [{"role": "user", "text": Q1},
                {"role": "model", "text": r1["answer"]}]
        r2 = ask("Retry my above question", hist)
        a2 = (r2.get("answer") or "")
        low = a2.lower()
        mem_ok = (is_real(r2)
                  and ("kilogram" in low or "cylinder" in low)
                  and "cannot see" not in low
                  and "previous question" not in low)
        print(f"  Q2 elapsed={r2.get('elapsed')} real={is_real(r2)} "
              f"memory_ok={mem_ok}", flush=True)
        print("  Q2 ANSWER:", a2[:300], flush=True)
        if mem_ok:
            print("HISTORY VERIFY DONE: SUCCESS", flush=True)
            break
        if is_real(r2) and not mem_ok:
            print("HISTORY VERIFY DONE: FAILED — model answered but did "
                  "not use history", flush=True)
            break
    if attempt < 5:
        time.sleep(60)
else:
    print("HISTORY VERIFY DONE: STILL DOWN AFTER 5 ATTEMPTS", flush=True)
