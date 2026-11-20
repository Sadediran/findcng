# FindCNG Nigeria

**Find gas near you — live availability, verified centres, nationwide.**

**Live:** https://findcng.vercel.app

A live, mobile-first web app for finding CNG refuelling stations and verified
conversion centres across Nigeria. Built by ED/26B/2316, a serving NYSC corps
member in the NADDC–NYSC CNG Retrofitting Training Programme (Edo State, 1 of
300), as his Community Development Service (CDS) project.

- **Map + list** of stations & centres nationwide (counts computed from the dataset at build time — see `data/stats.json`; never hardcoded)
- **Live availability reporting** — one tap, no account; reports expire after 2 hours; one-tap confirm (yes / not sure / no) and “Back to normal”; every fresh report carries a confidence indicator (High / Medium / Low / Disputed) computed from freshness + independent confirmations + source, with the honest “why” shown
- **CNG Intelligence** — national overview (listed vs verified vs live-right-now), state comparison with sorting, infrastructure gaps (labelled as directory gaps, never as proven infrastructure gaps), postcode areas, growth from daily snapshots, data freshness
- **Outages view** — stations drivers report as finished, right now
- **Station detail pages** — shareable URLs (`?station=CNG-XXX`), full details in reference order, favourites, listing reports, reliability from report history
- **NIPOST postcode location** — 6-digit and new 11-character codes, GPS, map tap; Postcode Explorer parses segments, names state/LGA from NIPOST reference data, checks validity against the NIPOST sandbox, and shows nearby stations with distances
- **Verified-centre directory** — “check your installer” against the Pi-CNG accredited list; two distinct data-driven badges (Officially accredited, Needs re-verification)
- **Safety hub** — certified-vs-fake, sourced incident table, myth-vs-fact, in English + Pidgin + Hausa + Yoruba + Igbo (the three new translations are marked as awaiting native-speaker review)
- **Savings calculator** — CNG vs petrol at current reported prices, conversion-cost input, payback period, daily/monthly/annual savings; editable CNG-use estimate (km per SCM); copy or download the summary as a .txt file; vehicle profile remembered on the device
- **News page** — dated programme updates, each with its original source
- **Ask about CNG** — AI chat (Gemini free tier, OpenRouter free backup — verified working 19 Nov 2026) answering safety, price, savings and availability questions, grounded in the verified knowledge base (`data/chat-knowledge.json`), live news, fresh availability reports, web search, and read-only lookups of named stations in the directory (missing fields answered “Information unavailable”, never invented); no sources shown; no chat logs stored
- **Operator portal** — centre registration, station ownership claims, update requests, availability updates and responses to user reports — every submission lands in the admin moderation queue; nothing publishes or is marked “Operator confirmed” until an admin approves that exact submission (claims require a business documentation reference + phone confirmation; verification is a manual admin checklist — there is no automatic verification). Backed by `sql/003_operator_portal.sql`, run live 19 Nov 2026 — the portal is open and submissions flow through the moderation queue.
- **Admin dashboard** (`/admin.html`) — role-based (Super admin / Data admin / Verifier passcodes): overview with live counts, listing reports, availability moderation, operator verification queue, audit log, data quality (incl. duplicate detection and accreditation review) and postcode monitoring. Nothing auto-publishes as verified without admin approval.
- **Offline directory** — cached station + centre info and offline search; when the browser reports offline, live availability is withdrawn everywhere at once (never presented as current) and syncs again on reconnect
- **Privacy page** — retention periods, removal requests (contact TBD)
- **Official-source directory** — listings come from government and agency sources (the Pi-CNG registers and other public lists); centres do not register themselves

Stack: plain HTML/CSS/JS (no framework), Leaflet + OpenStreetMap (Leaflet 1.9.4
vendored in `js/`/`css/` — no CDN dependency, so the map works offline once
cached; two switchable base layers — Esri satellite imagery (the default) and
OpenStreetMap street — with automatic fallback to street if the satellite
tiles fail; the CARTO dark layer was removed in 2.4 because CARTO's keyless
dark endpoint died), Vercel serverless functions, Supabase (free tier) for reports +
confirmations + listing reports. Running cost ~₦0/month on free tiers.

## 3.3 (19 Nov 2026) — Phase 4 of the master transformation (§22: Ecosystem expansion)

