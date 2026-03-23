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
