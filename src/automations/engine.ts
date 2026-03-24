import { supabaseAdmin } from '../lib/supabase';
import { sendSms, checkSmsAllowance, incrementSmsCount } from '../lib/twilio';
import { personalizeMessage } from '../lib/claude';
import { logger } from '../lib/logger';
import { AutomationType, Automation, BusinessOwner, Customer } from '../types';

/**
 * Core automation engine.
 *
 * Each automation handler calls scheduleMessage() or fireNow() depending
 * on whether the message should go immediately or after a delay.
 */

interface FireParams {
  owner: BusinessOwner;
  customer: Customer;
  automationType: AutomationType;
  variables: Record<string, string>;
  delayMinutes?: number;
  jobId?: string;
  estimateId?: string;
  /** Override the stored template (e.g. when a required variable like google_review_link is missing) */
  templateOverride?: string;
}

/**
 * Look up the automation config for an owner + type.
 * Returns null if the automation is disabled or not found.
 */
export async function getAutomation(
  ownerId: string,
  type: AutomationType
): Promise<Automation | null> {
  const { data, error } = await supabaseAdmin
    .from('automations')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('type', type)
    .eq('enabled', true)
    .single();

  if (error || !data) return null;
  return data as Automation;
}

/**
 * Fire an automation immediately (delay_minutes = 0) or
 * schedule it for later (delay_minutes > 0).
 */
export async function fireAutomation(params: FireParams): Promise<void> {
  const { owner, customer, automationType, variables, jobId, estimateId, templateOverride } = params;

  const log = logger.child({ owner_id: owner.id, customer_id: customer.id, automation: automationType });

  if (customer.opted_out) {
    log.info('skipping — customer opted out');
    return;
  }

  const automation = await getAutomation(owner.id, automationType);
  if (!automation) {
    log.info('skipping — automation disabled or not found');
    return;
  }

  const delay = params.delayMinutes ?? automation.delay_minutes;

  const allVars = {
    business_name: owner.business_name,
    owner_name: owner.full_name,
    customer_name: customer.name ?? 'there',
    google_review_link: owner.google_review_link ?? '',
    ...variables,
  };

  const body = await personalizeMessage({
    template: templateOverride ?? automation.template,
    variables: allVars,
  });

  if (delay === 0) {
    // Check SMS cap before immediate sends
    const allowance = await checkSmsAllowance(owner.id);
    if (!allowance.allowed) {
      log.warn('SMS cap reached — skipping immediate send', { reason: allowance.reason });
      return;
    }
    log.info('firing immediately');
    await sendNow({ owner, customer, body, automationType });
  } else {
    log.info('scheduling', { delay_minutes: delay });
    await scheduleMessage({
      owner,
      customer,
      body,
      automationType,
      delayMinutes: delay,
      jobId,
      estimateId,
    });
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function sendNow(params: {
  owner: BusinessOwner;
  customer: Customer;
  body: string;
  automationType: AutomationType;
}): Promise<void> {
  const { owner, customer, body, automationType } = params;

  if (!owner.twilio_number) {
    logger.error('no twilio_number on owner — cannot send', { owner_id: owner.id });
    return;
  }

  const sid = await sendSms({ to: customer.phone, from: owner.twilio_number, body });
  logger.info('sms sent', { sid, automation_type: automationType, to: customer.phone });

  await supabaseAdmin.from('messages').insert({
    owner_id: owner.id,
    customer_id: customer.id,
    direction: 'outbound',
    body,
    twilio_sid: sid,
    status: 'sent',
    automation_type: automationType,
  });

  // Increment monthly counter (non-blocking)
  incrementSmsCount(owner.id).catch(() => { /* best-effort */ });
}

async function scheduleMessage(params: {
  owner: BusinessOwner;
  customer: Customer;
  body: string;
  automationType: AutomationType;
  delayMinutes: number;
  jobId?: string;
  estimateId?: string;
}): Promise<void> {
  const { owner, customer, body, automationType, delayMinutes, jobId, estimateId } = params;
  const sendAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

  await supabaseAdmin.from('scheduled_messages').insert({
    owner_id: owner.id,
    customer_id: customer.id,
    body,
    send_at: sendAt,
    status: 'pending',
    automation_type: automationType,
    job_id: jobId ?? null,
    estimate_id: estimateId ?? null,
  });
}
