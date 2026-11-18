# FindCNG Nigeria

**Find gas near you — live availability, verified centres, nationwide.**

A live, mobile-first web app for finding CNG refuelling stations and verified
conversion centres across Nigeria. Built by ED/26B/2316, a serving NYSC corps
member in the NADDC–NYSC CNG Retrofitting Training Programme (Edo State, 1 of
300), as his Community Development Service (CDS) project.

- **Map + list** of stations & centres nationwide (counts computed from the dataset at build time — see `data/stats.json`; never hardcoded)
- **Live availability reporting** — one tap, no account; reports expire after 2 hours; one-tap confirm (yes / not sure / no) and “Back to normal”
- **Route planner** — OSRM driving routes with refuelling stops spaced by your tank range, alternative routes, legs with time/distance, straight-line fallback when the routing service is unreachable
- **Outages view** — stations drivers report as finished, right now
- **Station detail pages** — shareable URLs (`?station=CNG-XXX`), full details in reference order, favourites, listing reports, reliability from report history
- **NIPOST postcode location** — 6-digit and new 11-character codes, GPS, map tap
- **Verified-centre directory** — “check your installer” against the Pi-CNG accredited list; four distinct badges (Officially accredited, Independently verified, Pending verification, Needs re-verification)
- **Safety hub** — certified-vs-fake, sourced incident table, myth-vs-fact, in English + Pidgin
- **Savings calculator** — CNG vs petrol at current reported prices, conversion-cost input, payback period, annual savings; vehicle profile remembered on the device
- **News page** — dated programme updates, each with its original source
- **Ask about CNG** — AI chat (Gemini free tier) answering safety, price, savings and availability questions, grounded in the verified knowledge base (`data/chat-knowledge.json`), live news, fresh availability reports and web search; every answer shows its sources; no chat logs stored
- **Privacy page** — retention periods, removal requests (contact TBD)
- **Centre self-registration** — submissions wait in a moderation queue; nothing auto-publishes

Stack: plain HTML/CSS/JS (no framework), Leaflet + OpenStreetMap (Leaflet 1.9.4
vendored in `js/`/`css/` — no CDN dependency, so the map works offline once
cached; CARTO dark tiles as an option), Vercel serverless functions, Supabase (free tier) for reports +
submissions + confirmations + listing reports + certificate storage. Running cost ~₦0/month on free tiers.

## 2.1 redesign (Nov 2026)

Visual redesign, same features: gradient hero with live headline stats (from
`data/stats.json`, never hardcoded), layered search card, status-railed
station cards, stat-tile coverage grid, SVG bottom-nav icons, and a rebuilt
station detail page. New data contracts supported defensively (the fields do
not exist in the dataset yet — the UI degrades cleanly without them):

- `entry.photo = { url, attribution }` — a real photo of the place shows as a
  photo hero on the detail page with an attribution chip; when absent there is
  no placeholder image at all, just the clean typographic band.
- `entry.coord_precision = "exact" | "approximate" | "town"` — town-level pins
  are locality centroids, not exact spots: dashed-circle map pins, an
  “Area pin” badge, and a plain-language note on the detail page. Approximate
  pins get a dashed halo + note; exact pins get a confirmation chip. Entries
  without the field fall back to inferring from `coord_note` (and say nothing
  when nothing is known).

## Deploy

```bash
npx vercel --prod --yes
```

The project deploys as a static site plus the `api/` serverless functions. No
build step. First deploy creates the project; later deploys update it.

## Environment variables (Vercel → Settings → Environment Variables)

| Variable | Required? | What it is |
|---|---|---|
| `SUPABASE_URL` | For live reports/submissions | Supabase project URL, e.g. `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | For live reports/submissions | **Server-side only.** Found in Supabase Dashboard → Settings → API → `service_role` key. Never put it in client code. |
| `SUPABASE_ANON_KEY` | Not used by the app yet | Kept for future direct Supabase use. The browser never talks to Supabase today — only the `/api` routes do. |
| `NIPOST_API_KEY` | For official postcode lookup | NIPOST developer key (`nipost_test_…` for the sandbox, `nipost_live_…` for live). Without it, postcode lookup falls back to the built-in 6-digit table + GPS + map tap. |
| `NIPOST_API_BASE` | Optional | Override for testing — e.g. `https://ng-postcode.oliha.dev` (unofficial mock with the same paths). Default: `https://api.postcode.gov.ng`. |
| `GEMINI_API_KEY` | For AI chat answers | Free Google AI Studio key (aistudio.google.com — no card, free tier only). Without it, `/api/chat` answers `{ configured: false }` and the app shows “AI answers are being set up”. The key is server-side only, used only for the `gemini-2.5-flash` model, and no chat logs are stored. |
| `ADMIN_PASSCODE` | Set in Vercel (Production, secret) + `.env.local` | Moderator passcode for `/admin.html`. A strong passcode was generated at deploy time (18 Nov 2026) and stored in Vercel + `.env.local` — never commit it. To change it, update the Vercel env var and `.env.local`, then redeploy. |

