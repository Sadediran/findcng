-- FindCNG Nigeria — Phase 4 schema additions (project "findcng").
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It creates the two tables the Phase 4 operator portal and admin
-- dashboard need, and adds a source column to availability_reports:
--   operator_submissions — operator registration, ownership claims,
--                          update requests, operator availability
--                          updates, and responses to user reports.
--                          EVERY row starts as 'pending' and NOTHING is
--                          published or marked "Operator confirmed"
--                          until a moderator approves that exact
--                          submission (see api/admin.js).
--   audit_log            — who did what, when (admin actions only).
--   availability_reports.source — 'community' (default, every driver
--                          report) or 'operator' (only rows an admin
--                          approved from an operator submission).
--
-- Pattern follows supabase/schema.sql and sql/001: RLS enabled, NO
-- public policies (the anon key can do nothing). All access goes
-- through the Vercel /api functions with the service_role key.
--
-- UNTIL THIS IS RUN: /api/operator answers { ok: false, error:
-- "not_open" } and the operator portal shows "not open yet" instead of
-- crashing or silently dropping a submission; the admin operator queue
-- and audit log show the same honest state. The rest of the app
-- (reports, listing reports, confirmations, news, chat) is unaffected:
-- api/reports.js selects the source column only when it exists and
-- falls back to community-only otherwise.

-- Operator submissions. `payload` is a JSON object whose shape depends
-- on `type` (validated server-side in api/operator.js):
--   register     — { business_name, address, state, services?,
--                    accreditation_body?, accreditation_number?,
--                    latitude?, longitude? }  (station_id is null)
--   claim        — { station_id, proof_reference } — the operator claims
--                    an existing listing; proof_reference is a business
--                    documentation reference the moderator checks
--                    manually (there is no automated verification).
--   update       — { station_id, changes } — free-text description of
--                    the hours / services / contact change requested.
--   availability — { station_id, status, queue_minutes?,
--                    pressure_ok?, compressor_ok? } — published as an
--                    availability report with source 'operator' ONLY
--                    when a moderator approves it.
--   response     — { station_id, listing_report_id?, message } — the
--                    operator's reply to a user report about their
--                    station; shown to moderators, never auto-published.
-- Contact details (phone, email, submitter_contact) are PRIVATE:
-- moderator-only, never returned by any public endpoint and never
-- published on a listing.
create table if not exists public.operator_submissions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('register', 'claim', 'update', 'availability', 'response')),
  station_id text,
  business_name text not null,
  contact_name text,
  phone text,
  email text,
  payload jsonb not null default '{}'::jsonb,
  proof_reference text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  decision_reason text,
  verification_notes text,
  reporter_hash text
);
alter table public.operator_submissions enable row level security;
grant all on table public.operator_submissions to service_role;
create index if not exists operator_submissions_status
  on public.operator_submissions (status, submitted_at desc);
create index if not exists operator_submissions_station
  on public.operator_submissions (station_id, submitted_at desc);

-- Audit log: one row per admin action. actor_role is the role passcode
-- used (super_admin / data_admin / verifier) — there are no named
-- accounts in this stack, so the role is the actor. `detail` is
-- free text (what changed, any note); it must never contain a
-- passcode, a secret, or a submitter's private contact details.
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_role text not null,
  action text not null,
  target_type text,
  target_id text,
  detail text,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
grant all on table public.audit_log to service_role;
create index if not exists audit_log_created
  on public.audit_log (created_at desc);

-- Source of an availability report. 'community' is every driver report
-- filed through /api/reports. 'operator' is ONLY set by the admin
-- approval path in api/admin.js, when a moderator approves an operator
-- availability submission — no public route can set it. The client
-- shows "Operator confirmed" only for source='operator' rows.
alter table public.availability_reports
  add column if not exists source text not null default 'community'
  check (source in ('community', 'operator'));
create index if not exists availability_reports_source
  on public.availability_reports (source, reported_at desc);

-- No public RLS policies are created on purpose: the anon key can read
-- and write nothing. All access goes through the Vercel /api functions
-- with the service_role key.
