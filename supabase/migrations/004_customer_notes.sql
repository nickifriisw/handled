-- Migration 004: Add notes field to customers
-- Lets owners jot down internal notes per customer (e.g. "dog on site", "prefers AM calls")
-- Notes are private — never sent to the customer.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN customers.notes IS
  'Private internal notes visible only to the owner. Never transmitted to the customer.';