- **Operator portal (§15):** new `api/operator.js` + an Operator view in
  the app (More menu, and “Claim this station” / “Request an update”
  buttons on station detail pages). Five submission types — register,
  claim, update, availability, response — all validated server-side
  (unknown station → 400, claim without a ≥10-char business
  documentation reference → 400, claim/update/availability/response
  without a phone or email → 400, bad state/status/details → 400),
  rate-limited (10 POSTs/min/IP, best-effort through proxies) and
  deduped (10-min window per type+station). Nothing publishes on
  submission: register/claim/update sit in the moderation queue;
  availability publishes a live report only when an admin approves it
  (that report carries `source: "operator"` and shows “Operator
  confirmed”); responses are moderator-facing only. Submitters get a
  reference and can check status from the portal (`GET
  /api/operator?id=` returns public fields only — never phone/email).
  Approved claims publish `claimed: true` + business name
  (`GET /api/operator?station=CNG-XXX`), which the directory shows as
  an “Operator-verified listing” badge. Needs
  `sql/003_operator_portal.sql` (see Supabase setup below); until it is
  run, submissions answer an honest 503 `not_open` and the portal says
  so — as of this release sql/003 had NOT been run (no DDL route
  exists from this VM), so the end-to-end flow could not be verified
  live at that point; `verify-live.py` detects the state and tests the
  matching behaviour. **Update 19 Nov 2026 ~20:32 WAT: sql/003 was run
  live and the operator portal is open.**
- **Admin dashboard (§16):** `admin.html` rebuilt as a tabbed
  dashboard (Overview, Listing reports, Availability, Operator queue,
  Audit log, Data quality, Postcode) with its logic in `js/admin.js`
  (no inline script — CSP). Overview tiles are live counts from the
  database/directory, labelled as such. Data quality shows real counts
  (721 / 510 / 95+ exact / 18 phones), the duplicate-detection view
  (48 groups, 2 exact-pin pairs — CNG-282/430 Lugbe and CNG-387/428
  Jahi — surfaced, never merged), and accreditation review (36 stale
  2024, 9 single-source). Postcode monitoring shows mode + key status
  without ever returning the key. **Role-based access via role-scoped
  passcodes** (`ADMIN_PASSCODE` = Super admin, `DATA_ADMIN_PASSCODE` =
  Data admin, `VERIFIER_PASSCODE` = Verifier — all fail closed when
  unset; Supabase Auth was out of reach in this run, so it was not
  attempted): the permission matrix is enforced server-side in
  `api/admin.js` (Super: everything; Data admin: listing reports +
  availability moderation + data quality/duplicates, read-only operator
  queue + audit; Verifier: operator review + accreditation review +
  availability moderation, read-only listing reports) and mirrored in
  the UI (buttons hidden per role; a verifier opening a listing report
  sees a read-only note). Operator approval has a manual verification
  checklist (documentation reference checked + confirmed by phone) for
  claims. Every admin action is written to `audit_log` (via sql/003,
  run live 19 Nov 2026). The Phase 3 cosmetic
  issue was investigated and closed: the admin availability list never
  had a `created_at` field — `reported_at` is the timestamp and is
  always populated. Content editor and support administrator roles are
  documented as pending (no content-editing or support-ticket surface
  exists in this stack).
- **Multilingual safety hub (§17):** Hausa, Yoruba and Igbo added for
  the safety hub's core content (`js/safety-i18n.js` — 5 keys per
  language, 4 causes, 4 myth cards, 6 checklist items), with a visible
  banner on every translated view: “This translation was produced
  in-session and is awaiting review by a native speaker before it is
  presented as final.” English + Pidgin unchanged; the incidents table
  stays English. The translations are never presented as professionally
  verified.
- **News (§18):** verified against the brief (Nigerian CNG policy, new
  stations, infrastructure, accreditation, industry, safety; dates +
  original sources shown; nothing auto-generated presented as verified
  fact) and the seed deduped — `data/news-seed.json` is now the single
  source of truth (9 items); `js/news.js` no longer inlines a copy.
