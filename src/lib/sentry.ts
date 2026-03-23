import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { logger } from './logger';

/**
 * Initialise Sentry. Safe to call even when SENTRY_DSN is absent — Sentry
 * simply becomes a no-op, so the rest of the codebase never needs to guard.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info('Sentry disabled (no SENTRY_DSN)');
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    integrations: [nodeProfilingIntegration()],
    // Capture 100 % of transactions in dev, 10 % in production.
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  });

  logger.info('Sentry initialised');
}

/**
 * Report an error (or plain message) with optional extra context.
 * Returns the Sentry event ID so callers can include it in error responses.
 */
export function captureError(
  err: unknown,
  context?: Record<string, unknown>,
): string | undefined {
  return Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    return Sentry.captureException(err);
  });
}

export { Sentry };
