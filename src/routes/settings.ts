import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { TRIAL_SMS_LIMIT } from '../lib/twilio';

const router = Router();

const updateSettingsSchema = z.object({
  full_name: z.string().min(1).optional(),
  business_name: z.string().min(1).optional(),
  trade_type: z.string().min(1).optional(),
  google_review_link: z.string().url().nullable().optional(),
  timezone: z.string().min(1).optional(),
  owner_mobile: z.string().min(7).nullable().optional(),
});

function safeOwner(owner: Record<string, unknown>) {
  return {
    id: owner.id,
    email: owner.email,
    full_name: owner.full_name,
    business_name: owner.business_name,
    trade_type: owner.trade_type,
    twilio_number: owner.twilio_number,
    owner_mobile: owner.owner_mobile ?? null,
    google_review_link: owner.google_review_link,
    subscription_status: owner.subscription_status,
    trial_ends_at: owner.trial_ends_at,
    timezone: owner.timezone,
    // Usage stats — shown on the settings page for trial accounts
    sms_count_this_month: owner.sms_count_this_month ?? 0,
    sms_limit: owner.subscription_status === 'trialing' ? TRIAL_SMS_LIMIT : null,
  };
}

/**
 * GET /settings
 * Returns the authenticated owner's profile including SMS usage stats.
 */
router.get('/', requireAuth, (req: Request, res: Response) => {
  res.json(safeOwner(req.owner! as unknown as Record<string, unknown>));
});

/**
 * PATCH /settings
 * Update editable profile fields.
 */
router.patch('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const owner = req.owner!;

  const { data: updated, error } = await supabaseAdmin
    .from('business_owners')
    .update(parsed.data)
    .eq('id', owner.id)
    .select()
    .single();

  if (error || !updated) {
    res.status(500).json({ error: 'Failed to update settings' });
    return;
  }

  res.json(safeOwner(updated as unknown as Record<string, unknown>));
});

export default router;
