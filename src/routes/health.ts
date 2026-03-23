import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();
const startedAt = Date.now();

/**
 * GET /health
 *
 * Returns a structured health payload that Railway, UptimeRobot, and the
 * pre-deploy script can all consume.
 *
 * Response shape:
 * {
 *   status: 'ok' | 'degraded',
 *   uptime_s: number,
 *   version: string,          // from package.json
 *   checks: {
 *     database: { status: 'ok' | 'fail', latency_ms: number, error?: string },
 *     environment: { status: 'ok' | 'fail', missing?: string[] }
 *   }
 * }
 *
 * HTTP 200 → ok
 * HTTP 503 → degraded (at least one check failed)
 */
router.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, unknown> = {};

  // ── 1. Database ────────────────────────────────────────────────────────────
  const dbStart = Date.now();
  try {
    // Cheapest possible round-trip: count 0 rows from a known table
    const { error } = await supabaseAdmin
      .from('business_owners')
      .select('id', { count: 'exact', head: true });

    const latency = Date.now() - dbStart;

    if (error) {
      checks.database = { status: 'fail', latency_ms: latency, error: error.message };
    } else {
      checks.database = { status: 'ok', latency_ms: latency };
    }
  } catch (err) {
    checks.database = {
      status: 'fail',
      latency_ms: Date.now() - dbStart,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }

  // ── 2. Required environment variables ─────────────────────────────────────
  const requiredEnvVars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'LOOPS_API_KEY',
    'CRON_SECRET',
    'APP_URL',
  ];

  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  checks.environment = missing.length === 0
    ? { status: 'ok' }
    : { status: 'fail', missing };

  // ── 3. Twilio webhook configuration ───────────────────────────────────────
  // A lightweight (no API call) check: verify the SID is stored and APP_URL
  // looks like a real public URL, not localhost.
  const twilioSid = process.env.TWILIO_PHONE_SID ?? '';
  const appUrl = process.env.APP_URL ?? '';
  const isLocalhost = !appUrl || appUrl.includes('localhost') || appUrl.includes('127.0.0.1');

  if (!twilioSid) {
    checks.webhooks = {
      status: 'warn',
      detail: 'TWILIO_PHONE_SID not set — run `npm run setup-webhooks` after deploy',
    };
  } else if (isLocalhost) {
    checks.webhooks = {
      status: 'warn',
      detail: 'APP_URL is localhost — webhooks will not receive Twilio callbacks',
    };
  } else {
    checks.webhooks = {
      status: 'ok',
      sms_url: `${appUrl}/webhooks/sms`,
      voice_url: `${appUrl}/webhooks/voice`,
    };
  }

  // ── Overall status ─────────────────────────────────────────────────────────
  const allOk = Object.values(checks).every(
    (c) => {
      const s = (c as { status: string }).status;
      return s === 'ok' || s === 'warn'; // warn = advisory, not blocking
    }
  );

  const payload = {
    status: allOk ? 'ok' : 'degraded',
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.npm_package_version ?? 'unknown',
    checks,
  };

  res.status(allOk ? 200 : 503).json(payload);
});

export default router;
