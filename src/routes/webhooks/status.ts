import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../../lib/supabase';
import { validateTwilioWebhook } from '../../middleware/twilio-validate';

const router = Router();

/**
 * POST /webhook/sms/status
 *
 * Receives delivery status callbacks from Twilio.
 * Updates the message status in the database.
 *
 * Twilio sends: MessageSid, MessageStatus (queued/sent/delivered/failed/undelivered)
 */
router.post('/', validateTwilioWebhook, async (req: Request, res: Response) => {
  const { MessageSid, MessageStatus } = req.body as {
    MessageSid: string;
    MessageStatus: string;
  };

  if (!MessageSid || !MessageStatus) {
    res.sendStatus(400);
    return;
  }

  // Map Twilio statuses to our enum
  const statusMap: Record<string, string> = {
    queued: 'queued',
    sending: 'queued',
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'failed',
    failed: 'failed',
  };

  const mappedStatus = statusMap[MessageStatus] ?? 'queued';

  await supabaseAdmin
    .from('messages')
    .update({ status: mappedStatus })
    .eq('twilio_sid', MessageSid);

  res.sendStatus(204);
});

export default router;