- **Performance, security, reliability (§19):** the deferred CSP is
  live for real — all 38 inline `onclick` handlers + 1 `onerror`
  converted to data attributes + one document-level delegated listener;
  `script-src 'self'` with NO `'unsafe-inline'` (`style-src` keeps
  `'unsafe-inline'` because Leaflet sets inline styles). Same-origin
  checks on all public POST routes (foreign Origin → 403); rate
  limiting on all write APIs; audit logging (see §16); Supabase RLS
  reviewed (no public policies — the anon key can do nothing). Privacy
  page now discloses operator-portal contact collection + retention for
  operator submissions and the audit log; the support contact is still
  TBD and nothing was invented. Accessibility: skip-to-content link
  added. Admin page gained the data-URI favicon (it was 404ing) and a
  “Loading live counts…” placeholder while analytics loads.
- **Offline (§20):** when the browser reports offline, live
  availability is withdrawn everywhere at once — the home feed, station
  detail pages and the outages view all show “You are offline — live
  reports need a connection” instead of any cached report; an offline
  banner appears and the app auto-syncs on reconnect. The saved station
  directory and safety hub keep working offline. Cached availability is
  never presented as current.
- **Bugs found by live testing and fixed in this release:** (1) the
  PostgREST missing-column error is code **42703**, not PGRST204 — the
  `source` fallback in `api/reports.js`/`api/admin.js` had 500'd the
  reports feed until sql/003 is run; (2) the operator station search
  only matched single words (“NIPCO Benin” found nothing) — it now
  matches multi-word queries across name/city/state/address; (3) the
  outages view listed the last known state when reports were
  unreachable — it now shows nothing stale; (4) the admin overview
  rendered an empty panel while analytics loaded (now a loading
  placeholder) and the admin page 404'd on `/favicon.ico`.
- **Tests:** `verify-live.py` extended with 38 Phase 4 checks (98/98
  pass, incl. RBAC whoami ×3 roles + 401s, permission-matrix 403s,
  operator validation 400s, same-origin 403s, `not_open` behaviour,
  CSP header presence, no inline handlers in the served HTML);
  `scripts/verify-phase4-ui.py` drives the live site in headless
  Chromium, mobile 390 px + desktop 1280 px (47 checks, all pass, zero
  JS errors from app code, zero CSP violations) — operator portal,
  safety languages, role-gated admin dashboard (all three roles),
  offline behaviour, and the §23 regression subset (home, calculator
  ₦266,382/month, postcode sandbox sample, intelligence). Every test
  row created was deleted by id afterwards; Saheed's 3 real reports
  (CNG-018, CNG-021, CNG-009) and the older CNG-156 history row were
  re-verified intact after every test run.

## 3.2 (19 Nov 2026) — Phase 3 of the master transformation (§22: Intelligence and reliability)

- **Availability confidence (§8):** every fresh report now shows a
  confidence chip — High (≤30 min + ≥2 net confirmations), Medium
  (≤60 min + ≥1 net, or ≤15 min), Low (inside the 2 h window, otherwise),
  Disputed (more “no” than “yes” votes) — with the honest “why” (age +
  confirmations + “Community reported”) on the detail page and the home
  live feed, plus a “✓ Still right?” confirm button per feed item. The
  detail page re-checks confirmations on load; expired reports get no
  confidence at all. `api/confirmations.js` gained a batch GET
  (`?report_ids=a,b,c`, max 20). “Operator confirmed” stays reserved
  and unused until Phase 4. `api/reports.js` gained a burst guard (6+
  reports from one reporter hash in 10 min → 429, logged) — the hash is
  IP-based and unstable through proxies, so the guard is best-effort.
- **CNG Intelligence dashboard (§11):** the Phase 1 “Coverage & data”
  view is upgraded in place (old `?view=coverage` links alias to it).
  Modules: national overview (listed vs verified vs live-right-now, with
  an explicit note that FindCNG keeps no separate “operational”
  register); state comparison table (listed / refuelling / conversion /
  accredited / mapped, sortable); infrastructure gaps — no-data states,
  thinly listed states, no-refuelling states, unmapped states — with an
  explicit disclaimer that these are DIRECTORY gaps, not proven
  infrastructure gaps; postcode areas (17 known 6-digit codes with the
  count of mapped stations within 25 km and “See stations” buttons);
  growth from `data/history.json` daily snapshots only (baseline
  19 Nov 2026: 721 records — a single snapshot is shown honestly as a
  baseline, never as a trend); data freshness (dataset date, Pi-CNG
  register dates, live register state, fresh-report counts, newest news
  date). Every figure is computed from the dataset at build time
  (`build-data.py` now writes `per_state_detail` and `with_postcode`
  into `stats.json`); per-state sums reconcile with the totals.
