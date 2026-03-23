/**
 * Trial reminder script.
 *
 * Sends a "your trial ends in 3 days" email via Loops to every owner
 * whose trial expires in exactly 3 days (i.e. on day 11 of a 14-day trial).
 *
 * Designed to be called daily by a Railway cron job:
 *   Schedule: 0 9 * * *   (9am UTC every day)
 *   Command:  npx tsx scripts/trial-reminders.ts
 *
 * Or add a dedicated endpoint and call it from the cron service.
 *
 * Safe to run multiple times — only emails owners whose trial_ends_at
 * falls in a 24-hour window starting from now+3days.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { sendTrialEndingEmail } from '../src/lib/loops';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  console.log('⏰ Running trial reminder check…\n');

  const now = new Date();

  // Window: owners whose trial ends between now+3days and now+4days
  const windowStart = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

  const { data: owners, error } = await supabase
    .from('business_owners')
    .select('id, email, full_name, business_name, trial_ends_at')
    .eq('subscription_status', 'trialing')
    .gte('trial_ends_at', windowStart.toISOString())
    .lt('trial_ends_at', windowEnd.toISOString());

  if (error) {
    console.error('DB error:', error.message);
    process.exit(1);
  }

  if (!owners || owners.length === 0) {
    console.log('No trials ending in 3 days — nothing to send.');
    return;
  }

  console.log(`Sending ${owners.length} reminder email(s)…\n`);

  let sent = 0;
  let failed = 0;

  for (const owner of owners) {
    try {
      await sendTrialEndingEmail({
        email: owner.email,
        fullName: owner.full_name,
        businessName: owner.business_name,
        trialEndsAt: new Date(owner.trial_ends_at).toLocaleDateString('en-GB', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        }),
      });
      console.log(`  ✓ ${owner.email} (${owner.business_name})`);
      sent++;
    } catch (err) {
      console.error(`  ✗ ${owner.email} — ${String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone. Sent: ${sent}  Failed: ${failed}`);
}

main().catch((err) => {
  console.error('Trial reminders script failed:', err);
  process.exit(1);
});
