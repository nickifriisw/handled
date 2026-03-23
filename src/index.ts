// ─── Env validation — must be first ──────────────────────────────────────────
// Crashes immediately with a clear error if any required env var is missing.
// Remove this import to skip validation (e.g. in unit tests).
import './lib/env';

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

// Sentry — initialise before everything else so it can capture startup errors
import { initSentry, Sentry } from './lib/sentry';
initSentry();

// Routes
import smsWebhookRouter from './routes/webhooks/sms';
import statusWebhookRouter from './routes/webhooks/status';
import callWebhookRouter from './routes/webhooks/call';
import stripeWebhookRouter from './routes/webhooks/stripe';
import jobsRouter from './routes/jobs';
import estimatesRouter from './routes/estimates';
import messagesRouter from './routes/messages';
import customersRouter from './routes/customers';
import automationsRouter from './routes/automations';
import cronRouter from './routes/cron';
import onboardingRouter from './routes/onboarding';
import dashboardRouter from './routes/dashboard';
import checkoutRouter from './routes/checkout';
import settingsRouter from './routes/settings';
import analyticsRouter from './routes/analytics';
import searchRouter from './routes/search';
import queueRouter from './routes/queue';
import publicRouter from './routes/public';
import { webhookRateLimit, apiRateLimit, cronRateLimit, publicRateLimit } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { logger } from './lib/logger';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ─── Trust proxy (required for correct req.protocol behind Railway) ───────────
app.set('trust proxy', 1);

// ─── Sentry request handler — must be first middleware ───────────────────────
app.use(Sentry.expressErrorHandler());

// ─── Request ID — assigned before any other middleware ───────────────────────
app.use(requestId);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? [process.env.APP_URL ?? '', 'https://handled.framer.site']
        : '*',
    credentials: true,
  })
);

// ─── Health check (no body parser needed) ────────────────────────────────────
import healthRouter from './routes/health';
app.use('/health', healthRouter);

// ─── Stripe webhook — MUST be before express.json() ──────────────────────────
app.use(
  '/webhook/stripe',
  webhookRateLimit,
  express.raw({ type: 'application/json' }),
  stripeWebhookRouter
);

// ─── Twilio webhooks — urlencoded body + rate limit ──────────────────────────
app.use('/webhook/sms/inbound', webhookRateLimit, express.urlencoded({ extended: false }), smsWebhookRouter);
app.use('/webhook/sms/status',  webhookRateLimit, express.urlencoded({ extended: false }), statusWebhookRouter);
app.use('/webhook/call/missed', webhookRateLimit, express.urlencoded({ extended: false }), callWebhookRouter);

// ─── JSON body parser for all remaining routes ───────────────────────────────
app.use(express.json());

// ─── API routes (JWT-authenticated, rate limited) ────────────────────────────
app.use(apiRateLimit);
app.use('/jobs', jobsRouter);
app.use('/estimates', estimatesRouter);
app.use('/messages', messagesRouter);
app.use('/customers', customersRouter);
app.use('/automations', automationsRouter);
app.use('/dashboard', dashboardRouter);
app.use('/checkout', checkoutRouter);
app.use('/settings', settingsRouter);
app.use('/analytics', analyticsRouter);
app.use('/search', searchRouter);
app.use('/queue', apiRateLimit, queueRouter);

// ── Public (no auth) ──────────────────────────────────────────────────────────
// Customer-facing estimate acceptance — must be after express.json() but
// has no requireAuth middleware so customers can access without an account.
app.use('/e', publicRateLimit, publicRouter);

// ─── Internal routes (CRON_SECRET-protected) ─────────────────────────────────
app.use('/cron', cronRateLimit, cronRouter);
app.use('/onboarding', onboardingRouter);

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', request_id: req.id });
});

// ─── Sentry error handler — captures unhandled errors ────────────────────────
// Must be after routes, before the generic error handler.
app.use(Sentry.expressErrorHandler());

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', request_id: (req as express.Request & { id?: string }).id });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`HANDLED API running on port ${PORT}`, { env: process.env.NODE_ENV ?? 'development' });
});

export default app;
