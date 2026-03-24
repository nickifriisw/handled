-- Migration 011: message read tracking + owner mobile for notifications
-- 
-- 1. messages.read_at — tracks when owner viewed an inbound message
--    NULL = unread, NOT NULL = read (timestamp when marked read)
--
-- 2. business_owners.owner_mobile — owner's personal phone number
--    Used to send SMS notifications when a customer replies

-- ─── messages: add read_at column ────────────────────────────────────────────
alter table messages
  add column if not exists read_at timestamptz default null;

-- Index for fast "unread count" queries (inbound messages with no read_at)
create index if not exists messages_unread_idx
  on messages (owner_id, customer_id, direction)
  where read_at is null and direction = 'inbound';

-- ─── business_owners: add owner_mobile ───────────────────────────────────────
alter table business_owners
  add column if not exists owner_mobile text default null;

-- ─── Helper: count unread inbound messages per customer for an owner ──────────
-- Used by the dashboard to show unread badges in the message inbox.
create or replace function get_unread_counts(p_owner_id uuid)
returns table (customer_id uuid, unread_count bigint)
language sql
stable
as $$
  select customer_id, count(*) as unread_count
  from messages
  where owner_id = p_owner_id
    and direction = 'inbound'
    and read_at is null
  group by customer_id;
$$;
