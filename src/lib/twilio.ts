import twilio from 'twilio';
import { supabaseAdmin } from './supabase';
import { SubscriptionStatus } from '../types';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  throw new Error('Missing Twilio env vars. Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN');
}

export const twilioClient = twilio(accountSid, authToken);

/** Maximum SMS per calendar month for trial accounts. */
export const TRIAL_SMS_LIMIT = 50;

/**
 * Check whether an owner is allowed to send another SMS.
 * Returns { allowed: true } or { allowed: false, reason }.
 *
 * Side-effect: resets sms_count_this_month when a new calendar month has started.
 */
export async function checkSmsAllowance(ownerId: string): Promise<
  { allowed: true } | { allowed: false; reason: string }
> {
  const { data: owner, error } = await supabaseAdmin
    .from('business_owners')
    .select('subscription_status, sms_count_this_month, sms_month_reset_at')
    .eq('id', ownerId)
    .single();

  if (error || !owner) return { allowed: false, reason: 'Owner not found' };

  const status = owner.subscription_status as SubscriptionStatus;

  // Active / past_due paid accounts have no cap
  if (status === 'active' || status === 'past_due') return { allowed: true };

  // Reset counter if we've rolled into a new calendar month
  const resetAt = new Date(owner.sms_month_reset_at);
  const now = new Date();
  const isNewMonth =
    now.getFullYear() !== resetAt.getFullYear() ||
    now.getMonth() !== resetAt.getMonth();

  if (isNewMonth) {
    await supabaseAdmin
      .from('business_owners')
      .update({
        sms_count_this_month: 0,
        sms_month_reset_at: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      })
      .eq('id', ownerId);
    return { allowed: true }; // fresh month
  }

  if (owner.sms_count_this_month >= TRIAL_SMS_LIMIT) {
    return {
      allowed: false,
      reason: `Trial SMS limit reached (${TRIAL_SMS_LIMIT}/month). Upgrade to continue sending.`,
    };
  }

  return { allowed: true };
}

/**
 * Increment the owner's monthly SMS counter by 1.
 * Called after a message is successfully sent.
 */
export async function incrementSmsCount(ownerId: string): Promise<void> {
  await supabaseAdmin.rpc('increment_sms_count', { owner_id_input: ownerId });
}

/**
 * Send an SMS from a business owner's dedicated Twilio number.
 * Returns the Twilio MessageSid on success.
 */
export async function sendSms(params: {
  to: string;
  from: string;
  body: string;
}): Promise<string> {
  const message = await twilioClient.messages.create({
    to: params.to,
    from: params.from,
    body: params.body,
  });
  return message.sid;
}

/**
 * Provision a new phone number for a business owner.
 * Searches for a local UK mobile number, purchases it, and configures
 * the SMS and voice webhooks to point at this app.
 */
export async function provisionNumber(params: {
  appUrl: string;
  areaCode?: number;
}): Promise<string> {
  const { appUrl, areaCode } = params;

  const available = await twilioClient
    .availablePhoneNumbers('GB')
    .local.list({ limit: 1, areaCode });

  if (available.length === 0) {
    throw new Error('No available UK phone numbers found');
  }

  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber: available[0].phoneNumber,
    smsUrl: `${appUrl}/webhook/sms/inbound`,
    smsMethod: 'POST',
    voiceUrl: `${appUrl}/webhook/call/missed`,
    voiceMethod: 'POST',
  });

  return purchased.phoneNumber;
}
