/**
 * scripts/daily-digest.ts
 *
 * Sends a daily activity summary email to every active/trialing owner who
 * had any activity in the past 24 hours.
 *
 * Designed to run once per day at 08:00 UTC via Railway cron:
 *   0 8 * * *   npx tsx scripts/daily-digest.ts
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOOPS_API_KEY
 */

import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOOPS_API_KEY = process.env.LOOPS_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !LOOPS_API_KEY) {
  console.error('❌  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and LOOPS_API_KEY are required');
  process.exit(1);
}

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Loops transactional template ID for daily digest ─────────────────────────
// Create a transactional email in Loops, copy its ID here.
const LOOPS_TEMPLATE_ID = process.env.LOOPS_TEMPLATE_DAILY_DIGEST ?? '';
if (!LOOPS_TEMPLATE_ID) {
  console.warn('[daily-digest] LOOPS_TEMPLATE_DAILY_DIGEST not set — emails will be skipped');
}

interface DigestStats {
  jobs_created: number;
  jobs_completed: number;
  estimates_sent: number;
  estimates_accepted: number;
  sms_sent: number;
  new_customers: number;
}

async function getDigestStats(ownerId: string, since: string): Promise<DigestStats> {
  const [jobs, estimates, messages, customers] = await Promise.all([
    supabase
      .from('jobs')
      .select('status')
      .eq('owner_id', ownerId)
      .gte('created_at', since),

    supabase
      .from('estimates')
      .select('status, created_at')
      .eq('owner_id', ownerId)
      .gte('created_at', since),

    supabase
      .from('messages')
      .select('direction')
      .eq('owner_id', ownerId)
      .eq('direction', 'outbound')
      .gte('created_at', since),

    supabase
      .from('customers')
      .select('id')
      .eq('owner_id', ownerId)
      .gte('created_at', since),
  ]);

  const jobRows      = jobs.data ?? [];
  const estimateRows = estimates.data ?? [];

  return {
    jobs_created:        jobRows.length,
    jobs_completed:      jobRows.filter((j) => j.status === 'completed').length,
    estimates_sent:      estimateRows.length,
    estimates_accepted:  estimateRows.filter((e) => e.status === 'accepted').length,
    sms_sent:            messages.data?.length ?? 0,
    new_customers:       customers.data?.length ?? 0,
  };
}

async function sendDigestEmail(params: {
  email: string;
  businessName: string;
  stats: DigestStats;
  date: string;
}): Promise<void> {
  if (!LOOPS_TEMPLATE_ID) return; // silently skip if template not configured
  const res = await fetch('https://app.loops.so/api/v1/transactional', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LOOPS_API_KEY}`,
    },
    body: JSON.stringify({
      transactionalId: LOOPS_TEMPLATE_ID,
      email: params.email,
      dataVariables: {
        business_name:       params.businessName,
        date:                params.date,
        jobs_created:        params.stats.jobs_created,
        jobs_completed:      params.stats.jobs_completed,
        estimates_sent:      params.stats.estimates_sent,
        estimates_accepted:  params.stats.estimates_accepted,
        sms_sent:            params.stats.sms_sent,
        new_customers:       params.stats.new_customers,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Loops error ${res.status}: ${body}`);
  }
}

async function run(): Promise<void> {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const dateLabel = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  console.log(`\n📬  HANDLED daily digest — ${dateLabel}`);

  // Fetch all active/trialing owners
  const { data: owners, error } = await supabase
    .from('business_owners')
    .select('id, email, business_name, subscription_status')
    .in('subscription_status', ['active', 'trialing']);

  if (error || !owners) {
    console.error('Failed to fetch owners:', error);
    process.exit(1);
  }

  console.log(`    Processing ${owners.length} owner(s)…\n`);

  let sent = 0;
  let skipped = 0;

  for (const owner of owners) {
    const stats = await getDigestStats(owner.id, yesterday);
    const totalActivity =
      stats.jobs_created + stats.estimates_sent + stats.sms_sent + stats.new_customers;

    // Only send if there was actual activity — no point in empty digests
    if (totalActivity === 0) {
      skipped++;
      continue;
    }

    try {
      await sendDigestEmail({
        email: owner.email,
        businessName: owner.business_name,
        stats,
        date: dateLabel,
      });
      console.log(`  ✓ ${owner.email} — ${stats.jobs_created} jobs, ${stats.sms_sent} SMS, ${stats.new_customers} new customers`);
      sent++;
    } catch (err) {
      console.error(`  ✗ ${owner.email}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n✅  Done — sent: ${sent}, skipped (no activity): ${skipped}\n`);
}

run().catch((err) => {
  console.error('Daily digest failed:', err);
  process.exit(1);
});
