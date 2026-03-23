-- HANDLED — initial schema
-- Run via: supabase db push  (or paste into Supabase SQL editor)

-- ─── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_cron";

-- ─── Enums ───────────────────────────────────────────────────────────────────
create type subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled'
);
create type job_status as enum (
  'booked', 'on_my_way', 'completed', 'cancelled'
);
create type estimate_status as enum (
  'sent', 'accepted', 'declined', 'expired'
);
create type message_direction as enum ('inbound', 'outbound');
create type message_status as enum (
  'queued', 'sent', 'delivered', 'failed'
);
create type automation_type as enum (
  'missed_call', 'booking_confirmation', 'on_my_way',
  'job_complete', 'estimate_follow_up', 'referral_ask'
);
create type scheduled_message_status as enum (
  'pending', 'sent', 'failed', 'cancelled'
);

-- ─── business_owners ─────────────────────────────────────────────────────────
create table business_owners (
  id                     uuid primary key default uuid_generate_v4(),
  email                  text unique not null,
  full_name              text not null,
  business_name          text not null,
  trade_type             text not null default 'plumber',
  twilio_number          text unique,
  google_review_link     text,
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    subscription_status not null default 'trialing',
  trial_ends_at          timestamptz,
  timezone               text not null default 'Europe/London',
  created_at             timestamptz not null default now()
);

