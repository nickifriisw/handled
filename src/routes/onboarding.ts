import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { provisionNumber } from '../lib/twilio';
import { AutomationType } from '../types';
import { requireJwt } from '../middleware/auth';

const router = Router();

const DEFAULT_TEMPLATES: Record<AutomationType, { template: string; delay_minutes: number }> = {
  [AutomationType.MissedCall]: {
    template:
      "Hi {{customer_name}}, sorry I missed your call! I'm {{owner_name}} from {{business_name}}. I'll call you back shortly — or reply here if easier.",
    delay_minutes: 0,
  },
  [AutomationType.BookingConfirmation]: {
    template:
      'Hi {{customer_name}}, your booking with {{business_name}} is confirmed for {{scheduled_date}} at {{scheduled_time}}. Address: {{address}}. Any questions? Just reply here.',
    delay_minutes: 0,
  },
  [AutomationType.OnMyWay]: {
    template:
      "Hi {{customer_name}}, {{owner_name}} from {{business_name}} here — I'm on my way to you now! Should be there in about {{eta_minutes}} mins.",
    delay_minutes: 0,
  },
  [AutomationType.JobComplete]: {
    template:
      'Hi {{customer_name}}, great to see you today! Thanks for using {{business_name}}. If you\'re happy with the work, a quick Google review would mean the world: {{google_review_link}}',
    delay_minutes: 60,
  },
  [AutomationType.EstimateFollowUp]: {
    template:
      "Hi {{customer_name}}, just following up on the quote I sent for {{description}} (£{{amount}}). Let me know if you have any questions — happy to chat!",
    delay_minutes: 0, // delay controlled per-schedule (days 2/5/10)
  },
  [AutomationType.ReferralAsk]: {
    template:
      'Hi {{customer_name}}, hope everything is still working great! If you know anyone who needs a {{trade_type}}, I\'d really appreciate the recommendation. Thanks again — {{owner_name}}',
    delay_minutes: 4320, // 3 days
  },
};

const provisionSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email(),
  full_name: z.string().min(1),
  business_name: z.string().min(1),
  trade_type: z.string().min(1),
  google_review_link: z.string().url().optional(),
  timezone: z.string().default('Europe/London'),
});

/**
 * POST /onboarding/provision
 *
 * Called after Stripe checkout completes (via Stripe webhook) OR
 * directly from the dashboard after trial signup.
 *
 * 1. Creates/upserts the business_owners row
 * 2. Provisions a Twilio number
 * 3. Seeds default automation templates
 *
 * Protected by service-role / internal usage — not exposed to browser directly.
 * In production, call this from the Stripe webhook handler.
 */
router.post('/provision', async (req: Request, res: Response) => {
  // Internal endpoint — validate via cron secret or service-role header
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = provisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { user_id, email, full_name, business_name, trade_type, google_review_link, timezone } =
    parsed.data;

  try {
    // 1. Upsert business owner
    const { data: owner, error: ownerErr } = await supabaseAdmin
      .from('business_owners')
      .upsert(
        {
          id: user_id,
          email,
          full_name,
          business_name,
          trade_type,
          google_review_link: google_review_link ?? null,
          timezone,
          subscription_status: 'trialing',
          trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: 'id' }
      )
      .select()
      .single();

    if (ownerErr || !owner) {
      throw new Error(`Failed to upsert business owner: ${ownerErr?.message}`);
    }

    // 2. Provision Twilio number (only if not already provisioned)
    if (!owner.twilio_number) {
      const appUrl = process.env.APP_URL ?? 'https://handled.railway.app';
      const twilioNumber = await provisionNumber({ appUrl });

      await supabaseAdmin
        .from('business_owners')
        .update({ twilio_number: twilioNumber })
        .eq('id', owner.id);

      owner.twilio_number = twilioNumber;
    }

    // 3. Seed default automations (skip if already exist)
    const automationRows = Object.entries(DEFAULT_TEMPLATES).map(([type, config]) => ({
      owner_id: owner.id,
      type,
      enabled: true,
      template: config.template,
      delay_minutes: config.delay_minutes,
    }));

    await supabaseAdmin
      .from('automations')
      .upsert(automationRows, { onConflict: 'owner_id,type', ignoreDuplicates: true });

    res.status(201).json({
      owner_id: owner.id,
      twilio_number: owner.twilio_number,
      message: 'Provisioning complete',
    });
  } catch (err) {
    console.error('[onboarding] provision error:', err);
    res.status(500).json({ error: String(err) });
  }
});

const selfProvisionSchema = z.object({
  full_name: z.string().min(1),
  business_name: z.string().min(1),
  trade_type: z.string().min(1),
  google_review_link: z.string().url().optional(),
  timezone: z.string().default('Europe/London'),
});

/**
 * POST /onboarding/self-provision
 *
 * Called from the browser after Supabase email confirmation.
 * Uses the user's own JWT (requireAuth) so no cron secret is needed.
 *
 * Idempotent — safe to call multiple times; upserts on conflict.
 * If the owner row already exists (e.g. Stripe webhook already provisioned),
 * this is a no-op and returns the existing row.
 */
router.post('/self-provision', requireJwt, async (req: Request, res: Response) => {
  // requireAuth attaches req.owner if the row exists — but for new users it
  // won't, so we read the user_id directly from the verified JWT instead.
  const userId = req.user!.id;

  const parsed = selfProvisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { full_name, business_name, trade_type, google_review_link, timezone } = parsed.data;

  try {
    // 1. Upsert business owner (safe to call if row already exists)
    const { data: owner, error: ownerErr } = await supabaseAdmin
      .from('business_owners')
      .upsert(
        {
          id: userId,
          email: req.user!.email ?? '',
          full_name,
          business_name,
          trade_type,
          google_review_link: google_review_link ?? null,
          timezone,
          subscription_status: 'trialing',
          trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        },
        { onConflict: 'id', ignoreDuplicates: false }
      )
      .select()
      .single();

    if (ownerErr || !owner) {
      throw new Error(`Failed to upsert business owner: ${ownerErr?.message}`);
    }

    // 2. Provision Twilio number (only if not already provisioned)
    if (!owner.twilio_number) {
      const appUrl = process.env.APP_URL ?? 'https://handled.railway.app';
      try {
        const twilioNumber = await provisionNumber({ appUrl });
        await supabaseAdmin
          .from('business_owners')
          .update({ twilio_number: twilioNumber })
          .eq('id', owner.id);
        owner.twilio_number = twilioNumber;
      } catch (twilioErr) {
        // Non-fatal — owner can still use the app; Twilio number added later
        console.warn('[onboarding] Twilio provisioning failed:', twilioErr);
      }
    }

    // 3. Seed default automations (skip if already exist)
    const automationRows = Object.entries(DEFAULT_TEMPLATES).map(([type, config]) => ({
      owner_id: owner.id,
      type,
      enabled: true,
      template: config.template,
      delay_minutes: config.delay_minutes,
    }));

    await supabaseAdmin
      .from('automations')
      .upsert(automationRows, { onConflict: 'owner_id,type', ignoreDuplicates: true });

    res.status(201).json({
      owner_id: owner.id,
      twilio_number: owner.twilio_number,
      message: 'Provisioning complete',
    });
  } catch (err) {
    console.error('[onboarding] self-provision error:', err);
    res.status(500).json({ error: String(err) });
  }
});

export default router;
