# HANDLED — API Server

AI-native SMS admin platform for solo trade businesses (plumbers, electricians, HVAC).  
**Stack:** Node.js · TypeScript · Express · Supabase · Twilio · Anthropic Claude · Stripe · Loops.so

---

## What this does

Every owner gets a dedicated Twilio phone number. When their customers call or text it, HANDLED handles it automatically:

| Trigger | Automation | Timing |
|---------|-----------|--------|
| Missed call | SMS reply | Immediate |
| New job created | Booking confirmation | Immediate |
| "On my way" tapped | ETA message | Immediate |
| Job marked complete | Review request | 60 min delay |
| Estimate sent | Follow-up sequence | Days 2, 5, 10 |
| Job complete + 3 days | Referral ask | 3-day delay |

All messages are lightly personalised by Claude Haiku (name/business substitution), with instant fallback to the raw template if the API fails.

---

## Architecture

```
handled/               ← this repo (Express API, Railway)
handled-web/           ← Next.js 14 dashboard (Vercel)
```

**Data flow:**
```
Customer SMS → Twilio → POST /webhook/sms/inbound → store message + opt-out handling
Customer call → Twilio → POST /webhook/call/missed → A1 automation fires
Railway cron → POST /cron/process-scheduled → send due messages (retry w/ backoff)
Stripe event → POST /webhook/stripe → update subscription_status + send Loops email
```

---

## Routes

### Public webhooks (no auth)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/stripe` | Stripe lifecycle events |
| POST | `/webhook/sms/inbound` | Inbound SMS from customers |
| POST | `/webhook/sms/status` | Twilio delivery callbacks |
| POST | `/webhook/call/missed` | Missed call trigger |
| GET | `/health` | DB + env health check |

### Authenticated API (Supabase JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/summary` | Stats for the overview page |
| GET/POST | `/jobs` | List / create jobs |
| GET/PATCH | `/jobs/:id` | Get / update job status |
| GET | `/jobs/export` | Download jobs CSV |
| GET/POST | `/estimates` | List / create estimates |
| PATCH | `/estimates/:id` | Update estimate status |
| GET | `/messages` | List messages |
| POST | `/messages/send` | Send manual SMS |
| GET | `/customers` | List customers (search, paginate) |
| GET | `/customers/export` | Download customers CSV |
| POST | `/customers/import` | Bulk import from CSV |
| GET/PATCH | `/customers/:id` | Get full history / update |
| GET | `/automations` | List 6 automation configs |
| PATCH | `/automations/:type` | Toggle / edit template |
| GET | `/automations/:type/preview` | Render template with sample data |
| GET | `/queue` | View pending/failed scheduled SMS |
| DELETE | `/queue/:id` | Cancel a pending message |
| GET | `/analytics` | Daily metrics (jobs, SMS, pipeline) |
| GET | `/search` | Full-text search across customers/jobs/estimates |
| GET/PATCH | `/settings` | Owner profile + SMS usage |
| POST | `/checkout/create-session` | Stripe checkout URL |
| POST | `/checkout/portal` | Stripe billing portal URL |

### Cron (CRON_SECRET bearer token)
| Method | Path | Schedule |
|--------|------|----------|
| POST | `/cron/process-scheduled` | Every minute |
| POST | `/cron/expire-estimates` | Daily at 3am |
| POST | `/cron/reset-sms-counts` | 1st of month at midnight |

---

## Database

Supabase (PostgreSQL) with Row Level Security on all tables.

| Table | Purpose |
|-------|---------|
| `business_owners` | One row per owner — profile, Twilio number, Stripe IDs, subscription status |
| `customers` | Customers of each owner (phone, name, opted_out, notes) |
| `jobs` | Job bookings with status workflow |
| `estimates` | Estimates with follow-up scheduling |
| `messages` | Every SMS sent and received |
| `automations` | 6 automation configs per owner (template + enabled + delay) |
| `scheduled_messages` | Queue for delayed automations (retry_count, max_retries, last_error) |
| `stripe_events` | Idempotency log for Stripe webhook events |

**Migrations:**
```
supabase/migrations/
  001_initial_schema.sql          — all tables, enums, indexes, RLS policies
  002_stripe_idempotency.sql      — stripe_events table
  003_scheduled_messages_retry.sql — retry_count, max_retries, last_error columns
  004_customer_notes.sql          — notes column on customers
  005_sms_usage.sql               — sms_count_this_month, sms_month_reset_at
  006_increment_sms_rpc.sql       — atomic increment_sms_count() RPC
  007_performance_indexes.sql     — composite indexes for production queries
```

Run all migrations in order:
```bash
npm run migrate
```

