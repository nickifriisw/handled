import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { validateTwilioWebhook } from '../../middleware/twilio-validate';
import { InboundSmsWebhook } from '../../types';

const router = Router();

/**
 * POST /webhook/sms/inbound
 *
 * Receives inbound SMS from customers.
 * - Finds the owner by the 'To' number
 * - Upserts the customer
 * - Stores the message
 * - Handles STOP/START opt-out keywords
 * - Returns empty TwiML (we don't auto-reply to inbound; owner replies via dashboard)
 */
router.post('/', validateTwilioWebhook, async (req: Request, res: Response) => {
  const body = req.body as InboundSmsWebhook;
  const { From: fromPhone, To: toNumber, Body: messageBody, MessageSid } = body;

  // 1. Find owner by their Twilio number
  const { data: owner } = await supabaseAdmin
    .from('business_owners')
    .select('id')
    .eq('twilio_number', toNumber)
    .single();

  if (!owner) {
    console.warn('[sms/inbound] No owner for number', toNumber);
    res.type('text/xml').send('<Response></Response>');
    return;
  }

  // 2. Handle opt-out keywords (STOP, UNSTOP, START, HELP)
  const keyword = messageBody.trim().toUpperCase();
  if (['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) {
    await supabaseAdmin
      .from('customers')
      .update({ opted_out: true })
      .eq('owner_id', owner.id)
      .eq('phone', fromPhone);
    res.type('text/xml').send('<Response></Response>');
    return;
  }
  if (['START', 'UNSTOP', 'YES'].includes(keyword)) {
    await supabaseAdmin
      .from('customers')
      .update({ opted_out: false })
      .eq('owner_id', owner.id)
      .eq('phone', fromPhone);
  }

  // 3. Upsert customer
  const { data: customer } = await supabaseAdmin
    .from('customers')
    .upsert(
      { owner_id: owner.id, phone: fromPhone },
      { onConflict: 'owner_id,phone', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (!customer) {
    res.type('text/xml').send('<Response></Response>');
    return;
  }

  // 4. Store message
  await supabaseAdmin.from('messages').insert({
    owner_id: owner.id,
    customer_id: customer.id,
    direction: 'inbound',
    body: messageBody,
    twilio_sid: MessageSid,
    status: 'delivered',
    automation_type: null,
  });

  // Return empty TwiML — no auto-reply
  res.type('text/xml').send('<Response></Response>');
});

export default router;
