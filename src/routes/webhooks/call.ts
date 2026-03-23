import { Router, Request, Response } from 'express';
import { validateTwilioWebhook } from '../../middleware/twilio-validate';
import { handleMissedCall } from '../../automations/a1-missed-call';
import { MissedCallWebhook } from '../../types';

const router = Router();

/**
 * POST /webhook/call/missed
 *
 * Twilio fires this when a voice call is not answered (no-answer, busy, failed).
 * We treat every inbound call that hits voicemail / rings out as a "missed call".
 *
 * TwiML response tells Twilio to hang up silently (no voicemail greeting).
 * The automation fires the missed-call SMS.
 */
router.post('/', validateTwilioWebhook, async (req: Request, res: Response) => {
  const { From: callerPhone, To: twilioNumber, CallStatus } = req.body as MissedCallWebhook & {
    CallStatus: string;
  };

  // Only act on statuses that mean the owner didn't pick up
  const missedStatuses = ['no-answer', 'busy', 'failed'];
  if (missedStatuses.includes(CallStatus)) {
    // Fire async — don't await so TwiML returns immediately
    handleMissedCall({ callerPhone, twilioNumber }).catch((err) =>
      console.error('[call/missed] handleMissedCall error:', err)
    );
  }

  // TwiML: hang up silently
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
});

export default router;
