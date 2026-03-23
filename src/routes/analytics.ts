import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /analytics?days=30
 *
 * Returns time-series and summary stats for the owner's dashboard charts.
 *
 * Response shape:
 * {
 *   period_days: number,
 *   jobs_by_day:     { date: string; count: number }[],
 *   messages_by_day: { date: string; count: number }[],
 *   estimates_summary: {
 *     total: number; accepted: number; declined: number; pending: number;
 *     conversion_rate: number;    // 0–100
 *   },
 *   revenue_pipeline: {
 *     accepted_pence: number;     // won
 *     pending_pence:  number;     // in-flight
 *   },
 *   top_stats: {
 *     total_customers: number;
 *     jobs_completed:  number;
 *     sms_sent:        number;
 *     avg_response_min: number | null;  // avg minutes from inbound → outbound reply
 *   }
 * }
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // ── Parallel queries ──────────────────────────────────────────────────────
  const [
    jobsResult,
    messagesResult,
    estimatesResult,
    customersResult,
  ] = await Promise.all([
    // All jobs in period
    supabaseAdmin
      .from('jobs')
      .select('created_at, status')
      .eq('owner_id', owner.id)
      .gte('created_at', since),

    // All outbound messages in period
    supabaseAdmin
      .from('messages')
      .select('created_at, direction')
      .eq('owner_id', owner.id)
      .eq('direction', 'outbound')
      .gte('created_at', since),

    // All estimates (no date filter — for conversion summary)
    supabaseAdmin
      .from('estimates')
      .select('status, amount_pence')
      .eq('owner_id', owner.id),

    // Total customers
    supabaseAdmin
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', owner.id),
  ]);

  // ── Build daily buckets ───────────────────────────────────────────────────
  const jobsByDay = buildDailyBuckets(jobsResult.data ?? [], days);
  const messagesByDay = buildDailyBuckets(messagesResult.data ?? [], days);

  // ── Estimates summary ─────────────────────────────────────────────────────
  const estimates = estimatesResult.data ?? [];
  const estTotal     = estimates.length;
  const estAccepted  = estimates.filter((e) => e.status === 'accepted').length;
  const estDeclined  = estimates.filter((e) => e.status === 'declined').length;
  const estPending   = estimates.filter((e) => e.status === 'pending').length;

  const acceptedPence = estimates
    .filter((e) => e.status === 'accepted')
    .reduce((sum, e) => sum + (e.amount_pence ?? 0), 0);

  const pendingPence = estimates
    .filter((e) => e.status === 'pending')
    .reduce((sum, e) => sum + (e.amount_pence ?? 0), 0);

  const conversionRate =
    estTotal > 0 ? Math.round((estAccepted / estTotal) * 100) : 0;

  // ── Top stats ─────────────────────────────────────────────────────────────
  const jobsCompleted = (jobsResult.data ?? []).filter(
    (j) => j.status === 'completed'
  ).length;

  res.json({
    period_days: days,
    jobs_by_day: jobsByDay,
    messages_by_day: messagesByDay,
    estimates_summary: {
      total: estTotal,
      accepted: estAccepted,
      declined: estDeclined,
      pending: estPending,
      conversion_rate: conversionRate,
    },
    revenue_pipeline: {
      accepted_pence: acceptedPence,
      pending_pence: pendingPence,
    },
    top_stats: {
      total_customers: customersResult.count ?? 0,
      jobs_completed: jobsCompleted,
      sms_sent: messagesResult.data?.length ?? 0,
    },
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Groups rows into daily buckets for the past N days, filling gaps with 0. */
function buildDailyBuckets(
  rows: { created_at: string }[],
  days: number
): { date: string; count: number }[] {
  // Build a map: YYYY-MM-DD → count
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const day = row.created_at.slice(0, 10); // ISO date
    counts[day] = (counts[day] ?? 0) + 1;
  }

  // Generate all days in range (oldest → newest)
  const result: { date: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: counts[key] ?? 0 });
  }

  return result;
}

export default router;