**Without Supabase configured**, the app shows an honest error for reports and
submissions (“couldn't reach the server — try again”) and saves nothing
locally. There is no demo mode: a report the user thinks is shared must
actually be shared. The station list, directory, safety hub and calculator
never need the database.

## Supabase setup (one-time, ~15 minutes)

1. Create a free project at [supabase.com](https://supabase.com) (name it `findcng`).
2. Dashboard → SQL Editor → New query → paste `supabase/schema.sql` → Run.
   This creates `availability_reports`, `centre_submissions` (both RLS-enabled,
   no public policies — the anon key can do nothing) and the private
   `certificates` storage bucket.
3. Dashboard → SQL Editor → New query → paste
   `sql/001_listing_reports_and_confirmations.sql` → Run. This creates the
   `listing_reports` and `report_confirmations` tables the 2.0 reporting
   features need. Until it is run, `/api/listing-reports` and
   `/api/confirmations` answer `{ ok: false, error: "not_open" }` and the app
   shows “not open yet” — nothing crashes and nothing is silently lost.
4. Dashboard → Settings → API → copy the **Project URL** and the
   **`service_role` secret key** into the Vercel env vars above. (The `anon`
   key is also listed there; copy it too for completeness.)
5. Redeploy (`npx vercel --prod --yes`). Reports and submissions go live.

## NIPOST API key (one-time)

1. Create a developer account at the NIPOST developer dashboard (linked from
   [docs.postcode.gov.ng](https://docs.postcode.gov.ng)).
2. Create a **test key** (`nipost_test_…`) — free, unmetered, sandbox data.
   It is enough for the showcase demo.
3. Add it as `NIPOST_API_KEY` in Vercel and redeploy.
4. The app only uses the **free tier**: autocomplete, nearby search, and L1
   lookup (validity). It never requests L2+ (paid credits) or L5 coordinates
   (restricted) — coordinates always come from GPS or a map tap.

## How to add a station

Station data lives in the master dataset, not in this repo:

1. Edit `~/workspace/cng-project/data/stations.json` (or re-run the merge
   pipeline there — see `rebuild-all.py`).
2. Regenerate the app data: `python3 build-data.py` (in this repo root).
3. Commit + redeploy.

**Never invent coordinates.** An entry without coordinates appears in the list
with its address only — that is by design. Record real GPS coordinates on site
(from a phone) before adding `latitude`/`longitude` to the master dataset.

## How to update prices

Edit `js/data.js` — `FINDCNG.PRICES` (CNG ₦/SCM, petrol ₦/litre) and
`priceDate`. The calculator reads from there. Prices as reported Sep–Nov 2026;
re-check before any demo. Then redeploy.

## How to moderate (ED/26B/2316)

1. Open `<site>/admin.html`, enter the moderator passcode. (There is no link
   to the moderator page anywhere in the app — it is reachable only by direct
   URL.)
2. Pending submissions show first. Open one, **view the certificate**, then:
   - **Verify:** cross-check the name on
     [pci.gov.ng/conversion-centers.html](https://www.pci.gov.ng/conversion-centers.html),
     inspect the certificate (name matches, NADDC/Pi-CNG, dates valid), and
     call the centre on the submitted number.
   - **Approve** → the centre is listed with an “Independently verified” badge and
     today's date. **Reject** → give a reason so the centre can fix it and re-apply.
3. Approved centres appear in the public directory automatically (via `/api/centres`).
4. The **Listing reports** tab shows user flags (incorrect / closed / moved).
   Resolving one only closes the report — fix the listing itself in the master
   dataset, re-run `build-data.py`, and redeploy.

## How it works

```
Browser (index.html + js/app.js)
  ├─ data/stations.json        entries, lazy-loaded, cached offline (sw.js)
  ├─ data/stats.json           honest categories, computed by build-data.py
  ├─ data/postcodes.json       6-digit lookup table + prefix fallbacks
  ├─ /api/reports              GET recent / POST new (Supabase availability_reports)
  │                            GET ?station=CNG-XXX — 30-day history (reliability)
  ├─ /api/confirmations        one-tap confirm on a report (report_confirmations)
  ├─ /api/listing-reports      flag a listing (listing_reports)
  ├─ /api/postcode             proxy to api.postcode.gov.ng (free tier only)
  ├─ /api/chat                 "Ask about CNG" — Gemini answers grounded in data/chat-knowledge.json + live news + fresh availability reports + DuckDuckGo search; no logs stored
  ├─ /api/submissions          centre registration -> storage + centre_submissions
  ├─ /api/centres              approved submissions + live verified/pending counts
  └─ /api/admin                passcode-gated moderation (submissions + listing reports)
```

- **Reports expire after 2 hours** (`REPORT_TTL_MS` in `js/data.js`), then the
  station shows “Unconfirmed”. Reports are anonymous — only an anonymous daily
  hash is stored, to stop spam. “Back to normal” is a report with status
  `available` — no schema change.
- **Statistics are computed, never hardcoded.** `build-data.py` emits
  `data/stats.json` (total records, refuelling locations, conversion centres,
  Pi-CNG-register-matched, needs re-verification, states with data, no-data
  states, operators, categories). “Independently verified” and “pending
  verification” counts come from `/api/centres` at runtime — they live in
  Supabase, not in the dataset.
- **Verification badges (four, distinct):** Officially accredited (Pi-CNG
  register match, register date shown) · Independently verified (admin-approved
  submissions, verification date shown) · Pending verification (submitted,
  awaiting review — not listed publicly) · Needs re-verification (stale
  2024-list entries).
- **Route planner:** OSRM public API (free, no key) for driving routes;
  Nominatim for place names. If OSRM is unreachable, a straight-line corridor
  estimate is shown and labelled as such. Stops are mapped refuelling stations
  within 5 km of the route, spaced by the user's tank range.
- **Postcode fallback chain:** exact 6-digit → first-3-digits (dispatch
  district) → GPS / map tap. The app never hard-fails on location. NDAPS
  11-character codes are validated on structure locally; NIPOST does not hand
  out building coordinates via the API, so an NDAPS code alone never produces
  a map point.
- **LGA is not used anywhere** — ~20% of Pi-CNG LGA values are wrong
  (see the coverage report). State + address are the trusted fields.
- **Privacy (NDPA):** no accounts; no names/phones from reporters; location
  used only to find nearby stations, never stored with identity; submitter
  contacts and certificate photos are moderator-only, never published. See
  the Privacy page in the app (`?view=privacy`).

## Data sources (listed in the app's About page)

- Pi-CNG refuelling stations register (pci.gov.ng, updated 15 Oct 2026)
- Pi-CNG accredited conversion centres register (pci.gov.ng, extracted 18 Nov 2026 — 928 rows → 546 distinct centres)
- FG free conversion centres list (Jul 2024) · BOVAS operator locator (May 2026)
- News reporting (Punch, Nairametrics, BusinessDay, The Sun, Independent, Oct–Nov 2026)

Safety content traces to NADDC / SON / Pi-CNG findings; prices to reporting
Sep–Nov 2026. See `~/workspace/cng-project/CNG-PUBLIC-SENTIMENT.md` (evidence
base) and `NIPOST-POSTCODE-RESEARCH.md` (postcode system).

## Files

| File | What it is |
|---|---|
| `index.html` | The app (Map, Stations, Centres, Route, Safety, Calculator, News, Outages, Help, Privacy, Register, About, More, station detail) |
| `admin.html` | Moderator queue (passcode-gated): centre submissions + listing reports |
| `css/style.css` | All styles, mobile-first |
| `js/app.js` | Map + clustering, lists, reports, confirmations, route planner, calculator, registration |
| `js/postcode.js` | Postcode parsing, fallback chain, NIPOST client |
| `js/data.js` | Prices, vehicle presets, statuses, Pidgin safety text — edit prices here |
| `data/stations.json` | Compact station data (generated by `build-data.py`) |
| `data/stats.json` | Honest categories, computed (generated by `build-data.py`) |
| `data/postcodes.json` | 6-digit lookup table (generated by `build-data.py`) |
| `sitemap.xml` | Station + state + view URLs (generated by `build-data.py`) |
| `robots.txt` | Allows crawling except /admin.html and /api/ |
| `api/*.js` | Vercel serverless functions (see “How it works”) |
| `supabase/schema.sql` | Database schema (run once in Supabase) |
| `sql/001_listing_reports_and_confirmations.sql` | 2.0 tables — run in Supabase to open confirmations + listing reports |
| `sw.js` / `manifest.json` | Offline cache + installable PWA |
| `build-data.py` | Regenerates `data/` + `sitemap.xml` from the master dataset |
| `verify-live.py` | End-to-end live checks (zero lasting pollution) |

## Showcase

“Built on Nigeria's Postcode”, Session 3 (Public services, safety and
utilities) — Saturday 21 Nov 2026. Apply at pitch.postcode.gov.ng with the
deployed link + a short demo video.
