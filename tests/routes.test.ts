/**
 * Route-level unit tests — pure business logic, no network calls.
 *
 * Tests the validation rules, status transitions, and data-shaping logic
 * that lives inside route handlers, extracted as pure functions here.
 */

// ─── Subscription status helpers ─────────────────────────────────────────────

type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

function isAccessAllowed(status: SubscriptionStatus): boolean {
  return status !== 'canceled';
}

function stripeStatusToInternal(stripeStatus: string): SubscriptionStatus {
  const map: Record<string, SubscriptionStatus> = {
    active:             'active',
    trialing:           'trialing',
    past_due:           'past_due',
    canceled:           'canceled',
    unpaid:             'past_due',
    incomplete:         'past_due',
    incomplete_expired: 'canceled',
    paused:             'past_due',
  };
  return map[stripeStatus] ?? 'past_due';
}

describe('Subscription access control', () => {
  test('trialing allows access', () => expect(isAccessAllowed('trialing')).toBe(true));
  test('active allows access',   () => expect(isAccessAllowed('active')).toBe(true));
  test('past_due allows access', () => expect(isAccessAllowed('past_due')).toBe(true));
  test('canceled blocks access', () => expect(isAccessAllowed('canceled')).toBe(false));
});

describe('Stripe → internal status mapping', () => {
  test('active → active',                 () => expect(stripeStatusToInternal('active')).toBe('active'));
  test('trialing → trialing',             () => expect(stripeStatusToInternal('trialing')).toBe('trialing'));
  test('past_due → past_due',             () => expect(stripeStatusToInternal('past_due')).toBe('past_due'));
  test('canceled → canceled',             () => expect(stripeStatusToInternal('canceled')).toBe('canceled'));
  test('unpaid → past_due',               () => expect(stripeStatusToInternal('unpaid')).toBe('past_due'));
  test('incomplete → past_due',           () => expect(stripeStatusToInternal('incomplete')).toBe('past_due'));
  test('incomplete_expired → canceled',   () => expect(stripeStatusToInternal('incomplete_expired')).toBe('canceled'));
  test('unknown → past_due (safe fallback)', () => expect(stripeStatusToInternal('???')).toBe('past_due'));
});

// ─── Job status transitions ───────────────────────────────────────────────────

type JobStatus = 'booked' | 'on_my_way' | 'completed' | 'cancelled';

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  booked:    ['on_my_way', 'completed', 'cancelled'],
  on_my_way: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

function shouldSetCompletedAt(status: JobStatus, existingCompletedAt: string | null): boolean {
  return status === 'completed' && existingCompletedAt === null;
}

describe('Job status transitions', () => {
  test('booked → on_my_way is valid',    () => expect(isValidTransition('booked', 'on_my_way')).toBe(true));
  test('booked → completed is valid',    () => expect(isValidTransition('booked', 'completed')).toBe(true));
  test('booked → cancelled is valid',    () => expect(isValidTransition('booked', 'cancelled')).toBe(true));
  test('on_my_way → completed is valid', () => expect(isValidTransition('on_my_way', 'completed')).toBe(true));
  test('completed → anything is invalid',() => expect(isValidTransition('completed', 'booked')).toBe(false));
  test('cancelled → anything is invalid',() => expect(isValidTransition('cancelled', 'booked')).toBe(false));
});

describe('completed_at auto-set', () => {
  test('sets completed_at when completing a job', () =>
    expect(shouldSetCompletedAt('completed', null)).toBe(true));
  test('does not override existing completed_at',  () =>
    expect(shouldSetCompletedAt('completed', '2026-01-01T10:00:00Z')).toBe(false));
  test('does not set for non-complete statuses',   () =>
    expect(shouldSetCompletedAt('booked', null)).toBe(false));
});

// ─── Estimate status transitions ──────────────────────────────────────────────

type EstimateStatus = 'sent' | 'accepted' | 'declined' | 'expired';

function isTerminalEstimateStatus(status: EstimateStatus): boolean {
  return status === 'accepted' || status === 'declined';
}

