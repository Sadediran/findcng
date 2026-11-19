#!/usr/bin/env python3
"""Build the FindCNG app data files from the master dataset.

Inputs:  ~/workspace/cng-project/data/stations.json (master, READ-ONLY here)
Outputs: ~/workspace/findcng/data/stations.json  (compact, app-ready)
         ~/workspace/findcng/data/postcodes.json (6-digit lookup + fallbacks)
         ~/workspace/findcng/data/stats.json     (honest categories, computed)
         ~/workspace/findcng/sitemap.xml         (station + state URLs)

Rules (do not weaken):
- NEVER invent coordinates. A station's lat/lng comes only from the master
  dataset. Stations without coordinates are listed with their address only.
- NEVER hardcode statistics in the app. Every number on the site comes from
  data/stats.json (build time). (The /api/centres runtime counts were
  removed in 2.5 with centre self-registration.)
- LGA is NOT carried into the app data: ~20% of Pi-CNG LGA values are wrong
  (COVERAGE-REPORT.md §0). The app never filters or displays LGA.
- Postcode coordinates are APPROXIMATE district/town centres, clearly flagged.
  Benin City values are derived from the mean of the mapped Edo stations;
  300104/330101/110115 come from stations carrying those postcodes.
  Ikeja/Abuja/Ekpoma are well-known town centres, flagged approximate.
  They are used ONLY to centre the map for a postcode search — never
  attached to a station.
- NAME CLEANING (Phase 1, 19 Nov 2026): the master dataset carries raw
  register names — operator casing varies ("SAFE AUTOGAS LTD" vs
  "Safe Autogas Ltd"), some names repeat the operator after the em dash,
  some addresses end with a stray comma/period, and one name has a double
  space. Those are normalised HERE at build time (never in the master —
  the merge pipeline would reintroduce the raw forms). Normalisation is
  display-only: it never deletes, merges or moves an entry, and every
  change is printed so it can be audited.
"""
import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

SRC = Path.home() / "workspace/cng-project/data/stations.json"
OUT = Path.home() / "workspace/findcng/data"
ROOT = Path.home() / "workspace/findcng"
OUT.mkdir(parents=True, exist_ok=True)

master = json.loads(SRC.read_text())
TODAY = date.today().isoformat()

# Benin City centre: mean of the mapped Edo stations (derived, not guessed).
edo = [e for e in master if e.get("latitude") and e["state"] == "Edo"]
BENIN = (round(sum(e["latitude"] for e in edo) / len(edo), 4),
         round(sum(e["longitude"] for e in edo) / len(edo), 4))
print("Benin centre (mean of", len(edo), "mapped Edo stations):", BENIN)

# All 36 states + FCT (official names, as used in the master dataset).
ALL_STATES = [
    "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue",
    "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu",
    "Federal Capital Territory", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
    "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger",
    "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba",
    "Yobe", "Zamfara",
]


def compact_source(sources):
    """One short, honest source label per entry."""
    joined = " | ".join(sources or [])
    if "conversion-centers.html" in joined:
        return "Pi-CNG accredited centres register"
    if "refuelling-stations.html" in joined:
        return "Pi-CNG refuelling register"
    if "bovas" in joined.lower():
        return "BOVAS operator locator"
    if "standarddailypress" in joined:
        return "FG free conversion list (Jul 2024)"
    if "Channels" in joined:
        return "Pi-CNG list (May 2024)"
    if "ibad" in joined.lower() or "commission" in joined.lower():
        return "News reports"
    return "Public lists"


