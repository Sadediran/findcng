# FindCNG news refresh — recurring cron job (every 6 hours)

**Purpose:** keep the News page on https://findcng.vercel.app fresh with
genuinely new, genuinely Nigerian CNG news. The app reads the
`news_items` table through `GET /api/news`; this job is the only writer
that adds new items to that table.

**This document is self-contained.** Paste its "Job instructions" section
into the cron job as-is; whoever runs it needs nothing else except the
keys file below. No spend, no new accounts, no paid APIs.

---

## Facts the job needs

| Fact | Value |
|---|---|
| Supabase project ref | `ifzxzujapltrorsygszk` |
| Supabase project URL | `https://ifzxzujapltrorsygszk.supabase.co` |
| Supabase REST base | `https://ifzxzujapltrorsygszk.supabase.co/rest/v1` |
| Keys file | `~/workspace/findcng/.env.local` — read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from it. **Never print, log, or record any key value.** |
| Repo | `~/workspace/findcng` (seed file `data/news-seed.json`, API `api/news.js`, SQL `sql/002_news_items.sql`) |
| Table | `public.news_items` — columns: `id` (uuid, default), `title` (text, required), `summary` (text), `source_name` (text), `source_url` (text, required, **unique**), `published_at` (timestamptz), `fetched_at` (timestamptz, default `now()`), `topic` (text) |
| Table cap | **100 rows, latest by `published_at`.** Prune older rows every run (see step 5). |

## REST calls (all with the service_role key)

Every request carries these headers (values from `.env.local`):

```
apikey: <SUPABASE_SERVICE_ROLE_KEY>
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
Content-Type: application/json
```

**1. Read what is already stored** (dedupe source):

```
GET https://ifzxzujapltrorsygszk.supabase.co/rest/v1/news_items?select=id,source_url,title,published_at&order=published_at.desc&limit=200
```

**2. Insert new items** (one POST, array body; `Prefer: return=minimal`):

```
POST https://ifzxzujapltrorsygszk.supabase.co/rest/v1/news_items
Prefer: return=minimal

[
  {
    "title": "Example: 40 new CNG stations open in Lagos",
    "summary": "One or two sentences in your own words, faithful to the article. Never copy the full article text.",
    "source_name": "Punch",
    "source_url": "https://punchng.com/example-article/",
    "published_at": "2026-11-18T10:00:00Z",
    "topic": "infrastructure"
  }
]
```

`topic` is one of: `adoption`, `safety`, `infrastructure`, `policy`,
`prices`, `programme`. Omit `id` and `fetched_at` — the database fills
them in. If an insert fails with a unique-violation on `source_url`
(PostgREST `23505`), that item is a duplicate: skip it and continue with
the rest.

**3. Prune to the latest 100** (every run, after inserting):

```
GET https://ifzxzujapltrorsygszk.supabase.co/rest/v1/news_items?select=id&order=published_at.desc.nullslast&limit=200
```

Keep the first 100 ids. If there are more, delete the rest in one call
(`id=in.(uuid1,uuid2,...)` — comma-separated, no spaces, URL-encoded
parentheses are fine unencoded):

```
DELETE https://ifzxzujapltrorsygszk.supabase.co/rest/v1/news_items?id=in.(<uuid>,<uuid>,...)
```

Delete in batches of at most 50 ids per call if the list is long.

## Job instructions (paste into the cron)

> **FindCNG news refresh — runs every 6 hours.**
>
> **1. Check the table exists.** GET
> `https://ifzxzujapltrorsygszk.supabase.co/rest/v1/news_items?select=id&limit=1`
> with the headers above (keys from `~/workspace/findcng/.env.local` —
> never print them). If it answers 404 / `PGRST205` / "Could not find the
> table", the table has not been created yet (`sql/002_news_items.sql`
> still needs running in the Supabase SQL editor): **exit quietly, no
> error spam, no report.** Do not attempt to create the table.
>
> **2. Read what is already stored.** GET the existing items (call 1
> above: `id, source_url, title, published_at`, newest first). You need
> this for dedupe.
>
> **3. Search for fresh Nigerian CNG news.** Use the **news vertical**
> with these targeted queries (all of them, each run):
> - `CNG Nigeria`
> - `Pi-CNG` (also try `PCNGI` and `Presidential CNG Initiative`)
> - `NADDC CNG`
> - `NIPOST postcode` (only items about the postcode system / CNG
>   location services — skip pure postcode admin news with no CNG angle)
> - `CNG stations Nigeria`
> - `CNG conversion Nigeria`
>
> Prefer items published since the last run; anything from the last 7
> days is eligible if it is not already stored. **Every item must link
> to a real published article you actually found in the search results
> — copy its URL verbatim from the results. Never invent a headline,
> a date, a figure, or a URL. Never guess a URL from a domain.**
>
> **4. Decide what to insert — be strict.**
> - **Relevant only:** the item must be about CNG (or the Pi-CNG / NADDC
>   programme) **in Nigeria**. Skip LPG/cooking-gas stories, global gas
>   prices, and anything where CNG is only a passing mention.
> - **Dedupe twice:** (a) exact `source_url` match against what is
>   stored — skip; (b) normalized-title similarity — lowercase the
>   title, strip punctuation and extra words like "breaking", then
>   compare with stored titles: if it reads as the same story (same
>   event, same figures, even from a different outlet), skip it. One
>   story = one row; keep the earliest-published version.
> - **Skip press-release spam:** near-identical releases syndicated
>   across many small outlets, sponsored "brand voice" pieces, and
>   listicles with no news in them.
> - **Skip off-topic items:** politics, fuel-subsidy commentary with no
>   CNG content, and EV-only stories (unless the piece is about the
>   joint Pi-CNG & EV programme).
> - **Quality bar:** if you cannot verify the story from the article
>   itself (headline + snippet at minimum), do not insert it. When in
>   doubt, skip it — missing one story is better than publishing a
>   wrong one. A run that inserts nothing is a successful run.
> - Write the `summary` in your own words, 1–2 sentences, faithful to
>   the article. Set `published_at` from the article's published date
>   (ISO 8601; date-only is fine). Set `topic` from the list above.
>
> **5. Insert, then prune.** POST the genuinely new items (call 2
> above). Then prune the table to the latest 100 by `published_at`
> (call 3 above). If the table holds 100 or fewer rows, there is
> nothing to prune.
>
> **6. Report briefly.** One short line per run: how many items were
> found, how many inserted (titles), how many pruned. Stay silent
> about runs that found nothing new, beyond that one line. Never
> include any key value in any report.

## How to check it worked

- `GET https://findcng.vercel.app/api/news` should return
  `{ "ok": true, "source": "live", ... }` with the newest item first.
  (`source: "static-fallback"` means the table is still missing.)
- The News page on the live site shows an "Updated …" line from the
  newest `fetched_at`.
- `~/workspace/findcng/verify-live.py` includes a news check
  (`check_news_feed`) that passes in both live and static-fallback mode.
