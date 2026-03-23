/**
 * Feature-level unit tests for the newer routes and business logic.
 *
 * All tests are pure — no network calls, no DB.
 * Logic is extracted from source files as standalone functions here.
 */

// ─── Analytics: daily bucket builder ─────────────────────────────────────────

function buildDailyBuckets(days: number): string[] {
  const buckets: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    buckets.push(d.toISOString().slice(0, 10));
  }
  return buckets;
}

describe('Analytics daily bucket builder', () => {
  test('returns exactly N dates', () => {
    expect(buildDailyBuckets(7).length).toBe(7);
    expect(buildDailyBuckets(30).length).toBe(30);
    expect(buildDailyBuckets(90).length).toBe(90);
  });

  test('last bucket is today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const buckets = buildDailyBuckets(7);
    expect(buckets[buckets.length - 1]).toBe(today);
  });

  test('first bucket is N-1 days ago', () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    expect(buildDailyBuckets(7)[0]).toBe(d.toISOString().slice(0, 10));
  });

  test('buckets are in chronological order', () => {
    const buckets = buildDailyBuckets(14);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i] > buckets[i - 1]).toBe(true);
    }
  });

  test('all dates are valid YYYY-MM-DD format', () => {
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    buildDailyBuckets(30).forEach((b) => expect(b).toMatch(ISO_DATE));
  });
});

// ─── Search: query validation ─────────────────────────────────────────────────

function validateSearchQuery(q: unknown): { valid: boolean; error?: string } {
  if (typeof q !== 'string' || q.trim().length < 2) {
    return { valid: false, error: 'Query must be at least 2 characters' };
  }
  if (q.length > 100) {
    return { valid: false, error: 'Query too long (max 100 characters)' };
  }
  return { valid: true };
}

describe('Search query validation', () => {
  test('empty string is invalid',        () => expect(validateSearchQuery('').valid).toBe(false));
  test('single char is invalid',         () => expect(validateSearchQuery('a').valid).toBe(false));
  test('two chars is valid',             () => expect(validateSearchQuery('ab').valid).toBe(true));
  test('normal query is valid',          () => expect(validateSearchQuery('Tom Baker').valid).toBe(true));
  test('101-char string is invalid',     () => expect(validateSearchQuery('x'.repeat(101)).valid).toBe(false));
  test('100-char string is valid',       () => expect(validateSearchQuery('x'.repeat(100)).valid).toBe(true));
  test('non-string is invalid',          () => expect(validateSearchQuery(null).valid).toBe(false));
  test('whitespace-only is invalid',     () => expect(validateSearchQuery('  ').valid).toBe(false));
  test('error message on short query',   () =>
    expect(validateSearchQuery('a').error).toMatch(/2 characters/));
});

// ─── CSV import: header parsing ───────────────────────────────────────────────

function findColumnIndex(
  headers: string[],
  candidates: string[]
): number {
  const normalised = headers.map((h) =>
    h.toLowerCase().replace(/[^a-z_]/g, '')
  );
  return normalised.findIndex((h) => candidates.includes(h));
}

const PHONE_CANDIDATES = ['phone', 'mobile', 'number', 'phonenumber', 'tel'];
const NAME_CANDIDATES  = ['name', 'fullname', 'customername', 'contact'];

describe('CSV import header detection', () => {
  test('finds "phone" column',          () => expect(findColumnIndex(['phone', 'name'], PHONE_CANDIDATES)).toBe(0));
  test('finds "mobile" column',         () => expect(findColumnIndex(['mobile', 'name'], PHONE_CANDIDATES)).toBe(0));
  test('finds "tel" column',            () => expect(findColumnIndex(['Tel', 'Name'], PHONE_CANDIDATES)).toBe(0));
  test('finds "name" column',           () => expect(findColumnIndex(['phone', 'name'], NAME_CANDIDATES)).toBe(1));
  test('returns -1 if phone absent',    () => expect(findColumnIndex(['name', 'email'], PHONE_CANDIDATES)).toBe(-1));
  test('case-insensitive detection',    () => expect(findColumnIndex(['Phone Number', 'Full Name'], PHONE_CANDIDATES)).toBe(0));
  test('strips spaces and punctuation', () => expect(findColumnIndex(['Phone  Number', 'Full Name'], PHONE_CANDIDATES)).toBe(0));
});

