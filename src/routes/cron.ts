import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { sendSms, checkSmsAllowance, incrementSmsCount } from '../lib/twilio';
import { logger } from '../lib/logger';
import { captureError } from '../lib/sentry';

const router = Router();

/**
 * Exponential back-off delay for retry attempts.
 * Attempt 1 → +5 min, attempt 2 → +15 min, attempt 3 → +45 min.
 */
function backoffMinutes(attempt: number): number {
  return 5 * Math.pow(3, attempt - 1); // 5, 15, 45
}

/**
 * POST /cron/process-scheduled
 *
 * Processes all pending scheduled_messages where send_at <= now().
 * Called every minute by Railway's cron or an external cron service.
 *
 * Retry behaviour:
 *   - On Twilio failure the row stays 'pending', retry_count increments, and
 *     send_at is pushed forward by exponential back-off (5 / 15 / 45 min).
 *   - After max_retries attempts the row is permanently marked 'failed'.
 *
 * Protected by a shared secret in the Authorization header:
 *   Authorization: Bearer <CRON_SECRET>
 */
router.post('/process-scheduled', async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const log = logger.child({ handler: 'cron/process-scheduled' });
  const now = new Date().toISOString();

  const { data: due, error } = await supabaseAdmin
    .from('scheduled_messages')
    .select('*, business_owners(twilio_number), customers(phone, opted_out)')
    .eq('status', 'pending')
    .lte('send_at', now)
    .limit(100);

  if (error || !due) {
    log.error('Failed to fetch scheduled messages', { error });
    res.status(500).json({ error: 'DB error' });
    return;
  }

  let sent = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;

  for (const msg of due) {
    const twilioNumber = msg.business_owners?.twilio_number;
    const customerPhone = msg.customers?.phone;
    const optedOut = msg.customers?.opted_out;

    // ── Missing config — fail immediately, no retry ───────────────────────
    if (!twilioNumber || !customerPhone) {
      await supabaseAdmin
        .from('scheduled_messages')
        .update({ status: 'failed', last_error: 'Missing twilio_number or customer phone' })
        .eq('id', msg.id);
      log.warn('Scheduled message missing phone/number — marked failed', { id: msg.id });
      failed++;
      continue;
    }

    // ── Customer opted out — cancel silently ─────────────────────────────
    if (optedOut) {
      await supabaseAdmin
        .from('scheduled_messages')
        .update({ status: 'cancelled' })
        .eq('id', msg.id);
      skipped++;
      continue;
    }

    // ── Attempt send ──────────────────────────────────────────────────────
    try {
      const sid = await sendSms({ to: customerPhone, from: twilioNumber, body: msg.body });

      await supabaseAdmin.from('messages').insert({
        owner_id: msg.owner_id,
        customer_id: msg.customer_id,
        direction: 'outbound',
        body: msg.body,
        twilio_sid: sid,
        status: 'sent',
        automation_type: msg.automation_type,
      });

      await supabaseAdmin
        .from('scheduled_messages')
        .update({ status: 'sent' })
        .eq('id', msg.id);

      await incrementSmsCount(msg.owner_id);
      sent++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const nextRetry = (msg.retry_count ?? 0) + 1;
      const maxRetries = msg.max_retries ?? 3;

      if (nextRetry >= maxRetries) {
        // Exhausted retries — permanently fail
        await supabaseAdmin
          .from('scheduled_messages')
          .update({ status: 'failed', retry_count: nextRetry, last_error: errMsg })
          .eq('id', msg.id);
        log.error('Scheduled message permanently failed after max retries', {
          id: msg.id,
          retry_count: nextRetry,
          error: errMsg,
        });
        captureError(err, { scheduled_message_id: msg.id, retry_count: nextRetry });
        failed++;
      } else {
        // Schedule a retry with exponential back-off
        const delayMs = backoffMinutes(nextRetry) * 60 * 1000;
        const nextSendAt = new Date(Date.now() + delayMs).toISOString();

        await supabaseAdmin
          .from('scheduled_messages')
          .update({ retry_count: nextRetry, send_at: nextSendAt, last_error: errMsg })
          .eq('id', msg.id);

        log.warn('Scheduled message failed — will retry', {
          id: msg.id,
          retry_count: nextRetry,
          next_send_at: nextSendAt,
          error: errMsg,
        });
        retried++;
      }
    }
  }

  log.info('Cron tick complete', { processed: due.length, sent, retried, failed, skipped });
  res.json({ processed: due.length, sent, retried, failed, skipped });
});

/**
 * POST /cron/expire-estimates
 *
 * Marks estimates as 'expired' when they've been in 'sent' status for
 * longer than ESTIMATE_EXPIRY_DAYS (default 30).
 *
 * Schedule: daily at 3am  →  0 3 * * *
 */
router.post('/expire-estimates', async (req: Request, res: Response) => {
  const log = logger.child({ handler: 'cron/expire-estimates' });
  const expiryDays = Number(process.env.ESTIMATE_EXPIRY_DAYS ?? 30);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - expiryDays);

  const { data: toExpire, error: fetchErr } = await supabaseAdmin
    .from('estimates')
    .select('id')
    .eq('status', 'sent')
    .lt('sent_at', cutoff.toISOString());

  if (fetchErr) {
    log.error('expire-estimates: fetch error', { message: fetchErr.message });
    res.status(500).json({ error: 'Failed to fetch estimates' });
    return;
  }

  if (!toExpire || toExpire.length === 0) {
    res.json({ expired: 0 });
    return;
  }

  const ids = toExpire.map((e: { id: string }) => e.id);

  const { error: updateErr } = await supabaseAdmin
    .from('estimates')
    .update({ status: 'expired' })
    .in('id', ids);

  if (updateErr) {
    log.error('expire-estimates: update error', { message: updateErr.message });
    res.status(500).json({ error: 'Failed to expire estimates' });
    return;
  }

  log.info('expire-estimates: done', { expired: ids.length, cutoff: cutoff.toISOString() });
  res.json({ expired: ids.length });
});

/**
 * POST /cron/reset-sms-counts
 *
 * Resets sms_count_this_month to 0 for all owners at the start of each month.
 * Schedule: 0 0 1 * *  (midnight on the 1st)
 *
 * The lazy-reset in twilio.ts handles the common case, but this ensures
 * all counts are clean for reporting and edge-case accuracy.
 */
router.post('/reset-sms-counts', async (req: Request, res: Response) => {
  const log = logger.child({ handler: 'cron/reset-sms-counts' });

  const now = new Date().toISOString();

  const { error, count } = await supabaseAdmin
    .from('business_owners')
    .update({
      sms_count_this_month: 0,
      sms_month_reset_at: now,
    })
    .gt('sms_count_this_month', 0); // only touch rows that actually need resetting

  if (error) {
    log.error('reset-sms-counts: update error', { message: error.message });
    res.status(500).json({ error: 'Failed to reset SMS counts' });
    return;
  }

  log.info('reset-sms-counts: done', { reset: count ?? 0 });
  res.json({ reset: count ?? 0 });
});

export default router;