- **Reporting + moderation (§14):** the listing-report sheet now offers
  wrong details, wrong coordinates, updated contact, closed, moved,
  safety concern, and “something else”; a missing-station suggestion
  flow (station_id `NEW`, details ≥10 chars) is reachable from Help and
  from the Stations view. Types map onto the four existing DB types with
  `[Wrong coordinates]` / `[Updated contact]` / `[Safety concern]` /
  `[Missing station]` tags in the details — no migration needed.
  Submitters get a reference (full UUID, also saved on the device) and
  can check its status from Help (“Check a report”, `GET
  /api/listing-reports?id=` returns public fields only, never the
  reporter hash). Reporter-agnostic 10-minute dedupe per station+type.
  Admin gains an availability-moderation panel (recent history, burst
  flags at 5+/hour, per-row delete) and listing-report delete for
  spam/test rows; listing detail parses the type tags back into labels.
- **Savings calculator v2 (§12):** editable “Estimated CNG use (km per
  SCM)” input (auto-filled kpl×1.1, user override wins until the vehicle
  or kpl changes), an explicit Monthly saving row, and a Download summary
  (.txt) button alongside Copy. Maths verified against two hand-computed
  worked examples (see `scripts/verify-phase3-ui.py`).
- **AI assistant (§13):** `api/chat.js` now grounds named-station
  questions in a read-only lookup of `data/stations.json` (gated on a
  directory-intent regex + ≥2 distinctive name words; missing fields
  answered “Information unavailable”). The stale “how FindCNG works” KB
  fact was corrected to the real counts (721 / 134 / 617 / 30 states /
  576) and now leads with the 721 total so the model quotes it. Tested
  live with 7 cases incl. refusal-to-invent (see below).
- **Cleanup:** the two pre-existing “TEST DELETE ME” CNG-001 listing
  reports were verified as test rows and deleted by id; the admin queue
  is clean. Saheed’s 3 real reports (CNG-018, CNG-021, CNG-009) were
  re-verified intact after every test run.
- **Bugs found by live testing and fixed in this release:** (1) a tap on
  Copy/Download right after editing a calculator field was swallowed —
  the blur-triggered re-render replaced the buttons under the tap — so
  the buttons are now static HTML reading a summary variable; (2) the
  Intelligence view’s “Live right now” line never updated once reports
  arrived (reports load after the directory and `refreshStatuses` did
  not re-render it) — fixed, and the UI check that had passed on the
  empty state’s wording was tightened to require the “1 station(s)”
  line.
- **Tests:** `verify-live.py` extended with 22 Phase 3 checks (60/60
  pass); `scripts/verify-phase3-ui.py` drives the live site in headless
  Chromium, mobile + desktop (46 checks, all pass, zero JS errors from
  app code); `scripts/verify-chat-phase3.py` runs the 7 chat cases
  (all pass, incl. refusal-to-invent and no-invented-phone). Every test
  row created was deleted by id afterwards.

## 3.1 (19 Nov 2026) — Phase 2 of the master transformation

- **NIPOST integration (§6):** `api/postcode.js` v2 — sandbox/live mode
  detection (a live key drops in via env var with zero code change),
  reference endpoints (`states`, `lgas`, `districts`, `areas`), structured
  error codes (timeout / invalid key / rate limited / not granted /
  NIPOST unavailable), per-IP rate limiting, input validation. Live keys
  are capped at L1; L2 (address autofill) is attempted only on sandbox
  keys and falls back to L1 on `not_granted` (the current test key is
  L1-only). L5 coordinates are never requested.
