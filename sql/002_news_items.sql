-- FindCNG Nigeria — 2.2 schema addition (project "findcng").
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It creates the news_items table the live News feed needs:
--   news_items — Nigerian CNG news, refreshed every 6 hours by a cron job
--                (see docs/cron-news-refresh.md); served by /api/news.
--
-- Pattern follows sql/001_listing_reports_and_confirmations.sql: RLS
-- enabled, NO public policies (the anon key can do nothing). All access
-- goes through the Vercel /api functions and the refresh cron, both with
-- the service_role key. GRANT ALL to service_role is stated explicitly —
-- on this project the service_role key initially has NO table privileges,
-- so without this grant /api/news cannot read the table at all.
--
-- NOTE: sql/001 does not actually contain an ALTER DEFAULT PRIVILEGES
-- line (only a comment about default privileges). The line below is
-- included anyway as belt and braces: it grants future tables in this
-- schema to service_role too, so a later table is never silently
-- unreadable by the API.
--
-- UNTIL THIS IS RUN: /api/news answers from the static seed file
-- (data/news-seed.json, source "static-fallback") and the app shows the
-- 9 saved items — nothing crashes, and no news is silently lost.
-- After running it, seed the table once with:
--   node scripts/seed-news.mjs
-- (run from the repo root; it reads the keys from .env.local).

create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  source_name text,
  source_url text not null unique,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  topic text
);
alter table public.news_items enable row level security;
grant all on table public.news_items to service_role;
alter default privileges in schema public grant all on tables to service_role;
create index if not exists news_items_published
  on public.news_items (published_at desc nulls last);
create index if not exists news_items_topic
  on public.news_items (topic, published_at desc);

-- No public RLS policies are created on purpose: the anon key can read and
-- write nothing. All access goes through the Vercel /api functions and the
-- refresh cron, both with the service_role key.

-- --- Verification (these run with the file; each should return rows) ---
-- 1. The table exists:
select table_name
  from information_schema.tables
  where table_schema = 'public' and table_name = 'news_items';
-- 2. service_role has full privileges on it (expect SELECT, INSERT,
--    UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER):
select grantee, privilege_type
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'news_items'
  order by grantee, privilege_type;
-- 3. RLS is on (relrowsecurity = true) and no public policy exists
--    (the second query should return zero rows):
select relname, relrowsecurity
  from pg_class
  where relname = 'news_items';
select policyname
  from pg_policies
  where schemaname = 'public' and tablename = 'news_items';
