import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';

const authToken = process.env.TWILIO_AUTH_TOKEN ?? '';

/**
 * Validates that incoming webhook requests genuinely come from Twilio
 * by checking the X-Twilio-Signature header.
 *
 * IMPORTANT: Express must be configured with app.set('trust proxy', 1)
 * when deployed behind Railway / a reverse proxy, so req.protocol is correct.
 *
 * In development (NODE_ENV !== 'production') validation is skipped so you
 * can test with curl / ngrok without needing a valid signature.
 */
export function validateTwilioWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (process.env.NODE_ENV !== 'production') {
    next();
    return;
  }

  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) {
    res.status(403).json({ error: 'Missing Twilio signature' });
    return;
  }

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  const valid = twilio.validateRequest(authToken, signature, url, params);
  if (!valid) {
    res.status(403).json({ error: 'Invalid Twilio signature' });
    return;
  }

  next();
}
