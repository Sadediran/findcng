-- FindCNG Nigeria — 2.0 schema additions (project "findcng").
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It creates the two tables the 2.0 reporting features need:
--   listing_reports      — "Report an incorrect listing" / "Report a closure"
--   report_confirmations — one-tap confirm (yes / not sure / no) on a live report
--
-- Pattern follows supabase/schema.sql: RLS enabled, NO public policies
-- (the anon key can do nothing). All access goes through the Vercel /api
-- functions with the service_role key. GRANT ALL to service_role is stated
-- explicitly so the API routes keep working if default privileges change.
--
-- UNTIL THIS IS RUN: /api/listing-reports and /api/confirmations answer
-- { ok: false, error: "not_open" } and the app shows "not open yet" —
-- nothing crashes, and no report is silently lost (the app says so).

-- Listing reports: a user flags a directory entry as wrong, closed or moved.
create table if not exists public.listing_reports (
  id uuid primary key default gen_random_uuid(),
  station_id text not null,
  report_type text not null check (report_type in ('incorrect', 'closed', 'moved', 'other')),
  details text,
  reporter_hash text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text,
  reported_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);
alter table public.listing_reports enable row level security;
grant all on table public.listing_reports to service_role;
create index if not exists listing_reports_status
  on public.listing_reports (status, reported_at desc);
create index if not exists listing_reports_station
  on public.listing_reports (station_id, reported_at desc);

-- Report confirmations: one tap (yes / not sure / no) on the latest live
-- availability report for a station. A voter can only vote once per report
-- per day — the unique index enforces it (same reporter_hash + report).
create table if not exists public.report_confirmations (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.availability_reports (id) on delete cascade,
  station_id text not null,
  vote text not null check (vote in ('yes', 'unsure', 'no')),
  reporter_hash text,
  confirmed_at timestamptz not null default now(),
  unique (report_id, reporter_hash)
);
alter table public.report_confirmations enable row level security;
grant all on table public.report_confirmations to service_role;
create index if not exists report_confirmations_report
  on public.report_confirmations (report_id, confirmed_at desc);
create index if not exists report_confirmations_station
  on public.report_confirmations (station_id, confirmed_at desc);

-- No public RLS policies are created on purpose: the anon key can read and
-- write nothing. All access goes through the Vercel /api functions with the
-- service_role key.
