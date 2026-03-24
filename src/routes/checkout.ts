import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireAuth } from '../middleware/auth';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2025-02-24.acacia',
});

/**
 * POST /checkout/create-session
 *
 * Creates a Stripe Checkout session for a business owner.
 * Called from the dashboard when an owner wants to subscribe
 * (either upgrading from trial, or after trial expiry).
 *
 * Body: { plan: 'monthly' | 'annual' }
 *
 * Returns: { url: string } — the Stripe-hosted checkout URL to redirect to.
 *
 * On success, Stripe fires checkout.session.completed which triggers
 * the Stripe webhook → subscription activated + Loops welcome email.
 */
router.post('/create-session', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const { plan } = req.body as { plan?: 'monthly' | 'annual' };

  if (!plan || !['monthly', 'annual'].includes(plan)) {
    res.status(400).json({ error: 'plan must be "monthly" or "annual"' });
    return;
  }

  const priceId =
    plan === 'monthly'
      ? process.env.STRIPE_PRICE_ID_MONTHLY
      : process.env.STRIPE_PRICE_ID_ANNUAL;

  if (!priceId) {
    res.status(500).json({ error: `STRIPE_PRICE_ID_${plan.toUpperCase()} not configured` });
    return;
  }

  const frontendUrl = process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'http://localhost:3001';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: owner.stripe_customer_id ? undefined : owner.email,
    customer: owner.stripe_customer_id ?? undefined,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${frontendUrl}/dashboard?upgraded=true`,
    cancel_url: `${frontendUrl}/dashboard?upgrade_cancelled=true`,
    subscription_data: {
      metadata: {
        owner_id: owner.id,
        business_name: owner.business_name,
      },
      trial_end: owner.trial_ends_at
        ? Math.floor(new Date(owner.trial_ends_at).getTime() / 1000)
        : undefined,
    },
    metadata: {
      owner_id: owner.id,
    },
  });

  res.json({ url: session.url });
});

/**
 * POST /checkout/portal
 *
 * Creates a Stripe Billing Portal session — lets owners manage their
 * subscription (cancel, update payment method, view invoices).
 *
 * Requires the owner to already have a Stripe customer ID.
 */
router.post('/portal', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;

  if (!owner.stripe_customer_id) {
    res.status(400).json({ error: 'No Stripe customer found. Subscribe first.' });
    return;
  }

  const frontendUrl = process.env.FRONTEND_URL ?? process.env.APP_URL ?? 'http://localhost:3001';

  const session = await stripe.billingPortal.sessions.create({
    customer: owner.stripe_customer_id,
    return_url: `${frontendUrl}/settings`,
  });

  res.json({ url: session.url });
});

export default router;
