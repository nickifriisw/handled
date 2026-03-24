import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { supabaseAdmin } from '../../lib/supabase';
import {
  sendWelcomeEmail,
  sendSubscriptionActivatedEmail,
  sendPaymentFailedEmail,
  sendPaymentReceivedEmail,
  sendCancellationEmail,
} from '../../lib/loops';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2025-02-24.acacia',
});

/**
 * POST /webhook/stripe
 *
 * Handles subscription lifecycle events from Stripe.
 * IMPORTANT: This route must receive the raw request body (Buffer)
 * so Stripe can verify the webhook signature.
 * In src/index.ts, register this route BEFORE the JSON body parser.
 *
 * Events handled:
 *   checkout.session.completed        → provision the owner
 *   customer.subscription.updated     → sync subscription status
 *   customer.subscription.deleted     → mark as canceled
 *   invoice.payment_failed            → mark as past_due + email
 *   invoice.payment_succeeded         → ensure status is active
 */
router.post(
  '/',
  express_raw_body_middleware(), // see note below
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'] as string | undefined;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

    if (!sig) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
    } catch (err) {
      console.error('[stripe] Webhook signature verification failed:', err);
      res.status(400).json({ error: 'Webhook signature invalid' });
      return;
    }

    console.log(`[stripe] Event: ${event.type} (${event.id})`);

    // ── Idempotency check ──────────────────────────────────────────────────
    // Insert the event ID — if it already exists, we've already processed it.
    const { error: insertErr } = await supabaseAdmin
      .from('stripe_events')
      .insert({ id: event.id, type: event.type });

    if (insertErr) {
      if (insertErr.code === '23505') {
        // Unique violation = duplicate delivery → ack and skip
        console.log(`[stripe] Duplicate event ${event.id} — skipping`);
        res.json({ received: true, duplicate: true });
        return;
      }
      console.error('[stripe] Failed to record event:', insertErr);
      // Continue processing anyway — idempotency is best-effort
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;

        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;

        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;

        case 'invoice.payment_succeeded':
          await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
          break;

        default:
          // Ignore unhandled event types
          break;
      }
    } catch (err) {
      console.error(`[stripe] Error handling ${event.type}:`, err);
      // Return 500 so Stripe retries
      res.status(500).json({ error: 'Handler error' });
      return;
    }

    // Mark event as fully processed
    await supabaseAdmin
      .from('stripe_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', event.id);

    res.json({ received: true });
  }
);

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  // Retrieve the full subscription to get metadata
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerObj = await stripe.customers.retrieve(customerId);

  if (customerObj.deleted) return;

  const email = customerObj.email ?? '';
  const name = (customerObj.name ?? '') as string;

  // Update business_owners row with Stripe IDs + activate subscription
  const { data: owner } = await supabaseAdmin
    .from('business_owners')
    .update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      subscription_status: 'active',
      trial_ends_at: null,
    })
    .eq('email', email)
    .select()
    .single();

  if (!owner) {
    console.warn('[stripe] No owner found for email:', email);
    return;
  }

  // Send activation email
  await sendSubscriptionActivatedEmail({
    email,
    fullName: name,
    businessName: owner.business_name,
  });

  console.log(`[stripe] Activated subscription for owner ${owner.id}`);
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  const customerId = subscription.customer as string;

  const statusMap: Record<string, string> = {
    active: 'active',
    trialing: 'trialing',
    past_due: 'past_due',
    canceled: 'canceled',
    unpaid: 'past_due',
    incomplete: 'past_due',
    incomplete_expired: 'canceled',
    paused: 'past_due',
  };

  const newStatus = statusMap[subscription.status] ?? 'past_due';

  await supabaseAdmin
    .from('business_owners')
    .update({
      subscription_status: newStatus,
      stripe_subscription_id: subscription.id,
    })
    .eq('stripe_customer_id', customerId);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const customerId = subscription.customer as string;

  const { data: owner } = await supabaseAdmin
    .from('business_owners')
    .update({ subscription_status: 'canceled' })
    .eq('stripe_customer_id', customerId)
    .select()
    .single();

  if (!owner) return;

  await sendCancellationEmail({
    email: owner.email,
    fullName: owner.full_name,
    businessName: owner.business_name,
  });
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  const { data: owner } = await supabaseAdmin
    .from('business_owners')
    .update({ subscription_status: 'past_due' })
    .eq('stripe_customer_id', customerId)
    .select()
    .single();

  if (!owner) return;

  await sendPaymentFailedEmail({ email: owner.email, fullName: owner.full_name });
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;

  // Only update if currently past_due — don't overwrite 'trialing'
  await supabaseAdmin
    .from('business_owners')
    .update({ subscription_status: 'active' })
    .eq('stripe_customer_id', customerId)
    .eq('subscription_status', 'past_due');


  // Send payment confirmation email
  const { data: owner } = await supabaseAdmin
    .from('business_owners')
    .select('email, full_name, business_name')
    .eq('stripe_customer_id', customerId)
    .single();

  if (owner) {
    const amountPaid = invoice.amount_paid ?? 0;
    const currency = (invoice.currency ?? 'gbp').toUpperCase();
    const amountFormatted = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amountPaid / 100);
    await sendPaymentReceivedEmail({ email: owner.email, fullName: owner.full_name, businessName: owner.business_name, amountFormatted });
  }
}

// ─── Raw body middleware ───────────────────────────────────────────────────────
/**
 * Stripe signature verification requires the raw request body as a Buffer.
 * We apply express.raw() only to this route, BEFORE express.json() processes it.
 *
 * In src/index.ts, register the Stripe webhook route BEFORE express.json():
 *   app.use('/webhook/stripe', express.raw({ type: 'application/json' }), stripeRouter);
 */
function express_raw_body_middleware() {
  // This is a no-op placeholder — the actual raw body handling is done
  // in src/index.ts by passing express.raw({ type: 'application/json' })
  // as middleware before this router. See index.ts for the correct wiring.
  return (_req: Request, _res: Response, next: () => void) => next();
}

export default router;