// ─── CSV import: RFC 4180 row splitter ───────────────────────────────────────

function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

describe('RFC 4180 CSV row splitter', () => {
  test('splits simple row',                   () => expect(splitCsvRow('a,b,c')).toEqual(['a', 'b', 'c']));
  test('handles quoted field with comma',     () => expect(splitCsvRow('"hello, world",b')).toEqual(['hello, world', 'b']));
  test('handles escaped double-quote',        () => expect(splitCsvRow('"say ""hi""",b')).toEqual(['say "hi"', 'b']));
  test('handles empty fields',                () => expect(splitCsvRow('a,,c')).toEqual(['a', '', 'c']));
  test('single field',                        () => expect(splitCsvRow('hello')).toEqual(['hello']));
  test('quoted empty field',                  () => expect(splitCsvRow('"",b')).toEqual(['', 'b']));
  test('trailing comma gives empty last cell', () => expect(splitCsvRow('a,b,')).toEqual(['a', 'b', '']));
  test('real import row',                     () =>
    expect(splitCsvRow('+447700900100,"Tom Baker",active')).toEqual([
      '+447700900100', 'Tom Baker', 'active',
    ]));
});

// ─── CSV import: phone validation ────────────────────────────────────────────

function isValidPhone(phone: string): boolean {
  const cleaned = phone.trim().replace(/\s/g, '');
  return cleaned.length >= 7;
}

describe('CSV import phone validation', () => {
  test('E.164 number is valid',        () => expect(isValidPhone('+447700900100')).toBe(true));
  test('7-digit number is valid',      () => expect(isValidPhone('1234567')).toBe(true));
  test('6-digit number is invalid',    () => expect(isValidPhone('123456')).toBe(false));
  test('empty string is invalid',      () => expect(isValidPhone('')).toBe(false));
  test('whitespace stripped',          () => expect(isValidPhone('+44 7700 900 100')).toBe(true));
});

// ─── Health check: env var presence ──────────────────────────────────────────

const REQUIRED_ENV = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'LOOPS_API_KEY', 'APP_URL', 'CRON_SECRET',
];

function checkRequiredEnv(env: Record<string, string | undefined>): string[] {
  return REQUIRED_ENV.filter((key) => !env[key]);
}

describe('Health check env validation', () => {
  test('no missing vars → empty array', () => {
    const fullEnv = Object.fromEntries(REQUIRED_ENV.map((k) => [k, 'value']));
    expect(checkRequiredEnv(fullEnv)).toEqual([]);
  });

  test('missing var → returned in array', () => {
    const env = Object.fromEntries(REQUIRED_ENV.map((k) => [k, 'value']));
    delete env['TWILIO_AUTH_TOKEN'];
    expect(checkRequiredEnv(env)).toEqual(['TWILIO_AUTH_TOKEN']);
  });

  test('all missing → returns all required keys', () => {
    expect(checkRequiredEnv({})).toEqual(REQUIRED_ENV);
  });

  test('extra env vars are ignored', () => {
    const env = {
      ...Object.fromEntries(REQUIRED_ENV.map((k) => [k, 'v'])),
      EXTRA_KEY: 'whatever',
    };
    expect(checkRequiredEnv(env)).toEqual([]);
  });
});

// ─── SMS allowance: trial cap logic ──────────────────────────────────────────

const TRIAL_SMS_LIMIT = 50;

