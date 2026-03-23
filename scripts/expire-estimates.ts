/**
 * Estimate expiry job.
 *
 * Marks estimates as 'expired' when they have been in 'sent' status for
 * longer than EXPIRY_DAYS (default 30) without being accepted or declined.
 *
 * Run via Railway cron: 0 3 * * *  (3am daily)
 * Or manually: npx tsx scripts/expire-estimates.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const EXPIRY_DAYS = Number(process.env.ESTIMATE_EXPIRY_DAYS ?? 30);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - EXPIRY_DAYS);

  console.log(`[expire-estimates] Expiring estimates sent before ${cutoff.toISOString()}`);

  // Fetch all estimates that should be expired
  const { data: toExpire, error: fetchErr } = await supabase
    .from('estimates')
    .select('id, owner_id')
    .eq('status', 'sent')
    .lt('sent_at', cutoff.toISOString());

  if (fetchErr) {
    console.error('[expire-estimates] Failed to fetch estimates:', fetchErr.message);
    process.exit(1);
  }

  if (!toExpire || toExpire.length === 0) {
    console.log('[expire-estimates] No estimates to expire.');
    return;
  }

  console.log(`[expire-estimates] Expiring ${toExpire.length} estimate(s)…`);

  const ids = toExpire.map((e) => e.id);

  const { error: updateErr } = await supabase
    .from('estimates')
    .update({ status: 'expired' })
    .in('id', ids);

  if (updateErr) {
    console.error('[expire-estimates] Failed to update estimates:', updateErr.message);
    process.exit(1);
  }

  console.log(`[expire-estimates] ✓ Expired ${ids.length} estimate(s).`);
}

main().catch((err) => {
  console.error('[expire-estimates] Unexpected error:', err);
  process.exit(1);
});
