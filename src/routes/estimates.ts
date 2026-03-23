import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { scheduleEstimateFollowUps, cancelEstimateFollowUps } from '../automations/a5-estimate-follow-up';
import { CreateEstimateBody, EstimateStatus } from '../types';
import { sendSms, checkSmsAllowance, incrementSmsCount } from '../lib/twilio';

const router = Router();

/**
 * GET /estimates
 * Returns all estimates for the owner, most recent first.
 * Optional query params: ?status=sent&limit=50&offset=0
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const status = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('estimates')
    .select('*, customers(id, phone, name)', { count: 'exact' })
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data: estimates, error, count } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch estimates' });
    return;
  }

  res.json({ estimates: estimates ?? [], total: count, limit, offset });
});

const createEstimateSchema = z.object({
  customer_phone: z.string().min(7),
  customer_name: z.string().optional(),
  amount_pence: z.number().int().positive(),
  description: z.string().min(1),
});

const updateEstimateSchema = z.object({
  status: z.nativeEnum(EstimateStatus).optional(),
  amount_pence: z.number().int().positive().optional(),
  description: z.string().optional(),
});

/**
 * POST /estimates
 * Create estimate + schedule 3 follow-up messages (days 2, 5, 10)
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createEstimateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const owner = req.owner!;
  const { customer_phone, customer_name, amount_pence, description } =
    parsed.data as CreateEstimateBody;

  const { data: customer, error: custErr } = await supabaseAdmin
    .from('customers')
    .upsert(
      { owner_id: owner.id, phone: customer_phone, name: customer_name ?? null },
      { onConflict: 'owner_id,phone', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (custErr || !customer) {
    res.status(500).json({ error: 'Failed to upsert customer' });
    return;
  }

  const { data: estimate, error: estErr } = await supabaseAdmin
    .from('estimates')
    .insert({
      owner_id: owner.id,
      customer_id: customer.id,
      amount_pence,
      description,
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (estErr || !estimate) {
    res.status(500).json({ error: 'Failed to create estimate' });
    return;
  }

  // Send initial estimate SMS to customer (includes accept/decline link)
  const appUrl = process.env.APP_URL ?? '';
  if (appUrl && owner.twilio_number) {
    const allowance = await checkSmsAllowance(owner.id);
    if (allowance.allowed) {
      const amountFormatted = (estimate.amount_pence / 100).toFixed(2);
      const acceptLink = `${appUrl}/e/${estimate.public_token}`;
      const smsBody =
        `Hi ${customer.name ?? 'there'}, ${owner.business_name} has sent you an estimate for ` +
        `${estimate.description}: £${amountFormatted}. ` +
        `View and accept here: ${acceptLink}`;

      sendSms({
        to: customer.phone,
        from: owner.twilio_number,
        body: smsBody,
      })
        .then(() => incrementSmsCount(owner.id))
        .catch(console.error);
    }
  }

  // Schedule follow-up sequence async
  scheduleEstimateFollowUps({ owner, customer, estimate }).catch(console.error);

  res.status(201).json({ estimate });
});

/**
 * PATCH /estimates/:id
 * Accept / decline — cancels pending follow-ups automatically
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateEstimateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const owner = req.owner!;
  const estimateId = req.params.id as string;

  const { data: existing } = await supabaseAdmin
    .from('estimates')
    .select('id')
    .eq('id', estimateId)
    .eq('owner_id', owner.id)
    .single();

  if (!existing) {
    res.status(404).json({ error: 'Estimate not found' });
    return;
  }

  const { data: estimate, error } = await supabaseAdmin
    .from('estimates')
    .update(parsed.data)
    .eq('id', estimateId)
    .select()
    .single();

  if (error || !estimate) {
    res.status(500).json({ error: 'Failed to update estimate' });
    return;
  }

  // Cancel pending follow-ups when accepted or declined
  if (
    parsed.data.status === EstimateStatus.Accepted ||
    parsed.data.status === EstimateStatus.Declined
  ) {
    cancelEstimateFollowUps(estimateId).catch(console.error);
  }

  res.json({ estimate });
});

export default router;
