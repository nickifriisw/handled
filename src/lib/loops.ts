/**
 * Loops.so transactional email client.
 *
 * Template IDs are read from environment variables so you never need to
 * touch source code after creating templates in the Loops dashboard.
 *
 * Required env vars (add to .env / Railway):
 *   LOOPS_API_KEY
 *   LOOPS_TEMPLATE_WELCOME          — sent on trial start
 *   LOOPS_TEMPLATE_TRIAL_ENDING     — sent ~3 days before trial expires
 *   LOOPS_TEMPLATE_ACTIVATED        — sent when subscription goes active
 *   LOOPS_TEMPLATE_PAYMENT_FAILED   — sent on invoice.payment_failed
 *   LOOPS_TEMPLATE_CANCELLED        — sent on subscription.deleted
 *   LOOPS_TEMPLATE_DAILY_DIGEST     — sent by scripts/daily-digest.ts
 *
 * How to get a template ID:
 *   Loops dashboard → Transactional → create template → copy the ID from the URL
 *   e.g. https://app.loops.so/transactional/edit/clxxxxxxxxxx  →  clxxxxxxxxxx
 *
 * All email functions are no-ops when:
 *   - LOOPS_API_KEY is not set (logs a warning)
 *   - The specific template env var is not set (logs a warning, skips silently)
 */

const LOOPS_API_URL = 'https://app.loops.so/api/v1/transactional';

function templateId(envVar: string): string | null {
  const val = process.env[envVar];
  if (!val || val.startsWith('REPLACE_')) {
    console.warn(`[loops] ${envVar} not configured — skipping email`);
    return null;
  }
  return val;
}

async function sendTransactional(params: {
  transactionalId: string;
  email: string;
  dataVariables?: Record<string, string | number>;
}): Promise<void> {
  const apiKey = process.env.LOOPS_API_KEY;
  if (!apiKey) {
    console.warn('[loops] LOOPS_API_KEY not set — skipping email');
    return;
  }

  const res = await fetch(LOOPS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transactionalId: params.transactionalId,
      email: params.email,
      dataVariables: params.dataVariables ?? {},
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[loops] Failed to send ${params.transactionalId}:`, res.status, body);
  }
}

// ─── Email events ─────────────────────────────────────────────────────────────

export async function sendWelcomeEmail(params: {
  email: string;
  fullName: string;
  businessName: string;
  twilioNumber: string;
  trialEndsAt: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_WELCOME');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:      params.fullName,
      business_name:  params.businessName,
      twilio_number:  params.twilioNumber,
      trial_ends_at:  params.trialEndsAt,
    },
  });
}

export async function sendTrialEndingEmail(params: {
  email: string;
  fullName: string;
  businessName: string;
  trialEndsAt: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_TRIAL_ENDING');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:      params.fullName,
      business_name:  params.businessName,
      trial_ends_at:  params.trialEndsAt,
    },
  });
}

export async function sendSubscriptionActivatedEmail(params: {
  email: string;
  fullName: string;
  businessName: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_ACTIVATED');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:     params.fullName,
      business_name: params.businessName,
    },
  });
}

export async function sendPaymentFailedEmail(params: {
  email: string;
  fullName: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_PAYMENT_FAILED');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name: params.fullName,
    },
  });
}

export async function sendCancellationEmail(params: {
  email: string;
  fullName: string;
  businessName: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_CANCELLED');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:     params.fullName,
      business_name: params.businessName,
    },
  });
}

export async function sendPaymentReceivedEmail(params: {
  email: string;
  fullName: string;
  businessName: string;
  amountFormatted: string;
}): Promise<void> {
  const id = templateId("LOOPS_TEMPLATE_PAYMENT_RECEIVED");
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:        params.fullName,
      business_name:    params.businessName,
      amount_formatted: params.amountFormatted,
    },
  });
}

/**
 * sendInboundMessageNotification
 *
 * Sent to the business owner whenever a customer replies to an SMS.
 * Requires LOOPS_TEMPLATE_INBOUND_MESSAGE to be set.
 *
 * Template variables:
 *   full_name, business_name, customer_name, customer_phone, message_preview
 */
export async function sendInboundMessageNotification(params: {
  email: string;
  fullName: string;
  businessName: string;
  customerName: string;
  customerPhone: string;
  messagePreview: string;
}): Promise<void> {
  const id = templateId('LOOPS_TEMPLATE_INBOUND_MESSAGE');
  if (!id) return;
  await sendTransactional({
    transactionalId: id,
    email: params.email,
    dataVariables: {
      full_name:        params.fullName,
      business_name:    params.businessName,
      customer_name:    params.customerName,
      customer_phone:   params.customerPhone,
      message_preview:  params.messagePreview,
    },
  });
}
