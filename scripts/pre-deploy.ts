/**
 * scripts/pre-deploy.ts
 *
 * Pre-deploy validation — run before Railway deploys the API server.
 * Exits 0 if everything looks good, exits 1 on any failure.
 *
 * Usage (add to Railway build command):
 *   npm ci && npx tsx scripts/pre-deploy.ts && npm run build
 *
 * Or run manually:
 *   npx tsx scripts/pre-deploy.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const OK   = '  ✅';
const FAIL = '  ❌';
const WARN = '  ⚠️ ';

let hasErrors = false;

function pass(label: string, detail?: string) {
  console.log(`${OK} ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string) {
  console.error(`${FAIL} ${label}${detail ? ` — ${detail}` : ''}`);
  hasErrors = true;
}

function warn(label: string, detail?: string) {
  console.warn(`${WARN} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── 1. Required environment variables ────────────────────────────────────────

console.log('\n── Environment variables ─────────────────────────────────────');

const REQUIRED: Record<string, string> = {
  SUPABASE_URL:              'Supabase project URL',
  SUPABASE_ANON_KEY:         'Supabase anon key',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service-role key',
  TWILIO_ACCOUNT_SID:        'Twilio account SID (ACxx...)',
  TWILIO_AUTH_TOKEN:         'Twilio auth token',
  TWILIO_FROM_NUMBER:        'Twilio phone number in E.164',
  ANTHROPIC_API_KEY:         'Anthropic API key (sk-ant-...)',
  STRIPE_SECRET_KEY:         'Stripe secret key',
  STRIPE_WEBHOOK_SECRET:     'Stripe webhook signing secret',
  STRIPE_PRICE_ID_MONTHLY:   'Stripe monthly price ID',
  LOOPS_API_KEY:             'Loops.so API key',
  CRON_SECRET:               'Secret for cron endpoint auth',
  APP_URL:                   'Public URL of this API (e.g. https://handled.railway.app)',
};

const OPTIONAL: Record<string, string> = {
  TWILIO_PHONE_SID:            'Required by setup-webhooks script',
  STRIPE_PRICE_ID_ANNUAL:      'Annual pricing (optional)',
  SENTRY_DSN:                  'Error monitoring (optional)',
  LOOPS_TEMPLATE_WELCOME:      'Loops welcome email template',
  LOOPS_TEMPLATE_TRIAL_ENDING: 'Loops trial-ending email template',
  LOOPS_TEMPLATE_ACTIVATED:    'Loops activation email template',
  LOOPS_TEMPLATE_PAYMENT_FAILED: 'Loops payment-failed email template',
  LOOPS_TEMPLATE_CANCELLED:    'Loops cancellation email template',
  LOOPS_TEMPLATE_DAILY_DIGEST: 'Loops daily-digest email template',
};

for (const [key, description] of Object.entries(REQUIRED)) {
  const val = process.env[key];
  if (!val) {
    fail(`${key}`, `Missing — ${description}`);
  } else if (val.startsWith('REPLACE_') || val === 'change-me-to-a-random-32-char-string') {
    fail(`${key}`, `Still set to placeholder value`);
  } else {
    pass(key);
  }
}

console.log('\n── Optional variables ─────────────────────────────────────────');

for (const [key, description] of Object.entries(OPTIONAL)) {
  const val = process.env[key];
  if (!val) {
    warn(key, `Not set — ${description}`);
  } else {
    pass(key);
  }
}

// ── 2. Sanity-check specific values ──────────────────────────────────────────

console.log('\n── Value checks ───────────────────────────────────────────────');

const appUrl = process.env.APP_URL ?? '';
if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1')) {
  fail('APP_URL', `Points to localhost — Twilio webhooks won't work in production`);
} else if (appUrl.startsWith('https://')) {
  pass('APP_URL is HTTPS');
} else if (appUrl) {
  warn('APP_URL', 'Not HTTPS — Twilio requires HTTPS for webhooks');
}

const cronSecret = process.env.CRON_SECRET ?? '';
if (cronSecret.length < 16) {
  fail('CRON_SECRET', 'Too short — use at least 16 random characters');
} else {
  pass('CRON_SECRET length');
}

const stripeKey = process.env.STRIPE_SECRET_KEY ?? '';
if (stripeKey.startsWith('sk_test_')) {
  warn('STRIPE_SECRET_KEY', 'Using test mode key — switch to sk_live_ for production');
} else if (stripeKey.startsWith('sk_live_')) {
  pass('STRIPE_SECRET_KEY is live mode');
}

// ── 3. Database connectivity ──────────────────────────────────────────────────

console.log('\n── Database ───────────────────────────────────────────────────');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (supabaseUrl && serviceKey) {
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    const start = Date.now();
    const { error } = await supabase
      .from('business_owners')
      .select('id', { count: 'exact', head: true });

    const ms = Date.now() - start;

    if (error) {
      fail('Database connection', error.message);
    } else {
      pass('Database connection', `${ms}ms`);
    }
  } catch (err) {
    fail('Database connection', String(err));
  }

  // Verify stripe_events table exists (migration 010)
  try {
    const { error } = await supabase
      .from('stripe_events')
      .select('id', { count: 'exact', head: true });
    if (error) {
      fail('stripe_events table', `Missing — run migration 010: ${error.message}`);
    } else {
      pass('stripe_events table');
    }
  } catch (err) {
    fail('stripe_events table', String(err));
  }
} else {
  warn('Database check', 'Skipped — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log('\n───────────────────────────────────────────────────────────────\n');

if (hasErrors) {
  console.error('❌  Pre-deploy check FAILED — fix the errors above before deploying.\n');
  process.exit(1);
} else {
  console.log('✅  All checks passed — ready to deploy.\n');
  process.exit(0);
}
