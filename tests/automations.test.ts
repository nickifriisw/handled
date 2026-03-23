/**
 * Unit tests for HANDLED automation logic.
 *
 * These tests cover pure business logic only — no network calls, no Supabase,
 * no Twilio, no Anthropic. All external dependencies are mocked.
 *
 * Run with:  node --experimental-vm-modules node_modules/.bin/jest
 * (or after adding jest to package.json — see bottom of this file)
 */

// ─── Template variable substitution ─────────────────────────────────────────

function substituteVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

describe('Template variable substitution', () => {
  test('replaces single variable', () => {
    const out = substituteVars('Hi {{customer_name}}!', { customer_name: 'Dave' });
    expect(out).toBe('Hi Dave!');
  });

  test('replaces multiple variables', () => {
    const out = substituteVars(
      'Hi {{customer_name}}, thanks for using {{business_name}}.',
      { customer_name: 'Dave', business_name: 'Smith Plumbing' }
    );
    expect(out).toBe('Hi Dave, thanks for using Smith Plumbing.');
  });

  test('replaces the same variable multiple times', () => {
    const out = substituteVars('{{name}} and {{name}}', { name: 'Alice' });
    expect(out).toBe('Alice and Alice');
  });

  test('leaves unknown variables untouched', () => {
    const out = substituteVars('Hi {{customer_name}}', {});
    expect(out).toBe('Hi {{customer_name}}');
  });

  test('handles empty template', () => {
    expect(substituteVars('', { name: 'Alice' })).toBe('');
  });
});

// ─── Estimate follow-up delay calculation ────────────────────────────────────

function followUpDelays(days: number[]): number[] {
  return days.map((d) => d * 24 * 60);
}

describe('Estimate follow-up delays', () => {
  const DAYS = [2, 5, 10];

  test('produces 3 follow-ups', () => {
    expect(followUpDelays(DAYS)).toHaveLength(3);
  });

  test('day 2 = 2880 minutes', () => {
    expect(followUpDelays(DAYS)[0]).toBe(2880);
  });

  test('day 5 = 7200 minutes', () => {
    expect(followUpDelays(DAYS)[1]).toBe(7200);
  });

  test('day 10 = 14400 minutes', () => {
    expect(followUpDelays(DAYS)[2]).toBe(14400);
  });
});

// ─── Booking confirmation date formatting ────────────────────────────────────

function formatBookingDate(isoString: string): { date: string; time: string } {
  const d = new Date(isoString);
  return {
    date: d.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
  };
}

describe('Booking date formatting', () => {
  test('formats a weekday correctly', () => {
    // 2026-03-23 is a Monday
    const { date } = formatBookingDate('2026-03-23T09:00:00Z');
    expect(date).toContain('Monday');
    expect(date).toContain('23');
    expect(date).toContain('March');
  });

  test('formats a time in HH:MM', () => {
    const { time } = formatBookingDate('2026-03-23T14:30:00Z');
    expect(time).toMatch(/\d{2}:\d{2}/);
  });
});

// ─── Opt-out keyword detection ───────────────────────────────────────────────

const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const OPT_IN_KEYWORDS = ['START', 'UNSTOP', 'YES'];

function classifyKeyword(body: string): 'opt_out' | 'opt_in' | 'message' {
  const upper = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.includes(upper)) return 'opt_out';
  if (OPT_IN_KEYWORDS.includes(upper)) return 'opt_in';
  return 'message';
}

describe('SMS opt-out keyword detection', () => {
  test.each(OPT_OUT_KEYWORDS)('"%s" is opt-out', (kw) => {
    expect(classifyKeyword(kw)).toBe('opt_out');
  });

  test.each(OPT_IN_KEYWORDS)('"%s" is opt-in', (kw) => {
    expect(classifyKeyword(kw)).toBe('opt_in');
  });

  test('normal message is not opt-out', () => {
    expect(classifyKeyword('Thanks!')).toBe('message');
    expect(classifyKeyword('When will you arrive?')).toBe('message');
  });

  test('case-insensitive: "stop" matches', () => {
    expect(classifyKeyword('stop')).toBe('opt_out');
  });

  test('leading/trailing whitespace is trimmed', () => {
    expect(classifyKeyword('  STOP  ')).toBe('opt_out');
  });
});

// ─── Scheduled message due check ─────────────────────────────────────────────

function isDue(sendAt: string, now: Date = new Date()): boolean {
  return new Date(sendAt) <= now;
}

describe('Scheduled message due check', () => {
  const NOW = new Date('2026-03-22T12:00:00Z');

  test('past time is due', () => {
    expect(isDue('2026-03-22T11:59:00Z', NOW)).toBe(true);
  });

  test('exactly now is due', () => {
    expect(isDue('2026-03-22T12:00:00Z', NOW)).toBe(true);
  });

  test('future time is not due', () => {
    expect(isDue('2026-03-22T12:01:00Z', NOW)).toBe(false);
  });
});

// ─── Amount formatting ────────────────────────────────────────────────────────

function formatAmount(pence: number): string {
  return (pence / 100).toFixed(2);
}

describe('Estimate amount formatting', () => {
  test('£150 = 15000 pence', () => {
    expect(formatAmount(15000)).toBe('150.00');
  });

  test('£1.50 = 150 pence', () => {
    expect(formatAmount(150)).toBe('1.50');
  });

  test('£0 = 0 pence', () => {
    expect(formatAmount(0)).toBe('0.00');
  });
});

/*
 * To run these tests, add the following to package.json:
 *
 * "scripts": {
 *   "test": "jest --testPathPattern=tests/"
 * },
 * "devDependencies": {
 *   "@types/jest": "^29.5.13",
 *   "jest": "^29.7.0",
 *   "ts-jest": "^29.2.5"
 * },
 * "jest": {
 *   "preset": "ts-jest",
 *   "testEnvironment": "node"
 * }
 *
 * Then run: npm install --include=dev && npm test
 */
