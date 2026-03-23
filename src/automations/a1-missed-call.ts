import { supabaseAdmin } from '../lib/supabase';
import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner } from '../types';

/**
 * A1 — Missed Call
 *
 * Triggered when Twilio fires the voice webhook (call not answered).
 * Looks up the owner by their Twilio number, upserts the caller as a
 * customer, then fires the missed_call automation immediately (delay = 0).
 *
 * Default template:
 *   "Hi {{customer_name}}, sorry I missed your call! I'm {{owner_name}}
 *    from {{business_name}}. I'll call you back shortly — or reply here
 *    if easier."
 */
export async function handleMissedCall(params: {
  callerPhone: string;
  twilioNumber: string; // the number that was called (= owner's number)
}): Promise<void> {
  const { callerPhone, twilioNumber } = params;

  // 1. Find the owner by their Twilio number
  const { data: owner, error: ownerErr } = await supabaseAdmin
    .from('business_owners')
    .select('*')
    .eq('twilio_number', twilioNumber)
    .single();

  if (ownerErr || !owner) {
    console.error('[a1] No owner found for twilio_number', twilioNumber);
    return;
  }

  // 2. Upsert the caller as a customer
  const { data: customer, error: custErr } = await supabaseAdmin
    .from('customers')
    .upsert(
      { owner_id: owner.id, phone: callerPhone },
      { onConflict: 'owner_id,phone', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (custErr || !customer) {
    console.error('[a1] Failed to upsert customer', custErr);
    return;
  }

  // 3. Fire automation
  await fireAutomation({
    owner: owner as BusinessOwner,
    customer,
    automationType: AutomationType.MissedCall,
    variables: {},
  });
}
