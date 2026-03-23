import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /queue
 * Returns upcoming and recently-failed scheduled messages for the owner.
 *
 * Query params:
 *   ?status=pending|failed|all  (default: all)
 *   ?limit=50
 *
 * Ordered by send_at ascending so the owner sees what fires next.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  const statusFilter = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('scheduled_messages')
    .select('*, customers(id, name, phone)', { count: 'exact' })
    .eq('owner_id', owner.id)
    .order('send_at', { ascending: true })
    .limit(limit);

  if (statusFilter && statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  } else {
    // Default: show pending + failed (not sent/cancelled — those are historical noise)
    query = query.in('status', ['pending', 'failed']);
  }

  const { data: messages, error, count } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch queue' });
    return;
  }

  res.json({ messages: messages ?? [], total: count });
});

/**
 * DELETE /queue/:id
 * Cancel a specific scheduled message (sets status = 'cancelled').
 * Owners can cancel pending automations before they fire.
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const id = req.params.id as string;

  const { data, error } = await supabaseAdmin
    .from('scheduled_messages')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('owner_id', owner.id)
    .eq('status', 'pending') // only cancel pending ones
    .select()
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Scheduled message not found or already sent' });
    return;
  }

  res.json({ message: data });
});

export default router;