# --- Name cleaning (Phase 1) ----------------------------------------------
# Canonical operator casing: among the spelling variants of one operator
# (grouped case-insensitively), pick the most READABLE form — not the most
# common one, because the register's dominant spelling is often ALL-CAPS
# ("SAFE AUTOGAS LTD" outnumbers "Safe Autogas Ltd" 2:1). Score (lower wins):
#   +10  the whole name is ALL-CAPS
#   +1   per word starting lowercase, except small words (and/of/the/...)
# Ties break toward the most common spelling. Single-variant operators are
# untouched, so genuine acronyms (e.g. "11 PLC (NIPCO)") stay as they are.
_SMALL_WORDS = {"and", "of", "the", "for", "a", "an", "&", "in", "on", "at"}


def _readability_penalty(form):
    cased = [c for c in form if c.isalpha()]
    score = 10 if cased and all(c.isupper() for c in cased) else 0
    for word in re.split(r"[\s\-]+", form):
        w = word.strip(".,()")
        if w and w[0].islower() and w.lower() not in _SMALL_WORDS:
            score += 1
    return score


def _operator_canonical(entries):
    by_lower = {}
    for e in entries:
        op = e.get("operator")
        if not op:
            continue
        by_lower.setdefault(op.lower(), Counter())[op] += 1
    canon = {}
    for lower, counts in by_lower.items():
        best = sorted(counts.items(),
                      key=lambda kv: (_readability_penalty(kv[0]), -kv[1]))[0][0]
        for form in counts:
            canon[form] = best
    return canon


def clean_name(name, operator):
    """Collapse whitespace; use the canonical operator spelling for the
    head when the head IS the operator ("PENTSERVE… — X" -> "Pentserve… — X");
    drop a repeated operator prefix after the em dash
    ("OPERATOR — OPERATOR Place" -> "OPERATOR — Place")."""
    if not name:
        return name
    out = re.sub(r"\s+", " ", str(name)).strip()
    if operator and " — " in out:
        head, tail = out.split(" — ", 1)
        if head.lower() == operator.lower():
            head = operator
        if tail.lower().startswith(operator.lower()):
            rest = tail[len(operator):].strip()
            if rest:
                out = head + " — " + rest
                return out
        out = head + " — " + tail
    return out


def clean_address(address):
    """Collapse whitespace; strip a trailing comma/period left by the
    register export ("... Road, " -> "... Road")."""
    if not address:
        return address
    out = re.sub(r"\s+", " ", str(address)).strip()
    out = out.rstrip(",").rstrip(".").strip()
    return out


OPERATOR_CANON = _operator_canonical(master)
CLEAN_LOG = {"names": [], "addresses": [], "operators": []}


stations = []
for e in master:
    sources = e.get("sources") or []
    joined = " | ".join(sources)
    on_centres_register = "conversion-centers.html" in joined
    on_refuel_register = "refuelling-stations.html" in joined
    # Name cleaning (Phase 1): display-only normalisation, logged below.
    operator = OPERATOR_CANON.get(e.get("operator"), e.get("operator"))
    if operator != e.get("operator"):
        CLEAN_LOG["operators"].append((e["id"], e.get("operator"), operator))
    name = clean_name(e["name"], operator)
    if name != e["name"]:
        CLEAN_LOG["names"].append((e["id"], e["name"], name))
    address = clean_address(e.get("address"))
    if address != e.get("address"):
        CLEAN_LOG["addresses"].append((e["id"], e.get("address"), address))
    entry = {
        "id": e["id"],
        "name": name,
        "type": e["type"],                    # refuelling | conversion | both
        "operator": operator,
        "address": address,
        "city": e.get("city"),
        "state": e.get("state"),
        "zone": e.get("zone"),
        "postcode": e.get("postcode"),
        "lat": e.get("latitude"),             # null for most entries — never guessed
        "lng": e.get("longitude"),
        "phone": e.get("phone"),
        "confidence": e.get("confidence"),    # verified | single-source | stale-2024-list
        "acc": bool(on_centres_register and e["type"] in ("conversion", "both")),
        "refReg": bool(on_refuel_register and e["type"] in ("refuelling", "both")),
        "src": compact_source(sources),
    }
    # Fields the data merge may add — carried through only when sourced.
    # Never invented here: absent means "not listed" in the app.
    if e.get("category"):
        entry["category"] = e["category"]    # Mother | Daughter | Retail | Online ...
    if e.get("coord_note"):
        entry["coord_note"] = e["coord_note"]
    if e.get("coord_precision"):
        entry["coord_precision"] = e["coord_precision"]  # exact | approximate | town
    if e.get("coord_source"):
        entry["coord_source"] = e["coord_source"]  # places:<id> | nominatim | map.geocode | ...
    if e.get("photo"):
        entry["photo"] = e["photo"]  # {url, attribution} -- verified by a later workstream
    if e.get("hours"):
        entry["hours"] = e["hours"]          # string or {day: "06:00–22:00"}
    if e.get("services"):
        entry["services"] = e["services"]    # string or [..]
    if e.get("price") is not None:
        entry["price"] = e["price"]          # ₦/SCM as sourced, with price_date
    if e.get("price_date"):
        entry["price_date"] = e["price_date"]
    if e.get("picng_id") is not None:
        entry["picng_id"] = e["picng_id"]  # Pi-CNG live-API row id — the app matches /api/live-centres rows against it to spot newly listed centres (2.6)
    stations.append(entry)

