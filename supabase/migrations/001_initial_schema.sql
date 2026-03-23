-- HANDLED — initial schema
-- Run via: supabase db push  (or paste into Supabase SQL editor)

-- ─── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_cron";

-- ─── Enums ───────────────────────────────────────────────────────────────────
create type subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled'
);
create type job_status as enum (
  'booked', 'on_my_way', 'completed', 'cancelled'
);
create type estimate_status as enum (
  'sent', 'accepted', 'declined', 'expired'
);
create type message_direction as enum ('inbound', 'outbound');
create type message_status as enum (
  'queued', 'sent', 'delivered', 'failed'
);
create type automation_type as enum (
  'missed_call', 'booking_confirmation', 'on_my_way',
  'job_complete', 'estimate_follow_up', 'referral_ask'
);
create type scheduled_message_status as enum (
  'pending', 'sent', 'failed', 'cancelled'
);

-- ─── business_owners ─────────────────────────────────────────────────────────
create table business_owners (
  id                     uuid primary key default uuid_generate_v4(),
  email                  text unique not null,
  full_name              text not null,
  business_name          text not null,
  trade_type             text not null default 'plumber',
  twilio_number          text unique,
  google_review_link     text,
  stripe_customer_id     text,
  stripe_subscription_id text,
  subscription_status    subscription_status not null default 'trialing',
  trial_ends_at          timestamptz,
  timezone               text not null default 'Europe/London',
  created_at             timestamptz not null default now()
);

-- ─── customers ───────────────────────────────────────────────────────────────
create table customers (
  id         uuid primary key default uuid_generate_v4(),
  owner_id   uuid not null references business_owners(id) on delete cascade,
  phone      text not null,
  name       text,
  opted_out  boolean not null default false,
  created_at timestamptz not null default now(),
  unique(owner_id, phone)
);

-- ─── jobs ─────────────────────────────────────────────────────────────────────
create table jobs (
  id           uuid primary key default uuid_generate_v4(),
  owner_id     uuid not null references business_owners(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  description  text not null,
  scheduled_at timestamptz,
  address      text,
  status       job_status not null default 'booked',
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- ─── estimates ────────────────────────────────────────────────────────────────
create table estimates (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  amount_pence    integer not null,
  description     text not null,
  status          estimate_status not null default 'sent',
  sent_at         timestamptz,
  follow_up_count integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ─── messages ─────────────────────────────────────────────────────────────────
create table messages (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  direction       message_direction not null,
  body            text not null,
  twilio_sid      text unique,
  status          message_status not null default 'queued',
  automation_type automation_type,
  created_at      timestamptz not null default now()
);

-- ─── automations ──────────────────────────────────────────────────────────────
create table automations (
  id             uuid primary key default uuid_generate_v4(),
  owner_id       uuid not null references business_owners(id) on delete cascade,
  type           automation_type not null,
  enabled        boolean not null default true,
  template       text not null,
  delay_minutes  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique(owner_id, type)
);

-- ─── scheduled_messages ───────────────────────────────────────────────────────
create table scheduled_messages (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references business_owners(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  body            text not null,
  send_at         timestamptz not null,
  status          scheduled_message_status not null default 'pending',
  automation_type automation_type,
  job_id          uuid references jobs(id) on delete set null,
  estimate_id     uuid references estimates(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
create index idx_customers_owner_id     on customers(owner_id);
create index idx_customers_phone        on customers(phone);
create index idx_jobs_owner_id          on jobs(owner_id);
create index idx_jobs_customer_id       on jobs(customer_id);
create index idx_jobs_status            on jobs(status);
create index idx_estimates_owner_id     on estimates(owner_id);
create index idx_messages_owner_id      on messages(owner_id);
create index idx_messages_customer_id   on messages(customer_id);
create index idx_scheduled_owner_id     on scheduled_messages(owner_id);
create index idx_scheduled_send_at      on scheduled_messages(send_at)
  where status = 'pending';

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table business_owners     enable row level security;
alter table customers           enable row level security;
alter table jobs                enable row level security;
alter table estimates           enable row level security;
alter table messages            enable row level security;
alter table automations         enable row level security;
alter table scheduled_messages  enable row level security;

-- business_owners: each user sees only their own row
create policy "owner: select own row"
  on business_owners for select
  using (auth.uid() = id);

create policy "owner: update own row"
  on business_owners for update
  using (auth.uid() = id);

-- customers: scoped to owner
create policy "customers: owner access"
  on customers for all
  using (auth.uid() = owner_id);

-- jobs: scoped to owner
create policy "jobs: owner access"
  on jobs for all
  using (auth.uid() = owner_id);

-- estimates: scoped to owner
create policy "estimates: owner access"
  on estimates for all
  using (auth.uid() = owner_id);

-- messages: scoped to owner
create policy "messages: owner access"
  on messages for all
  using (auth.uid() = owner_id);

-- automations: scoped to owner
create policy "automations: owner access"
  on automations for all
  using (auth.uid() = owner_id);

-- scheduled_messages: scoped to owner
create policy "scheduled_messages: owner access"
  on scheduled_messages for all
  using (auth.uid() = owner_id);

-- ─── Default automation templates seeded per new owner ────────────────────────
-- Called from the /onboarding/provision endpoint using service_role key,
-- which bypasses RLS. Templates use {{variable}} placeholders.
-- (No triggers here — seeding done in application code for testability.)

-- ─── updated_at trigger for automations ──────────────────────────────────────
create or replace function set_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger automations_updated_at
  before update on automations
  for each row execute procedure set_updated_at();
