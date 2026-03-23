import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /dashboard/summary
 *
 * Returns a summary of activity for the authenticated owner's dashboard:
 * - Total customers
 * - Jobs: booked / in-progress / completed this month
 * - Messages: sent / received this month
 * - Estimates: sent / accepted / pending
 * - Recent messages (last 10)
 */
router.get('/summary', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const ownerId = owner.id;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  const [
    { count: totalCustomers },
    { count: jobsBooked },
    { count: jobsCompleted },
    { count: messagesSent },
    { count: messagesReceived },
    { count: estimatesSent },
    { count: estimatesAccepted },
    { data: recentMessages },
  ] = await Promise.all([
    supabaseAdmin
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId),
    supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('status', 'booked'),
    supabaseAdmin
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('status', 'completed')
      .gte('completed_at', monthStartIso),
    supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('direction', 'outbound')
      .gte('created_at', monthStartIso),
    supabaseAdmin
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('direction', 'inbound')
      .gte('created_at', monthStartIso),
    supabaseAdmin
      .from('estimates')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('status', 'sent'),
    supabaseAdmin
      .from('estimates')
      .select('*', { count: 'exact', head: true })
      .eq('owner_id', ownerId)
      .eq('status', 'accepted')
      .gte('created_at', monthStartIso),
    supabaseAdmin
      .from('messages')
      .select('*, customers(name, phone)')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  res.json({
    owner: {
      id: owner.id,
      business_name: owner.business_name,
      twilio_number: owner.twilio_number,
      subscription_status: owner.subscription_status,
      trial_ends_at: owner.trial_ends_at,
    },
    stats: {
      total_customers: totalCustomers ?? 0,
      jobs_booked: jobsBooked ?? 0,
      jobs_completed_this_month: jobsCompleted ?? 0,
      messages_sent_this_month: messagesSent ?? 0,
      messages_received_this_month: messagesReceived ?? 0,
      estimates_pending: estimatesSent ?? 0,
      estimates_accepted_this_month: estimatesAccepted ?? 0,
    },
    recent_messages: recentMessages ?? [],
  });
});

/**
 * GET /dashboard/activity
 *
 * Returns the last 30 events across jobs, estimates, and inbound messages —
 * merged and sorted chronologically. Used for the activity feed on the dashboard.
 *
 * Each event has: { type, label, sub, created_at, href }
 */
router.get('/activity', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const ownerId = owner.id;
  const limit = 10; // per entity type

  const [
    { data: recentJobs },
    { data: recentEstimates },
    { data: recentInbound },
    { data: recentCompleted },
    { data: recentAccepted },
  ] = await Promise.all([
    // Jobs created
    supabaseAdmin
      .from('jobs')
      .select('id, description, status, scheduled_at, created_at, customers(name, phone)')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(limit),

    // Estimates sent
    supabaseAdmin
      .from('estimates')
      .select('id, description, amount_pence, status, created_at, customers(name, phone)')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false })
      .limit(limit),

    // Inbound messages
    supabaseAdmin
      .from('messages')
      .select('id, body, created_at, customers(name, phone)')
      .eq('owner_id', ownerId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(limit),

    // Jobs completed
    supabaseAdmin
      .from('jobs')
      .select('id, description, created_at, completed_at, customers(name, phone)')
      .eq('owner_id', ownerId)
      .eq('status', 'completed')
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(limit),

    // Estimates accepted
    supabaseAdmin
      .from('estimates')
      .select('id, description, amount_pence, created_at, updated_at, customers(name, phone)')
      .eq('owner_id', ownerId)
      .eq('status', 'accepted')
      .order('updated_at', { ascending: false })
      .limit(limit),
  ]);

  type ActivityItem = {
    type: string;
    icon: string;
    label: string;
    sub: string;
    created_at: string;
    href: string;
  };

  function customerName(c: unknown): string {
    if (!c || typeof c !== 'object') return 'Unknown';
    const cust = c as Record<string, string | null>;
    return cust.name ?? cust.phone ?? 'Unknown';
  }

  function pence(p: number): string {
    return `£${(p / 100).toFixed(0)}`;
  }

  const items: ActivityItem[] = [
    ...(recentJobs ?? []).map((j) => ({
      type: 'job_created',
      icon: '🔧',
      label: `New job booked`,
      sub: `${customerName(j.customers)} — ${j.description ?? 'no description'}`,
      created_at: j.created_at as string,
      href: '/jobs',
    })),
    ...(recentCompleted ?? []).map((j) => ({
      type: 'job_completed',
      icon: '✅',
      label: `Job completed`,
      sub: `${customerName(j.customers)} — ${j.description ?? ''}`,
      created_at: (j.completed_at ?? j.created_at) as string,
      href: '/jobs',
    })),
    ...(recentEstimates ?? []).map((e) => ({
      type: 'estimate_sent',
      icon: '£',
      label: `Estimate sent`,
      sub: `${customerName(e.customers)} — ${e.description} (${pence(e.amount_pence as number)})`,
      created_at: e.created_at as string,
      href: '/estimates',
    })),
    ...(recentAccepted ?? []).map((e) => ({
      type: 'estimate_accepted',
      icon: '🎉',
      label: `Estimate accepted`,
      sub: `${customerName(e.customers)} — ${e.description} (${pence(e.amount_pence as number)})`,
      created_at: (e.updated_at ?? e.created_at) as string,
      href: '/estimates',
    })),
    ...(recentInbound ?? []).map((m) => ({
      type: 'message_received',
      icon: '💬',
      label: `Message from ${customerName(m.customers)}`,
      sub: (m.body as string).slice(0, 80),
      created_at: m.created_at as string,
      href: '/messages',
    })),
  ];

  // Sort newest first, return top 20
  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json({ activity: items.slice(0, 20) });
});

export default router;