(OUT / "stations.json").write_text(
    json.dumps(stations, ensure_ascii=False, separators=(",", ":")))
print("stations.json:", len(stations), "entries,",
      sum(1 for s in stations if s["lat"]), "with coords,",
      sum(1 for s in stations if s.get("coord_precision") == "exact"), "exact,",
      sum(1 for s in stations if s.get("coord_precision") == "approximate"), "approximate,",
      sum(1 for s in stations if s.get("coord_precision") == "town"), "town,",
      sum(1 for s in stations if s["acc"]), "accredited,",
      sum(1 for s in stations if s.get("category")), "with category,",
      sum(1 for s in stations if s.get("hours")), "with hours,",
      sum(1 for s in stations if s.get("services")), "with services,",
      sum(1 for s in stations if s.get("price") is not None), "with price")
# Name-cleaning audit log (Phase 1): every display-only change, printed.
print("name cleaning: %d names, %d addresses, %d operators normalised"
      % (len(CLEAN_LOG["names"]), len(CLEAN_LOG["addresses"]),
         len(CLEAN_LOG["operators"])))
for kind, singular in (("names", "name"), ("addresses", "address"),
                         ("operators", "operator")):
    for eid, before, after in CLEAN_LOG[kind]:
        print(f"  {singular} {eid}: {before!r} -> {after!r}")

# --- Honest statistics (computed, never hardcoded) -------------------------
states_present = sorted({s["state"] for s in stations if s.get("state")})
no_data_states = [s for s in ALL_STATES if s not in states_present]
operators = Counter(s["operator"] for s in stations if s.get("operator"))
per_state = Counter(s["state"] for s in stations if s.get("state"))
categories = Counter(s["category"] for s in stations if s.get("category"))
# Per-state detail for the CNG Intelligence dashboard (Phase 3, §11):
# listed / refuelling / conversion / accredited / with-coordinates per
# state, computed from the same entries — the dashboard never estimates.
per_state_detail = []
for st in states_present:
    rows = [s for s in stations if s.get("state") == st]
    n = len(rows)
    coords = sum(1 for s in rows if s.get("lat"))
    per_state_detail.append({
        "state": st,
        "total": n,
        "refuelling": sum(1 for s in rows if s["type"] in ("refuelling", "both")),
        "conversion": sum(1 for s in rows if s["type"] in ("conversion", "both")),
        "accredited": sum(1 for s in rows if s.get("acc")),
        "with_coords": coords,
        # Coverage completeness = share of the state's entries that have
        # coordinates (and so appear on the map). A directory measure,
        # NOT a measure of the state's real CNG infrastructure.
        "pct_mapped": round(100 * coords / n) if n else 0,
    })
