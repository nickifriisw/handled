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