---

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run migrate` | Run pending SQL migrations |
| `npm run backup` | Paginate all tables → `backup/YYYY-MM-DDTHH-mm.json` |
| `npm run daily-digest` | Send activity digest emails via Loops |
| `npm run trial-reminders` | Email owners whose trials end in 3 or 7 days |
| `npm run expire-estimates` | Mark 30+ day old sent estimates as expired |
| `npm run test-sms <number>` | Send a real test SMS to verify Twilio works |
| `npm run pre-deploy` | Full preflight check before deploying |
| `npm run setup-webhooks` | Register Twilio webhook URLs automatically |

---

## Getting started

### 1. Clone and install
```bash
git clone <repo>
cd handled
npm install
cp .env.example .env
```

### 2. Fill in `.env`
See `.env.example` — you'll need:
- Supabase project URL + service role key
- Twilio account SID + auth token
- Anthropic API key
- Stripe secret key + webhook secret + price IDs
- Loops.so API key
- `APP_URL` — your Railway domain (set after first deploy)
- `CRON_SECRET` — any random 32-char string

### 3. Run migrations
```bash
npm run migrate
```

### 4. Verify everything
```bash
npm run pre-deploy
```

### 5. Deploy to Railway
```bash
railway up
```

Railway reads `railway.json` — health check at `/health`, restarts on failure.

### 6. Register Twilio webhooks
After deploy, paste your Railway URL and run:
```bash
APP_URL=https://your-app.railway.app npm run setup-webhooks
```

This registers:
- `POST /webhook/sms/inbound` as the SMS URL on your Twilio number
- `POST /webhook/sms/status` as the Status Callback URL
- `POST /webhook/call/missed` as the Voice URL

### 7. Set up Railway cron jobs
In Railway dashboard → add three Cron services pointing to your API:

| Cron | Schedule | Endpoint |
|------|----------|----------|
| SMS processor | `* * * * *` | `POST /cron/process-scheduled` |
| Expire estimates | `0 3 * * *` | `POST /cron/expire-estimates` |
| Reset SMS counts | `0 0 1 * *` | `POST /cron/reset-sms-counts` |

Each must send `Authorization: Bearer $CRON_SECRET`.

---

## Project structure

```
src/
├── index.ts                      # Express app entry — middleware, routes, error handler
├── types/index.ts                # All TypeScript types, enums, interfaces
├── lib/
│   ├── supabase.ts               # Supabase clients (anon + admin)
│   ├── twilio.ts                 # SMS send, number provision, SMS allowance check
│   ├── claude.ts                 # Message personalisation via Claude Haiku
│   ├── loops.ts                  # Transactional emails (welcome, billing, digest)
│   ├── logger.ts                 # Structured JSON logger (pino)
│   ├── sentry.ts                 # Error tracking (no-op without DSN)
│   └── env.ts                    # Startup env var validation
├── middleware/
│   ├── auth.ts                   # Supabase JWT → req.owner
│   ├── request-id.ts             # UUID per request → X-Request-Id header
│   ├── rate-limit.ts             # Express-rate-limit (API / webhook / cron tiers)
│   └── twilio-validate.ts        # HMAC signature verification for Twilio webhooks
├── automations/
│   ├── engine.ts                 # getAutomation(), fireAutomation(), checkSmsAllowance()
│   ├── a1-missed-call.ts
│   ├── a2-booking-confirmation.ts
│   ├── a3-on-my-way.ts
│   ├── a4-job-complete.ts
│   ├── a5-estimate-follow-up.ts
│   └── a6-referral-ask.ts
└── routes/
    ├── webhooks/
    │   ├── stripe.ts             # Subscription lifecycle (idempotent)
    │   ├── sms.ts                # Inbound SMS + STOP/START handling
    │   ├── status.ts             # Delivery status callbacks
    │   └── call.ts               # Missed call trigger
    ├── jobs.ts
    ├── estimates.ts
    ├── messages.ts
    ├── customers.ts
    ├── automations.ts
    ├── queue.ts                  # Scheduled message queue (view + cancel)
    ├── analytics.ts
    ├── search.ts
    ├── health.ts
    ├── cron.ts                   # process-scheduled, expire-estimates, reset-sms-counts
    ├── dashboard.ts
    ├── checkout.ts
    ├── settings.ts
    └── onboarding.ts

scripts/
├── migrate.ts                    # Run pending SQL migrations
├── db-backup.ts                  # Full DB export to JSON
├── daily-digest.ts               # Activity digest emails
├── trial-reminders.ts            # Trial expiry email nudges
├── expire-estimates.ts           # Mark stale estimates as expired
├── send-test-sms.ts              # Dev: fire a real test SMS
├── setup-twilio-webhooks.ts      # Register webhook URLs with Twilio
├── seed.ts                       # Dev seed data
└── pre-deploy.ts                 # Preflight checklist

supabase/migrations/              # All schema changes, numbered and idempotent
tests/
├── routes.test.ts                # Subscription, job transitions, CSV, phone, cron auth
├── automations.test.ts           # Template interpolation, scheduling logic
└── features.test.ts              # Analytics, search, import, health, SMS cap, backoff
```

---

## Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS — keep secret) |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Default number (overridden per-owner after provisioning) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (use `sk_test_` locally) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe → Webhooks → your endpoint |
| `STRIPE_PRICE_ID_MONTHLY` | Monthly plan price ID |
| `STRIPE_PRICE_ID_ANNUAL` | Annual plan price ID |
| `LOOPS_API_KEY` | Loops.so API key |
| `APP_URL` | Your Railway URL (e.g. `https://handled.up.railway.app`) |
| `CRON_SECRET` | Random secret — Railway cron sends this as Bearer token |
| `SENTRY_DSN` | Optional — error tracking (app runs fine without it) |

---

## Trial limits

Accounts on `trialing` status are capped at **50 SMS/month**.  
The cap is enforced at two points:
1. `engine.ts` → `checkSmsAllowance()` before immediate sends
2. `cron.ts` → `checkSmsAllowance()` before processing scheduled messages

The count resets on the 1st of each month via `/cron/reset-sms-counts`.  
Paid accounts (`active`) have no cap.

---

## Security notes

- All routes require a valid Supabase JWT except webhooks and `/health`
- Twilio webhooks are verified with HMAC signature (skipped in development)
- Stripe webhook uses `stripe.webhooks.constructEvent()` with raw body
- RLS policies on all tables: users can only read/write their own data
- `supabaseAdmin` (service role) is used only in server-side handlers — never exposed to browser
- Request IDs (`X-Request-Id`) on every response for tracing
- Rate limiting: 100 req/15min API, 30 req/min webhooks, 10 req/min cron

---

## Tests

```bash
npm test
```

3 test suites, 134 tests — all pure logic, no network calls, runs in ~6s.
