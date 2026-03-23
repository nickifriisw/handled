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