function shouldCancelFollowUps(newStatus: EstimateStatus): boolean {
  return isTerminalEstimateStatus(newStatus);
}

describe('Estimate follow-up cancellation', () => {
  test('accepted cancels follow-ups', () => expect(shouldCancelFollowUps('accepted')).toBe(true));
  test('declined cancels follow-ups', () => expect(shouldCancelFollowUps('declined')).toBe(true));
  test('sent does not cancel',        () => expect(shouldCancelFollowUps('sent')).toBe(false));
  test('expired does not cancel',     () => expect(shouldCancelFollowUps('expired')).toBe(false));
});

// ─── Amount validation ────────────────────────────────────────────────────────

function isValidAmountPence(pence: unknown): boolean {
  return typeof pence === 'number' && Number.isInteger(pence) && pence > 0;
}

describe('Estimate amount validation', () => {
  test('positive integer is valid',    () => expect(isValidAmountPence(15000)).toBe(true));
  test('zero is invalid',              () => expect(isValidAmountPence(0)).toBe(false));
  test('negative is invalid',          () => expect(isValidAmountPence(-100)).toBe(false));
  test('float is invalid',             () => expect(isValidAmountPence(15000.5)).toBe(false));
  test('string is invalid',            () => expect(isValidAmountPence('15000')).toBe(false));
  test('null is invalid',              () => expect(isValidAmountPence(null)).toBe(false));
});

// ─── Phone number normalisation ───────────────────────────────────────────────

function normalisePhone(raw: string): string {
  // Strip spaces and dashes, ensure + prefix
  const digits = raw.replace(/[\s\-().]/g, '');
  if (digits.startsWith('0')) return '+44' + digits.slice(1); // UK local → E.164
  if (!digits.startsWith('+')) return '+' + digits;
  return digits;
}

describe('Phone normalisation', () => {
  test('UK local → E.164',          () => expect(normalisePhone('07700 900100')).toBe('+447700900100'));
  test('already E.164 unchanged',   () => expect(normalisePhone('+447700900100')).toBe('+447700900100'));
  test('strips dashes',             () => expect(normalisePhone('+44-7700-900100')).toBe('+447700900100'));
  test('adds + if missing',         () => expect(normalisePhone('447700900100')).toBe('+447700900100'));
});

// ─── Cron rate limit guard ────────────────────────────────────────────────────

function cronAuthValid(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  return header === `Bearer ${secret}`;
}

describe('Cron auth', () => {
  test('correct secret is valid',   () => expect(cronAuthValid('Bearer abc123', 'abc123')).toBe(true));
  test('wrong secret is invalid',   () => expect(cronAuthValid('Bearer wrong', 'abc123')).toBe(false));
  test('missing header is invalid', () => expect(cronAuthValid(undefined, 'abc123')).toBe(false));
  test('empty secret is invalid',   () => expect(cronAuthValid('Bearer abc123', '')).toBe(false));
  test('no Bearer prefix invalid',  () => expect(cronAuthValid('abc123', 'abc123')).toBe(false));
});

// ─── Trial window detection ───────────────────────────────────────────────────

function isTrialEndingIn(trialEndsAt: string, days: number, windowHours = 24): boolean {
  const endsAt = new Date(trialEndsAt).getTime();
  const targetStart = Date.now() + days * 24 * 60 * 60 * 1000;
  const targetEnd   = targetStart + windowHours * 60 * 60 * 1000;
  return endsAt >= targetStart && endsAt < targetEnd;
}

describe('Trial reminder window', () => {
  const future3d = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
  const future7d = new Date(Date.now() + 7   * 24 * 60 * 60 * 1000).toISOString();
  const past     = new Date(Date.now() - 1   * 24 * 60 * 60 * 1000).toISOString();

  test('3-day window catches ~3.5 day trial', () =>
    expect(isTrialEndingIn(future3d, 3)).toBe(true));
  test('7-day trial is outside 3-day window', () =>
    expect(isTrialEndingIn(future7d, 3)).toBe(false));
  test('already expired is outside window',   () =>
    expect(isTrialEndingIn(past, 3)).toBe(false));
});