-- ─── customers ───────────────────────────────────────────────────────────────
create table customers (
  id         uuid primary key default uuid_generate_v4(),
  owner_id   uuid not null references business_owners(id) on delete cascade,
  phone      text not null,
  name       text,
  opted_out  boolean not null default false,
  created_at timestamptz not null default now(),
  unique(owner_id, phone)
);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
create table jobs (
  id           uuid primary key default uuid_generate_v4(),
  owner_id     uuid not null references business_owners(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  description  text not null,
  scheduled_at timestamptz,
  address      text,
  status       job_status not null default 'booked',
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ─── estimates ────────────────────────────────────────────────────────────────
create table estimates (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  amount_pence    integer not null,
  description     text not null,
  status          estimate_status not null default 'sent',
  sent_at         timestamptz,
  follow_up_count integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ─── messages ─────────────────────────────────────────────────────────────────
create table messages (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  direction       message_direction not null,
  body            text not null,
  twilio_sid      text unique,
  status          message_status not null default 'queued',
  automation_type automation_type,
  created_at      timestamptz not null default now()
);

-- ─── automations ──────────────────────────────────────────────────────────────
create table automations (
  id             uuid primary key default uuid_generate_v4(),
  owner_id       uuid not null references business_owners(id) on delete cascade,
  type           automation_type not null,
  enabled        boolean not null default true,
  template       text not null,
  delay_minutes  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(owner_id, type)
);

-- ─── scheduled_messages ───────────────────────────────────────────────────────
create table scheduled_messages (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  body            text not null,
  send_at         timestamptz not null,
  status          scheduled_message_status not null default 'pending',
  automation_type automation_type,
  job_id          uuid references jobs(id) on delete set null,
  estimate_id     uuid references estimates(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index idx_customers_owner_id     on customers(owner_id);
create index idx_customers_phone        on customers(phone);
create index idx_jobs_owner_id          on jobs(owner_id);
create index idx_jobs_customer_id       on jobs(customer_id);
create index idx_jobs_status            on jobs(status);
create index idx_estimates_owner_id     on estimates(owner_id);
create index idx_messages_owner_id      on messages(owner_id);
create index idx_messages_customer_id   on messages(customer_id);
create index idx_scheduled_owner_id     on scheduled_messages(owner_id);
create index idx_scheduled_send_at      on scheduled_messages(send_at)
  where status = 'pending';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table business_owners     enable row level security;
alter table customers           enable row level security;
alter table jobs                enable row level security;
alter table estimates           enable row level security;
alter table messages            enable row level security;
alter table automations         enable row level security;
alter table scheduled_messages  enable row level security;

-- business_owners: each user sees only their own row
create policy "owner: select own row"
  on business_owners for select
  using (auth.uid() = id);

create policy "owner: update own row"
  on business_owners for update
  using (auth.uid() = id);

-- customers: scoped to owner
create policy "customers: owner access"
  on customers for all
  using (auth.uid() = owner_id);

-- jobs: scoped to owner
create policy "jobs: owner access"
  on jobs for all
  using (auth.uid() = owner_id);

-- estimates: scoped to owner
create policy "estimates: owner access"
  on estimates for all
  using (auth.uid() = owner_id);

-- messages: scoped to owner
create policy "messages: owner access"
  on messages for all
  using (auth.uid() = owner_id);

-- automations: scoped to owner
create policy "automations: owner access"
  on automations for all
  using (auth.uid() = owner_id);

-- scheduled_messages: scoped to owner
create policy "scheduled_messages: owner access"
  on scheduled_messages for all
  using (auth.uid() = owner_id);

-- ─── Default automation templates seeded per new owner ────────────────────────
-- Called from the /onboarding/provision endpoint using service_role key,
-- which bypasses RLS. Templates use {{variable}} placeholders.
-- (No triggers here — seeding done in application code for testability.)

-- ─── updated_at trigger for automations ──────────────────────────────────────
create or replace function set_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger automations_updated_at
  before update on automations
  for each row execute procedure set_updated_at();
-- Migration 002 — Stripe event idempotency
--
-- Stores processed Stripe event IDs so the webhook handler can safely
-- ignore duplicate deliveries (Stripe retries failed webhooks up to 3 days).
--
-- Usage in the webhook handler:
--   1. INSERT into stripe_events — if it conflicts, the event was already processed → return 200 immediately
--   2. Process the event
--   3. UPDATE stripe_events.processed_at on success

create table stripe_events (
  id           text primary key,          -- Stripe event ID (evt_...)
  type         text not null,             -- e.g. checkout.session.completed
  received_at  timestamptz not null default now(),
  processed_at timestamptz               -- null = in-flight or failed
);

-- RLS: this table is only ever accessed by the service-role key (server-side)
alter table stripe_events enable row level security;
-- No RLS policies needed — service role bypasses RLS automatically.

-- Auto-clean events older than 90 days (Stripe's retry window is 3 days)
create index idx_stripe_events_received on stripe_events(received_at);
-- Migration 003: Add retry columns to scheduled_messages
-- Allows the cron processor to retry failed SMS sends with exponential backoff
-- instead of permanently failing on the first Twilio error.

ALTER TABLE scheduled_messages
  ADD COLUMN IF NOT EXISTS retry_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries  integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS last_error   text;

COMMENT ON COLUMN scheduled_messages.retry_count IS
  'Number of send attempts made so far (0 = not yet attempted).';
COMMENT ON COLUMN scheduled_messages.max_retries IS
  'Maximum attempts before the row is marked failed permanently.';
COMMENT ON COLUMN scheduled_messages.last_error IS
  'Error message from the most recent failed attempt.';
-- Migration 004: Add notes field to customers
-- Lets owners jot down internal notes per customer (e.g. "dog on site", "prefers AM calls")
-- Notes are private — never sent to the customer.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN customers.notes IS
  'Private internal notes visible only to the owner. Never transmitted to the customer.';
-- Migration 005: SMS usage tracking
-- Tracks outbound SMS count per calendar month so we can cap trial accounts
-- and show owners their usage without hitting the Twilio API.

ALTER TABLE business_owners
  ADD COLUMN IF NOT EXISTS sms_count_this_month  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sms_month_reset_at    timestamptz NOT NULL DEFAULT date_trunc('month', now());

COMMENT ON COLUMN business_owners.sms_count_this_month IS
  'Outbound SMS sent in the current calendar month. Reset to 0 on the 1st.';
COMMENT ON COLUMN business_owners.sms_month_reset_at IS
  'Timestamp of the last monthly counter reset.';

-- Trial accounts are capped at 50 SMS / month.
-- The cron processor checks this before sending.
-- Paid accounts have no limit (enforced in application code, not DB).
-- Migration 006: Atomic SMS counter increment RPC
-- Using a stored function ensures the increment is race-condition-safe
-- even if multiple cron ticks run close together.

CREATE OR REPLACE FUNCTION increment_sms_count(owner_id_input uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE business_owners
  SET sms_count_this_month = sms_count_this_month + 1
  WHERE id = owner_id_input;
$$;
-- ─── Migration 007: Production performance indexes ──────────────────────────
--
-- Adds composite and partial indexes for the most common production queries.
-- The initial schema (001) covers single-column indexes; these cover
-- multi-column query patterns seen in the dashboard, queue, and analytics routes.
--
-- All indexes are created to avoid table locks on a live DB.
-- (Remove if running against a fresh/empty database.)

-- ── Dashboard summary query ───────────────────────────────────────────────────
-- GET /dashboard/summary filters jobs/estimates/messages by owner + date range

create index if not exists idx_jobs_owner_created
  on jobs(owner_id, created_at desc);

create index if not exists idx_jobs_owner_status
  on jobs(owner_id, status);

create index if not exists idx_estimates_owner_status
  on estimates(owner_id, status);

create index if not exists idx_estimates_owner_sent_at
  on estimates(owner_id, sent_at desc)
  where sent_at is not null;

create index if not exists idx_messages_owner_created
  on messages(owner_id, created_at desc);

-- ── Analytics route ──────────────────────────────────────────────────────────
-- GET /analytics groups by day over a window — needs fast date-range scans

create index if not exists idx_jobs_owner_scheduled
  on jobs(owner_id, scheduled_at)
  where scheduled_at is not null;

create index if not exists idx_messages_owner_direction
  on messages(owner_id, direction, created_at desc);

-- ── Queue / scheduled messages ────────────────────────────────────────────────
-- GET /queue and cron processor filter by owner + status + send_at

create index if not exists idx_scheduled_owner_status_send
  on scheduled_messages(owner_id, status, send_at)
  where status in ('pending', 'failed');

-- ── Customer search ───────────────────────────────────────────────────────────
-- GET /customers?search= and GET /search use ilike on name + phone

create index if not exists idx_customers_owner_name
  on customers(owner_id, name)
  where name is not null;

-- ── Estimate expiry cron ──────────────────────────────────────────────────────
-- POST /cron/expire-estimates scans for sent estimates older than N days

create index if not exists idx_estimates_status_sent_at
  on estimates(status, sent_at)
  where status = 'sent' and sent_at is not null;

-- ── Messages by customer (thread view) ───────────────────────────────────────
-- GET /customers/:id and messages page fetch full threads

create index if not exists idx_messages_customer_created
  on messages(customer_id, created_at asc);

-- ── Twilio number lookup (inbound webhook) ────────────────────────────────────
-- POST /webhook/sms/inbound looks up owner by twilio_number

create index if not exists idx_owners_twilio_number
  on business_owners(twilio_number)
  where twilio_number is not null;

-- ── Stripe customer ID lookup ─────────────────────────────────────────────────
-- Stripe webhook handlers look up owner by stripe_customer_id

create index if not exists idx_owners_stripe_customer
  on business_owners(stripe_customer_id)
  where stripe_customer_id is not null;
-- Migration 008: Public token for customer-facing estimate acceptance links
--
-- Each estimate gets a UUID token used to build a shareable URL:
--   https://your-app.com/e/<public_token>
-- The token is unguessable (UUID v4) and allows the customer to
-- view and accept/decline their estimate without a HANDLED account.

-- Add public_token (nullable first so existing rows don't fail)
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS public_token uuid DEFAULT gen_random_uuid();

-- Add responded_at: timestamp when the customer accepted or declined
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS responded_at timestamptz;

-- Add owner_mobile: owner's personal phone number for SMS notifications
-- (distinct from twilio_number which is the business line)
ALTER TABLE business_owners
  ADD COLUMN IF NOT EXISTS owner_mobile text;

-- Backfill any existing rows that somehow have a null token
UPDATE estimates
  SET public_token = gen_random_uuid()
  WHERE public_token IS NULL;

-- Now enforce NOT NULL and UNIQUE
ALTER TABLE estimates
  ALTER COLUMN public_token SET NOT NULL,
  ADD CONSTRAINT estimates_public_token_unique UNIQUE (public_token);

-- Fast lookup by token (used on every public page load)
CREATE INDEX IF NOT EXISTS idx_estimates_public_token
  ON estimates (public_token);

-- RLS: the public route uses supabaseAdmin (service role) so no RLS policy
-- needed for anon reads — the application layer validates the token itself.
-- Migration 009: Customer notes
--
-- Adds a free-text notes field to customers so owners can jot down
-- anything relevant (parking info, access codes, preferences, etc.).
-- Displayed and editable on the /customers/[id] detail page.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notes text;
-- Migration 010: Stripe webhook idempotency — add created_at column
--
-- Migration 002 created stripe_events(id, type, received_at, processed_at).
-- This migration adds the canonical created_at column used by the backend
-- webhook handler (src/routes/webhooks/stripe.ts) and adds an index for
-- future auto-purge of events older than 90 days.

ALTER TABLE stripe_events
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_stripe_events_created_at
  ON stripe_events (created_at);