- **Postcode Explorer v2:** segment chips name the state (full 37-state
  table, ED = Edo confirmed from NIPOST's own reference list) and the LGA,
  and confirm district/area codes against the reference data; validity is
  checked against NIPOST with honest sandbox/live labelling; segment-aware
  autocomplete (sandbox only — it spends credits on a live key per the
  current docs); one-tap sandbox sample code; nearby-station discovery
  with distances from verified coordinates after a 6-digit resolve or
  GPS; reverse lookup shows the postcode at the user's spot when NIPOST
  has one. The `valid:false` mystery is solved: the docs' format example
  `FC 02 A09 DB 09` is not in the sandbox dataset — only NIPOST's
  published sandbox codes (e.g. `FC-01-A01-KP-27`) resolve there.
- **Verification (§§9–10):** every station/centre profile now has a
  Verification card — status, source, last verification date where known;
  unconfirmed accreditation is never shown as valid. The two suspected
  duplicate exact-pin pairs (Lugbe, Jahi) are surfaced in the admin view
  for Saheed's decision — not merged.
- **Refresh fix:** `rebuild-all.py` now runs `build-data.py` as its last
  step (step 12, with a CNG-704 cleaning canary), so the daily refresh
  can no longer overwrite the Phase 1 name cleaning. Verified by a full
  rebuild: byte-identical master + app data, all asserts passed.
- **Tests:** `verify-live.py` extended with 11 postcode checks (37/37
  pass); `scripts/verify-phase2-ui.py` drives the live explorer in
  headless Chromium (22/22 pass, zero console errors).
- **Live vs sandbox, honestly:** the deployed key is a test key, so real
  building codes show as "not found in the sandbox" by design; the UI
  says so everywhere. Live validation needs a live key (verified KYB +
  granted access — Saheed's decision, still open). Note the docs updated
  19 Nov 2026 state Lookup/Autocomplete consume credits with no free tier
  stated for live keys, and no longer document the L1–L5 levels — the
  level behaviour in this proxy is gateway-observed, and any live-key
  cost is unconfirmed (no credit pricing published).

## 3.0 (19 Nov 2026) — Phase 1 of the master transformation

- **Homepage restructured** (§5): hero "Find CNG. Find Confidence." with
  three wired primary actions; sections in order below the map — live
  availability feed (fresh reports only), conversion-centre preview,
  national statistics, postcode discovery intro, savings teaser (computed
  from real prices), safety, latest updates.
- **Navigation** (§4): bottom nav is now Home · Stations · Centres · Live ·
  More; the More menu is grouped (Discover / Learn & save / About &
  support). New views: **Postcode Explorer** (parse + explain 6-digit and
  11-character codes with the existing postcode module and an honest
  sandbox note — this is NOT the Phase 2 NIPOST integration) and
  **Coverage & data** (per-state table, no-data states, pin precision —
  all from `stats.json`).
- **API hardening:** POST reports/confirmations/listing-reports reject
  unknown station IDs; 2-minute same-station same-status dedupe (a
  changed status always files fresh); admin passcode fails closed when
  unset (no default); error messages no longer leak database internals;
  security headers in `vercel.json`.
- **Data cleaning:** `build-data.py` normalises operator casing (most
  readable variant), whitespace, trailing address punctuation and repeated
  operator prefixes in names (20 names, 67 addresses, 20 operators).
  Display-only — no entry deleted, merged or moved.
- **Fixes:** `?view=station` with no station open goes home; stats render
  survives missing keys; outages include closed stations; calculator gains
  a daily-saving row + copy-my-summary; Escape closes the sheets.

## 2.5 (18 Nov 2026) — centre self-registration removed

Saheed reversed his own 18 Nov 00:26 WAT design decision (centre
self-registration + human verification gate): centres no longer register
themselves and there is no verification queue. Data comes live from
government/agency sources instead (a separate pipeline workstream). Removed:
the registration form and every “Add your centre” entry point,
`api/submissions.js`, `api/centres.js`, the verification-queue stats tiles,
the submissions half of the admin page and `api/admin.js`, and the
submission-tied badges (“Independently verified”, “Pending verification”).
Kept: the data-driven badges (“Officially accredited”, “Needs
re-verification”) and the dormant `centre_submissions` table in Supabase
(nothing reads or writes it).

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
| `SUPABASE_URL` | For live reports | Supabase project URL, e.g. `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | For live reports | **Server-side only.** Found in Supabase Dashboard → Settings → API → `service_role` key. Never put it in client code. |
| `SUPABASE_ANON_KEY` | Not used by the app yet | Kept for future direct Supabase use. The browser never talks to Supabase today — only the `/api` routes do. |
| `NIPOST_API_KEY` | For official postcode lookup | NIPOST developer key (`nipost_test_…` for the sandbox, `nipost_live_…` for live). Without it, postcode lookup falls back to the built-in 6-digit table + GPS + map tap. |
| `NIPOST_API_BASE` | Optional | Override for testing — e.g. `https://ng-postcode.oliha.dev` (unofficial mock with the same paths). Default: `https://api.postcode.gov.ng`. |
| `GEMINI_API_KEY` | For AI chat answers | Free Google AI Studio key (aistudio.google.com — no card, free tier only). Without it, `/api/chat` answers `{ configured: false }` and the app shows “AI answers are being set up”. The key is server-side only, used only for the `gemini-2.5-flash` model, and no chat logs are stored. |
| `ADMIN_PASSCODE` | Set in Vercel (Production, secret) + `.env.local` | Super admin passcode for `/admin.html`. A strong passcode was generated at deploy time (18 Nov 2026) and stored in Vercel + `.env.local` — never commit it. To change it, update the Vercel env var and `.env.local`, then redeploy. |
| `DATA_ADMIN_PASSCODE` | Set in Vercel (Production, secret) + `.env.local` | Data admin passcode for `/admin.html` (Phase 4). Generated 19 Nov 2026, stored in Vercel + `.env.local` — never commit it. Without it, the data admin role cannot sign in (fail closed). |
| `VERIFIER_PASSCODE` | Set in Vercel (Production, secret) + `.env.local` | Verifier passcode for `/admin.html` (Phase 4). Generated 19 Nov 2026, stored in Vercel + `.env.local` — never commit it. Without it, the verifier role cannot sign in (fail closed). |

**Without Supabase configured**, the app shows an honest error for reports
(“couldn't reach the server — try again”) and saves nothing
locally. There is no demo mode: a report the user thinks is shared must
actually be shared. The station list, directory, safety hub and calculator
never need the database.

## Supabase setup (one-time, ~15 minutes)

1. Create a free project at [supabase.com](https://supabase.com) (name it `findcng`).
2. Dashboard → SQL Editor → New query → paste `supabase/schema.sql` → Run.
   This creates `availability_reports` (RLS-enabled, no public policies —
   the anon key can do nothing). The file also still defines the legacy
   `centre_submissions` table and the private `certificates` storage
   bucket — left dormant since centre self-registration was removed in
   2.5 (18 Nov 2026); nothing reads or writes them.
3. Dashboard → SQL Editor → New query → paste
   `sql/001_listing_reports_and_confirmations.sql` → Run. This creates the
   `listing_reports` and `report_confirmations` tables the 2.0 reporting
   features need. Until it is run, `/api/listing-reports` and
   `/api/confirmations` answer `{ ok: false, error: "not_open" }` and the app
   shows “not open yet” — nothing crashes and nothing is silently lost.
3b. Dashboard → SQL Editor → New query → paste
   `sql/003_operator_portal.sql` → Run. This creates the
   `operator_submissions` and `audit_log` tables and adds the `source`
   column to `availability_reports` — the Phase 4 operator portal and
   audit log need it. Until it is run, operator submissions answer an
   honest 503 `not_open`, the operator queue and audit log tabs say
   “not open yet”, and reports have no `source` field (the APIs degrade
   gracefully — nothing crashes). On the live deployment this step was
   run 19 Nov 2026 ~20:32 WAT; a fresh deploy still needs this
   2-minute step in the Supabase SQL editor, then re-run
   `python3 verify-live.py` to exercise the full operator end-to-end
   flow.
4. Dashboard → Settings → API → copy the **Project URL** and the
   **`service_role` secret key** into the Vercel env vars above. (The `anon`
   key is also listed there; copy it too for completeness.)
5. Redeploy (`npx vercel --prod --yes`). Reports go live.

## NIPOST API key (one-time)

1. Create a developer account at the NIPOST developer dashboard (linked from
   [docs.postcode.gov.ng](https://docs.postcode.gov.ng)).
2. Create a **test key** (`nipost_test_…`) — free, unmetered, sandbox data.
   It is enough for the showcase demo.
3. Add it as `NIPOST_API_KEY` in Vercel and redeploy.
4. The app only requests L1 lookups on a live key (the cheapest lookup
   the gateway offers) and gates autocomplete to sandbox mode. L2
   (address autofill) is attempted only on sandbox keys, where test
   calls are unmetered — and falls back to L1 when the key is not
   granted above L1 (the current test key is L1-only). It never
   requests L5 coordinates (restricted) — coordinates always come from
   GPS or a map tap. NOTE (19 Nov 2026): the official docs now state
   Lookup/Autocomplete consume credits with no free tier stated for live
   keys, and NIPOST has published no credit pricing — so the cost of
   live validation is unconfirmed. See PHASE-2-REPORT.md.

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

1. Open `<site>/admin.html`, enter your role passcode (Super admin /
   Data admin / Verifier — each passcode signs you in as that role).
   (There is no link to the moderator page anywhere in the app — it is
   reachable only by direct URL.)
2. **Overview** shows live counts from the database and the directory.
3. **Listing reports:** open one, check the listing, then:
   - **Fix the listing** in the master dataset, re-run `build-data.py`, and
     redeploy — resolving a report here only closes the report.
   - **Resolve** with a note, or **Dismiss** with a reason if the report is
     wrong or abusive. (Verifiers can read listing reports but not
     resolve or dismiss them.)
4. **Operator queue:** open a submission, check the business
   documentation reference, and for claims confirm by phone before
   approving — tick the verification checklist in the sheet. Approving
   an availability update publishes it as an “Operator confirmed”
   report; approving a claim marks the listing operator-verified.
   Rejecting publishes nothing. Nothing is ever approved automatically.
5. **Availability** shows recent history (burst flags at 5+/hour) with
   per-row delete for abusive rows. Saheed's own reports (CNG-018,
   CNG-021, CNG-009, 19 Nov) are real — do not delete them.
6. **Audit log** records who did what and when (needs sql/003).
   **Data quality** surfaces duplicate candidates (never merge without
   Saheed's decision) and centres needing re-verification.
   **Postcode** shows the NIPOST mode and key status (the key itself is
   never shown).

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
  └─ /api/admin                passcode-gated moderation (listing reports)
```

- **Reports expire after 2 hours** (`REPORT_TTL_MS` in `js/data.js`), then the
  station shows “Unconfirmed”. Reports are anonymous — only an anonymous daily
  hash is stored, to stop spam. “Back to normal” is a report with status
  `available` — no schema change.
- **Statistics are computed, never hardcoded.** `build-data.py` emits
  `data/stats.json` (total records, refuelling locations, conversion centres,
  Pi-CNG-register-matched, needs re-verification, states with data, no-data
  states, operators, categories).
- **Badges (two, distinct, data-driven):** Officially accredited (Pi-CNG
  register match, register date shown) · Needs re-verification (stale
  2024-list entries, not yet re-checked against a current source).
- **Postcode fallback chain:** exact 6-digit → first-3-digits (dispatch
  district) → GPS / map tap. The app never hard-fails on location. NDAPS
  11-character codes are validated on structure locally; NIPOST does not hand
  out building coordinates via the API, so an NDAPS code alone never produces
  a map point.
- **LGA is not used anywhere** — ~20% of Pi-CNG LGA values are wrong
  (see the coverage report). State + address are the trusted fields.
- **Privacy (NDPA):** no accounts; no names/phones from reporters; location
  used only to find nearby stations, never stored with identity. See
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
| `index.html` | The app (Home/Map, Stations, Centres, Live/Outages, Safety, Calculator, News, Chat, Postcode Explorer, Coverage, Help, Privacy, About, More, station detail) |
| `admin.html` | Moderator queue (passcode-gated): listing reports |
| `css/style.css` | All styles, mobile-first |
| `js/app.js` | Map + clustering, lists, reports, confirmations, calculator |
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
| `scripts/verify-phase2-ui.py` | Drives the live Postcode Explorer in headless Chromium (needs `scripts/local-proxy.js` running — the VM egress proxy needs auth Chromium can't do) |
| `scripts/local-proxy.js` | Test-only local CONNECT relay for headless Chromium (derives proxy auth from HTTPS_PROXY at runtime; never prints it) |

## Showcase

“Built on Nigeria's Postcode”, Session 3 (Public services, safety and
utilities) — Saturday 21 Nov 2026. Apply at pitch.postcode.gov.ng with the
deployed link + a short demo video.
