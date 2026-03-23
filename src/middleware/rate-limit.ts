import { Request, Response, NextFunction } from 'express';

/**
 * Simple in-memory rate limiter — no Redis needed for v0.1.
 *
 * Resets every `windowMs` milliseconds per IP.
 * For Railway (single instance), this works fine.
 * For multi-instance deploys, swap the Map for a Redis store.
 */

interface RateLimitStore {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitStore>();

// Clean up expired entries every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 5 * 60 * 1000);

function getIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function createLimiter(options: { windowMs: number; max: number; message?: string }) {
  const { windowMs, max, message = 'Too many requests' } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getIp(req);
    const key = `${req.path}:${ip}`;
    const now = Date.now();

    const entry = store.get(key);

    if (!entry || entry.resetAt < now) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({ error: message, retryAfter });
      return;
    }

    next();
  };
}

/**
 * Tight limit for Twilio/Stripe webhooks — prevents webhook flooding.
 * 120 requests per minute per IP (2/sec average, 4x normal volume).
 */
export const webhookRateLimit = createLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'Webhook rate limit exceeded',
});

/**
 * API rate limit for authenticated endpoints.
 * 300 requests per minute per IP — generous for a dashboard.
 */
export const apiRateLimit = createLimiter({
  windowMs: 60_000,
  max: 300,
  message: 'API rate limit exceeded',
});

/**
 * Tight limit for the cron endpoint — should only be called once per minute.
 * Extra requests likely indicate misconfiguration.
 */
export const cronRateLimit = createLimiter({
  windowMs: 60_000,
  max: 5,
  message: 'Cron endpoint called too frequently',
});

/**
 * Public estimate acceptance endpoints — unauthenticated, so tighter limit.
 * 30 requests per 15 minutes per IP — enough for a customer to load +
 * accept/decline their estimate, but blocks scrapers and brute-force attempts.
 */
export const publicRateLimit = createLimiter({
  windowMs: 15 * 60_000,
  max: 30,
  message: 'Too many requests — please try again shortly',
});
