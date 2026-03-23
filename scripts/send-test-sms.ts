/**
 * Development utility: send a test SMS to verify your Twilio + automation stack works.
 *
 * Usage:
 *   npx tsx scripts/send-test-sms.ts +447700900100
 *   npx tsx scripts/send-test-sms.ts +447700900100 --automation missed_call
 *
 * Defaults to sending a plain "HANDLED test message" if no --automation flag is given.
 *
 * NEVER run against production unless you mean to — this sends a real SMS.
 */

import 'dotenv/config';
import twilio from 'twilio';

const AUTOMATIONS = [
  'missed_call', 'booking_confirmation', 'on_my_way',
  'job_complete', 'estimate_follow_up', 'referral',
] as const;

type AutomationType = (typeof AUTOMATIONS)[number];

const SAMPLE_MESSAGES: Record<AutomationType, string> = {
  missed_call:
    'Hi, you just missed a call from {{business_name}}. We\'d love to help — reply or call us back anytime.',
  booking_confirmation:
    'Hi {{customer_name}}, your booking with {{business_name}} is confirmed for {{scheduled_time}}. See you then!',
  on_my_way:
    'Hi {{customer_name}}, {{owner_name}} from {{business_name}} is on the way to you now. ETA ~30 minutes.',
  job_complete:
    'Thanks for having us {{customer_name}}! If you\'re happy with the work, a quick Google review would mean the world: {{review_link}}',
  estimate_follow_up:
    'Hi {{customer_name}}, just following up on the estimate for {{estimate_description}} ({{amount}}). Any questions?',
  referral:
    'Hi {{customer_name}}, hope all is well! If you know anyone who needs a {{trade_type}}, we\'d really appreciate a referral. 🙏',
};

function interpolate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('\nUsage: npx tsx scripts/send-test-sms.ts <to-number> [--automation <type>]\n');
    console.error('Available automations:', AUTOMATIONS.join(', '));
    process.exit(1);
  }

  const toNumber = args[0];
  const autoFlag = args.indexOf('--automation');
  const automationType = autoFlag >= 0 ? args[autoFlag + 1] as AutomationType : null;

  // Validate env
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('\n✗ Missing env vars:', missing.join(', '));
    console.error('  Copy .env.example → .env and fill in your Twilio credentials.\n');
    process.exit(1);
  }

  // Sample variables for template interpolation
  const vars = {
    business_name:        process.env.TEST_BUSINESS_NAME ?? 'HANDLED Test',
    customer_name:        'Sarah',
    owner_name:           'Mike',
    scheduled_time:       'tomorrow at 9am',
    review_link:          'https://g.page/r/test-review-link',
    estimate_description: 'full bathroom refit',
    amount:               '£240',
    trade_type:           'plumber',
  };

  let body: string;
  if (automationType) {
    if (!AUTOMATIONS.includes(automationType)) {
      console.error(`\n✗ Unknown automation type: ${automationType}`);
      console.error('  Available:', AUTOMATIONS.join(', '), '\n');
      process.exit(1);
    }
    body = interpolate(SAMPLE_MESSAGES[automationType], vars);
    console.log(`\n📱 Sending "${automationType}" automation test SMS`);
  } else {
    body = `[HANDLED test] Everything is working ✓ Sent at ${new Date().toLocaleTimeString('en-GB')}`;
    console.log('\n📱 Sending plain test SMS');
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

  console.log(`   From: ${process.env.TWILIO_FROM_NUMBER}`);
  console.log(`   To:   ${toNumber}`);
  console.log(`   Body: ${body}\n`);

  try {
    const msg = await client.messages.create({
      from: process.env.TWILIO_FROM_NUMBER!,
      to: toNumber,
      body,
    });
    console.log(`✓ Sent! SID: ${msg.sid}  Status: ${msg.status}\n`);
  } catch (err) {
    console.error('✗ Failed to send:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
