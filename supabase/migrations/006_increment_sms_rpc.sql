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
