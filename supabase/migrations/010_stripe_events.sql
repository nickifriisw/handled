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
