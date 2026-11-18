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
  data/stats.json (build time) or /api/centres counts (runtime).
- LGA is NOT carried into the app data: ~20% of Pi-CNG LGA values are wrong
  (COVERAGE-REPORT.md §0). The app never filters or displays LGA.
- Postcode coordinates are APPROXIMATE district/town centres, clearly flagged.
  Benin City values are derived from the mean of the mapped Edo stations;
  300104/330101/110115 come from stations carrying those postcodes.
  Ikeja/Abuja/Ekpoma are well-known town centres, flagged approximate.
  They are used ONLY to centre the map for a postcode search — never
  attached to a station.
"""
import json
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


stations = []
for e in master:
    sources = e.get("sources") or []
    joined = " | ".join(sources)
    on_centres_register = "conversion-centers.html" in joined
    on_refuel_register = "refuelling-stations.html" in joined
    entry = {
        "id": e["id"],
        "name": e["name"],
        "type": e["type"],                    # refuelling | conversion | both
        "operator": e.get("operator"),
        "address": e.get("address"),
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
    if e.get("hours"):
        entry["hours"] = e["hours"]          # string or {day: "06:00–22:00"}
    if e.get("services"):
        entry["services"] = e["services"]    # string or [..]
    if e.get("price") is not None:
        entry["price"] = e["price"]          # ₦/SCM as sourced, with price_date
    if e.get("price_date"):
        entry["price_date"] = e["price_date"]
    stations.append(entry)

(OUT / "stations.json").write_text(
    json.dumps(stations, ensure_ascii=False, separators=(",", ":")))
print("stations.json:", len(stations), "entries,",
      sum(1 for s in stations if s["lat"]), "with coords,",
      sum(1 for s in stations if s["acc"]), "accredited,",
      sum(1 for s in stations if s.get("category")), "with category,",
      sum(1 for s in stations if s.get("hours")), "with hours,",
      sum(1 for s in stations if s.get("services")), "with services,",
      sum(1 for s in stations if s.get("price") is not None), "with price")

# --- Honest statistics (computed, never hardcoded) -------------------------
states_present = sorted({s["state"] for s in stations if s.get("state")})
no_data_states = [s for s in ALL_STATES if s not in states_present]
operators = Counter(s["operator"] for s in stations if s.get("operator"))
per_state = Counter(s["state"] for s in stations if s.get("state"))
categories = Counter(s["category"] for s in stations if s.get("category"))
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
    "with_phone": sum(1 for s in stations if s.get("phone")),
    "operators": [{"name": n, "count": c} for n, c in operators.most_common(12)],
    "categories": [{"name": n, "count": c} for n, c in sorted(categories.items())],
    "per_state": [{"state": s, "count": per_state[s]} for s in states_present],
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
for view in ["stations", "centres", "route", "safety", "calculator",
             "news", "outages", "help", "about", "privacy", "register"]:
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
