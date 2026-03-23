-- Migration 009: Customer notes
--
-- Adds a free-text notes field to customers so owners can jot down
-- anything relevant (parking info, access codes, preferences, etc.).
-- Displayed and editable on the /customers/[id] detail page.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notes text;
