-- 012 — Add notes column to jobs
-- Allows owners to store internal notes on a job (not sent to the customer).

alter table jobs
  add column if not exists notes text default null;
