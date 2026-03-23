import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { sendSms } from '../lib/twilio';

const router = Router();

/**
 * GET /messages
 * Returns all messages for the authenticated owner, paginated.
 * Optional query params: ?customer_id=&limit=50&offset=0
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const customerId = req.query.customer_id as string | undefined;

  let query = supabaseAdmin
    .from('messages')
    .select('*, customers(id, phone, name)', { count: 'exact' })
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (customerId) {
    query = query.eq('customer_id', customerId);
  }

  const { data: messages, error, count } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
    return;
  }

  res.json({ messages, total: count, limit, offset });
});

/**
 * POST /messages/send
 * Send a manual (non-automated) outbound SMS to a customer.
 */
router.post('/send', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const { customer_id, body } = req.body as { customer_id: string; body: string };

  if (!customer_id || !body?.trim()) {
    res.status(400).json({ error: 'customer_id and body are required' });
    return;
  }

  if (!owner.twilio_number) {
    res.status(400).json({ error: 'No Twilio number provisioned for this account' });
    return;
  }

  // Verify customer belongs to owner
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('id', customer_id)
    .eq('owner_id', owner.id)
    .single();

  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  if (customer.opted_out) {
    res.status(400).json({ error: 'Customer has opted out of messages' });
    return;
  }

  const sid = await sendSms({ to: customer.phone, from: owner.twilio_number, body });

  const { data: message } = await supabaseAdmin
    .from('messages')
    .insert({
      owner_id: owner.id,
      customer_id: customer.id,
      direction: 'outbound',
      body,
      twilio_sid: sid,
      status: 'sent',
      automation_type: null,
    })
    .select()
    .single();

  res.status(201).json({ message });
});

export default router;