stats = {
    "generated": TODAY,
    "total_records": len(stations),
    "total_records_label": "Directory records — every station and centre entry in the dataset.",
    "refuelling_locations": sum(1 for s in stations if s["type"] in ("refuelling", "both")),
    "refuelling_label": "Unique refuelling locations (refuelling-only + both).",
    "conversion_centres": sum(1 for s in stations if s["type"] in ("conversion", "both")),
    "conversion_label": "Unique conversion centres (conversion-only + both).",
    "picng_register_matched": sum(1 for s in stations if s["acc"]),
    "picng_register_label": "Conversion centres matched on the Pi-CNG accredited centres register (checked 18 Nov 2026).",
    "picng_refuel_register_matched": sum(1 for s in stations if s["refReg"]),
    "picng_refuel_register_label": "Refuelling locations matched on the Pi-CNG refuelling stations register (updated 15 Oct 2026).",
    "needs_reverification": sum(1 for s in stations if s["confidence"] == "stale-2024-list"),
    "needs_reverification_label": "Entries from 2024 lists that need re-checking before they can be trusted.",
    "single_source": sum(1 for s in stations if s["confidence"] == "single-source"),
    "single_source_label": "Entries from one source only — need a second check.",
    "states_with_data": len(states_present),
    "states_with_data_label": "States + FCT with at least one entry (of 37).",
    "no_data_states": no_data_states,
    "with_coordinates": sum(1 for s in stations if s["lat"]),
    "with_coordinates_label": "Entries with recorded coordinates — only these appear on the map.",
    "coord_precision": {p: sum(1 for s in stations if s.get("coord_precision") == p)
                        for p in ("exact", "approximate", "town")},
    "coord_precision_label": "Coordinate precision: exact = confirmed place match; approximate = street-level geocode; town = locality centroid only.",
    "with_phone": sum(1 for s in stations if s.get("phone")),
    "with_postcode": sum(1 for s in stations if s.get("postcode")),
    "with_postcode_label": "Entries carrying a postcode in the dataset (6-digit area codes from the registers).",
    "operators": [{"name": n, "count": c} for n, c in operators.most_common(12)],
    "categories": [{"name": n, "count": c} for n, c in sorted(categories.items())],
    "per_state": [{"state": s, "count": per_state[s]} for s in states_present],
    "per_state_detail": per_state_detail,
}
(OUT / "stats.json").write_text(
    json.dumps(stats, ensure_ascii=False, indent=1))
print("stats.json:", stats["total_records"], "records,",
      stats["refuelling_locations"], "refuelling,",
      stats["conversion_centres"], "conversion,",
      stats["picng_register_matched"], "register-matched,",
      stats["needs_reverification"], "need re-verification,",
      stats["states_with_data"], "states,",
      len(no_data_states), "no-data states")

# --- Growth history (Phase 3, §11E) ---------------------------------------
# One snapshot per day, appended by the daily rebuild (which runs this
# script as its last step). The dashboard shows growth ONLY from these
# recorded snapshots — there is no backfilled history, so the first
# snapshot (19 Nov 2026) is honestly labelled as the baseline and the
# trend appears as days accumulate. Never fabricate a trend.
HISTORY_PATH = OUT / "history.json"
history = []
if HISTORY_PATH.exists():
    try:
        history = json.loads(HISTORY_PATH.read_text())
        assert isinstance(history, list)
    except Exception:
        history = []
snapshot = {
    "date": TODAY,
    "total_records": stats["total_records"],
    "refuelling_locations": stats["refuelling_locations"],
    "conversion_centres": stats["conversion_centres"],
    "picng_register_matched": stats["picng_register_matched"],
    "states_with_data": stats["states_with_data"],
    "with_coordinates": stats["with_coordinates"],
}
if not any(h.get("date") == TODAY for h in history):
    history.append(snapshot)
    history.sort(key=lambda h: h.get("date", ""))