function isSmsAllowed(
  status: string,
  smsCount: number,
  limit: number = TRIAL_SMS_LIMIT
): boolean {
  if (status !== 'trialing') return true; // paid accounts have no cap
  return smsCount < limit;
}

function smsRemaining(smsCount: number, limit: number = TRIAL_SMS_LIMIT): number {
  return Math.max(0, limit - smsCount);
}

describe('Trial SMS cap', () => {
  test('active account always allowed',           () => expect(isSmsAllowed('active', 9999)).toBe(true));
  test('trialing at 0 is allowed',                () => expect(isSmsAllowed('trialing', 0)).toBe(true));
  test('trialing at limit-1 is allowed',          () => expect(isSmsAllowed('trialing', 49)).toBe(true));
  test('trialing at limit is blocked',            () => expect(isSmsAllowed('trialing', 50)).toBe(false));
  test('trialing over limit is blocked',          () => expect(isSmsAllowed('trialing', 99)).toBe(false));
  test('past_due account is allowed (not trial)', () => expect(isSmsAllowed('past_due', 999)).toBe(true));
  test('remaining at 0 sent is 50',               () => expect(smsRemaining(0)).toBe(50));
  test('remaining at 30 sent is 20',              () => expect(smsRemaining(30)).toBe(20));
  test('remaining never goes negative',           () => expect(smsRemaining(999)).toBe(0));
});

// ─── SMS retry: exponential backoff ──────────────────────────────────────────

function backoffMinutes(attempt: number): number {
  // attempt 1 → 5 min, attempt 2 → 15 min, attempt 3 → 45 min
  return 5 * Math.pow(3, attempt - 1);
}

function shouldRetry(retryCount: number, maxRetries: number): boolean {
  return retryCount < maxRetries;
}

describe('SMS retry backoff', () => {
  test('attempt 1 → 5 minutes',   () => expect(backoffMinutes(1)).toBe(5));
  test('attempt 2 → 15 minutes',  () => expect(backoffMinutes(2)).toBe(15));
  test('attempt 3 → 45 minutes',  () => expect(backoffMinutes(3)).toBe(45));
  test('backoff grows geometrically', () => {
    expect(backoffMinutes(2)).toBe(backoffMinutes(1) * 3);
    expect(backoffMinutes(3)).toBe(backoffMinutes(2) * 3);
  });
  test('should retry when count < max',    () => expect(shouldRetry(0, 3)).toBe(true));
  test('should retry when count = max-1',  () => expect(shouldRetry(2, 3)).toBe(true));
  test('should not retry at max',          () => expect(shouldRetry(3, 3)).toBe(false));
  test('should not retry over max',        () => expect(shouldRetry(5, 3)).toBe(false));
});

// ─── Estimate expiry: staleness check ────────────────────────────────────────

function isEstimateExpired(sentAt: string | null, expiryDays = 30): boolean {
  if (!sentAt) return false;
  const sent = new Date(sentAt).getTime();
  const expiryMs = expiryDays * 24 * 60 * 60 * 1000;
  return Date.now() - sent > expiryMs;
}

describe('Estimate expiry', () => {
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  test('sent yesterday is not expired',   () => expect(isEstimateExpired(daysAgo(1))).toBe(false));
  test('sent 29 days ago is not expired', () => expect(isEstimateExpired(daysAgo(29))).toBe(false));
  test('sent 31 days ago is expired',     () => expect(isEstimateExpired(daysAgo(31))).toBe(true));
  test('sent 60 days ago is expired',     () => expect(isEstimateExpired(daysAgo(60))).toBe(true));
  test('null sentAt is never expired',    () => expect(isEstimateExpired(null)).toBe(false));
  test('custom 7-day expiry',             () => expect(isEstimateExpired(daysAgo(8), 7)).toBe(true));
  test('custom 7-day, 6 days is safe',    () => expect(isEstimateExpired(daysAgo(6), 7)).toBe(false));
});
