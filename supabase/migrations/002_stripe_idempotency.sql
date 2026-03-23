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