HISTORY_PATH.write_text(json.dumps(history, ensure_ascii=False, indent=1))
print("history.json:", len(history), "snapshot(s), latest", history[-1]["date"]
      if history else "history.json: empty")

# --- Postcode table -------------------------------------------------------
benin = {"lat": BENIN[0], "lng": BENIN[1], "place": "Benin City centre",
         "approx": True, "note": "District centre — from mapped Benin City stations"}
postcodes = {
    "exact": {
        "300001": {**benin, "place": "Benin City GPO"},
        "300102": benin,
        "300103": benin,
        "300104": {"lat": 6.33029, "lng": 5.63807, "place": "Ugbowo / UNIBEN area",
                   "approx": True, "note": "From a station carrying this postcode"},
        "300105": benin,
        "300251": {**benin, "place": "GRA, Benin City"},
        "300271": benin,
        "302116": benin, "302117": benin, "302118": benin,
        "302119": benin, "302120": benin, "302121": benin,
        "310101": {"lat": 6.74, "lng": 6.14, "place": "Ekpoma",
                   "approx": True, "note": "Town centre, approximate"},
        "100001": {"lat": 6.6018, "lng": 3.3515, "place": "Ikeja, Lagos",
                   "approx": True, "note": "Town centre, approximate"},
        "330101": {"lat": 5.522, "lng": 5.76689, "place": "Warri",
                   "approx": True, "note": "From a station carrying this postcode"},
        "110115": {"lat": 7.31431, "lng": 3.86836, "place": "Ibadan (Tollgate)",
                   "approx": True, "note": "From a station carrying this postcode"},
    },
    "prefix3": {
        "100": {"lat": 6.6018, "lng": 3.3515, "place": "Ikeja, Lagos",
                "approx": True, "note": "Dispatch district centre, approximate"},
        "110": {"lat": 7.31431, "lng": 3.86836, "place": "Ibadan",
                "approx": True, "note": "Dispatch district centre, approximate"},
        "300": {**benin, "place": "Benin City"},
        "330": {"lat": 5.522, "lng": 5.76689, "place": "Warri",
                "approx": True, "note": "Dispatch district centre, approximate"},
        "900": {"lat": 9.0765, "lng": 7.3986, "place": "Abuja (FCT)",
                "approx": True, "note": "City centre, approximate"},
    },
}
(OUT / "postcodes.json").write_text(
    json.dumps(postcodes, ensure_ascii=False, indent=1))
print("postcodes.json:", len(postcodes["exact"]), "exact codes,",
      len(postcodes["prefix3"]), "prefix fallbacks")

# --- Sitemap ---------------------------------------------------------------
# The app is a single page; station detail and state pages are real URLs
# (?station=CNG-XXX, ?state=Lagos) handled by js/app.js on load.
import urllib.parse

BASE = "https://findcng.vercel.app"
urls = [("", "1.0", "daily")]
for view in ["stations", "centres", "safety", "calculator",
             "news", "outages", "help", "about", "privacy",
             "intelligence", "postcode", "chat"]:
    urls.append((f"?view={view}", "0.8", "weekly"))
for s in states_present:
    urls.append((f"?state={urllib.parse.quote(s)}", "0.7", "weekly"))
for s in stations:
    urls.append((f"?station={s['id']}", "0.6", "weekly"))
lines = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for path, prio, freq in urls:
    lines.append("  <url>")
    lines.append(f"    <loc>{BASE}/{path}</loc>")
    lines.append(f"    <lastmod>{TODAY}</lastmod>")
    lines.append(f"    <changefreq>{freq}</changefreq>")
    lines.append(f"    <priority>{prio}</priority>")
    lines.append("  </url>")
lines.append("</urlset>")
(ROOT / "sitemap.xml").write_text("\n".join(lines) + "\n")
print("sitemap.xml:", len(urls), "URLs")
