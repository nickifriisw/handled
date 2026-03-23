import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { cancelEstimateFollowUps } from '../automations/a5-estimate-follow-up';
import { logger } from '../lib/logger';
import { sendSms } from '../lib/twilio';

const router = Router();

/**
 * Public estimate routes — no auth required.
 * Customers access these via the link in their estimate SMS.
 *
 * GET  /e/:token          → view estimate details
 * POST /e/:token/accept   → customer accepts
 * POST /e/:token/decline  → customer declines
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

interface PublicEstimate {
  id: string;
  public_token: string;
  status: string;
  description: string;
  amount_pence: number;
  sent_at: string | null;
  responded_at: string | null;
  business_name: string;
  owner_phone: string | null;
}

async function fetchByToken(token: string): Promise<PublicEstimate | null> {
  const { data, error } = await supabaseAdmin
    .from('estimates')
    .select(`
      id,
      public_token,
      status,
      description,
      amount_pence,
      sent_at,
      responded_at,
      business_owners (
        business_name,
        twilio_number
      )
    `)
    .eq('public_token', token)
    .single();

  if (error || !data) return null;

  const owner = Array.isArray(data.business_owners)
    ? data.business_owners[0]
    : data.business_owners;

  return {
    id: data.id as string,
    public_token: data.public_token as string,
    status: data.status as string,
    description: data.description as string,
    amount_pence: data.amount_pence as number,
    sent_at: data.sent_at as string | null,
    responded_at: data.responded_at as string | null,
    business_name: (owner as { business_name: string } | null)?.business_name ?? 'Your tradesperson',
    owner_phone: (owner as { twilio_number: string | null } | null)?.twilio_number ?? null,
  };
}

// ── Owner notification ────────────────────────────────────────────────────────

/**
 * Send the owner an SMS when a customer responds to their estimate.
 * Looks up the owner's personal mobile from business_owners.owner_mobile.
 * If not set, silently skips (don't fail the request over a notification).
 */
async function notifyOwner(
  estimate: PublicEstimate,
  action: 'accepted' | 'declined'
): Promise<void> {
  // Fetch owner's personal mobile number and twilio_number
  const { data: owner } = await supabaseAdmin
    .from('estimates')
    .select('business_owners(owner_mobile, twilio_number, business_name)')
    .eq('id', estimate.id)
    .single();

  const ownerRow = owner
    ? (Array.isArray(owner.business_owners) ? owner.business_owners[0] : owner.business_owners) as {
        owner_mobile: string | null;
        twilio_number: string | null;
        business_name: string;
      } | null
    : null;

  const ownerMobile = ownerRow?.owner_mobile ?? null;
  const twilioNumber = ownerRow?.twilio_number ?? null;

  if (!ownerMobile || !twilioNumber) return;

  const amount = `£${(estimate.amount_pence / 100).toFixed(2)}`;
  const emoji = action === 'accepted' ? '🎉' : '👋';
  const verb = action === 'accepted' ? 'accepted' : 'declined';

  const body =
    `${emoji} ${estimate.business_name}: A customer has ${verb} your estimate ` +
    `for "${estimate.description}" (${amount}).`;

  await sendSms({ to: ownerMobile, from: twilioNumber, body });
}

// ── GET /e/:token ─────────────────────────────────────────────────────────────

router.get('/:token', async (req: Request, res: Response) => {
  const token = req.params['token'] as string;
  const log = logger.child({ handler: 'public/estimate', token });

  const estimate = await fetchByToken(token);

  if (!estimate) {
    log.warn('Estimate not found for token');
    res.status(404).json({ error: 'Estimate not found' });
    return;
  }

  log.info('Public estimate viewed', { status: estimate.status });
  res.json({ estimate });
});

// ── POST /e/:token/accept ─────────────────────────────────────────────────────

router.post('/:token/accept', async (req: Request, res: Response) => {
  const token = req.params['token'] as string;
  const log = logger.child({ handler: 'public/estimate/accept', token });

  const estimate = await fetchByToken(token);

  if (!estimate) {
    res.status(404).json({ error: 'Estimate not found' });
    return;
  }

  if (estimate.status === 'accepted') {
    // Idempotent — already accepted
    res.json({ estimate, message: 'Already accepted' });
    return;
  }

  if (estimate.status === 'declined') {
    res.status(409).json({ error: 'Estimate has already been declined' });
    return;
  }

  if (estimate.status === 'expired') {
    res.status(410).json({ error: 'This estimate has expired' });
    return;
  }

  const { data: updated, error } = await supabaseAdmin
    .from('estimates')
    .update({
      status: 'accepted',
      responded_at: new Date().toISOString(),
    })
    .eq('id', estimate.id)
    .select()
    .single();

  if (error || !updated) {
    log.error('Failed to accept estimate', { error: error?.message });
    res.status(500).json({ error: 'Failed to accept estimate' });
    return;
  }

  // Cancel pending follow-up messages
  cancelEstimateFollowUps(estimate.id).catch((err) =>
    log.error('Failed to cancel follow-ups after accept', { err: String(err) })
  );

  // Notify the owner by SMS
  notifyOwner({ ...estimate, status: 'accepted' }, 'accepted').catch((err) =>
    log.error('Failed to notify owner after accept', { err: String(err) })
  );

  log.info('Estimate accepted via public link');
  res.json({ estimate: { ...estimate, status: 'accepted' } });
});

// ── POST /e/:token/decline ────────────────────────────────────────────────────

router.post('/:token/decline', async (req: Request, res: Response) => {
  const token = req.params['token'] as string;
  const log = logger.child({ handler: 'public/estimate/decline', token });

  const estimate = await fetchByToken(token);

  if (!estimate) {
    res.status(404).json({ error: 'Estimate not found' });
    return;
  }

  if (estimate.status === 'declined') {
    res.json({ estimate, message: 'Already declined' });
    return;
  }

  if (estimate.status === 'accepted') {
    res.status(409).json({ error: 'Estimate has already been accepted' });
    return;
  }

  if (estimate.status === 'expired') {
    res.status(410).json({ error: 'This estimate has expired' });
    return;
  }

  const { data: updated, error } = await supabaseAdmin
    .from('estimates')
    .update({
      status: 'declined',
      responded_at: new Date().toISOString(),
    })
    .eq('id', estimate.id)
    .select()
    .single();

  if (error || !updated) {
    log.error('Failed to decline estimate', { error: error?.message });
    res.status(500).json({ error: 'Failed to decline estimate' });
    return;
  }

  // Cancel pending follow-up messages
  cancelEstimateFollowUps(estimate.id).catch((err) =>
    log.error('Failed to cancel follow-ups after decline', { err: String(err) })
  );

  // Notify the owner by SMS
  notifyOwner({ ...estimate, status: 'declined' }, 'declined').catch((err) =>
    log.error('Failed to notify owner after decline', { err: String(err) })
  );

  log.info('Estimate declined via public link');
  res.json({ estimate: { ...estimate, status: 'declined' } });
});

export default router;
