-- FindCNG Nigeria — Supabase schema (project "findcng", free plan).
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- The /api routes use the service_role key, which bypasses RLS; the anon
-- key has NO access (RLS enabled, no public policies) — the browser only
-- ever talks to the /api routes, never to Supabase directly.

-- Live availability reports. One row per report; the client only shows
-- reports from the last 2 hours (REPORT_TTL_MS in js/data.js).
create table if not exists public.availability_reports (
  id uuid primary key default gen_random_uuid(),
  station_id text not null,
  status text not null check (status in ('available','low','finished','closed')),
  queue_minutes integer,
  pressure_ok boolean,
  compressor_ok boolean,
  reported_at timestamptz not null default now(),
  reporter_hash text
);
alter table public.availability_reports enable row level security;
create index if not exists availability_reports_station_time
  on public.availability_reports (station_id, reported_at desc);

-- LEGACY / DORMANT (2.5, 18 Nov 2026): centre self-registration was
-- reversed and the app no longer reads or writes this table or the
-- "certificates" bucket below. The table is kept in Supabase (NOT dropped)
-- so the historical rows survive; the DDL below stays so a fresh setup
-- matches the live project. Do NOT build new features on it.
-- Centre self-registration queue (as originally designed): rows started as
-- 'pending' and only reached the public directory when a moderator approved
-- them (api/admin.js set status + verification_date).
create table if not exists public.centre_submissions (
  id uuid primary key default gen_random_uuid(),
  centre_name text not null,
  operator text,
  address text,
  state text,
  lga text,
  phone text,
  email text,
  services text,
  accreditation_body text,
  accreditation_number text,
  certificate_path text,          -- path in the private "certificates" bucket
  latitude double precision,
  longitude double precision,
  submitter_contact text,         -- private; moderator only, never published
  status text not null default 'pending',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  decision_reason text,
  verification_date date
);
alter table public.centre_submissions enable row level security;
create index if not exists centre_submissions_status
  on public.centre_submissions (status, submitted_at desc);

-- Private storage bucket for accreditation certificates.
-- (If the bucket already exists from the Dashboard, this is a no-op.)
insert into storage.buckets (id, name, public)
values ('certificates', 'certificates', false)
on conflict (id) do nothing;

-- No public RLS policies are created on purpose: the anon key can read and
-- write nothing. All access goes through the Vercel /api functions with the
-- service_role key. Do NOT add permissive policies later — the certificate
-- photos and submitter contacts in centre_submissions are private.
