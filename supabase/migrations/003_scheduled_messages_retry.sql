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
