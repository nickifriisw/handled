/**
 * Validates all required environment variables at startup using Zod.
 *
 * Import this module FIRST in src/index.ts so a missing variable crashes
 * immediately with a clear error — not midway through a request.
 *
 * Usage:
 *   import { env } from './lib/env';
 *   env.TWILIO_ACCOUNT_SID  // fully typed
 */

import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().startsWith('AC'),
  TWILIO_AUTH_TOKEN: z.string().min(10),
  TWILIO_FROM_NUMBER: z.string().startsWith('+'),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  STRIPE_PRICE_ID_MONTHLY: z.string().startsWith('price_'),
  STRIPE_PRICE_ID_ANNUAL: z.string().startsWith('price_'),

  // Loops
  LOOPS_API_KEY: z.string().min(1),

  // App
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().url(),
  CRON_SECRET: z.string().min(16),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => `  ✗ ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `\n\n🚨 HANDLED: Missing or invalid environment variables:\n${missing}\n\nSee .env.example for reference.\n`
    );
  }

  return result.data;
}

export const env = validateEnv();
export type Env = typeof env;
