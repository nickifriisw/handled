/**
 * Register HANDLED webhook URLs with Twilio.
 *
 * Run this ONCE after deploying to Railway to wire up your Twilio number.
 * Safe to re-run — it updates rather than duplicates.
 *
 * Usage:
 *   APP_URL=https://your-app.railway.app npm run setup-webhooks
 *   # or with a specific number:
 *   APP_URL=https://your-app.railway.app TWILIO_FROM_NUMBER=+447700900100 npm run setup-webhooks
 *
 * What it sets on your Twilio number:
 *   SMS URL          → POST {APP_URL}/webhook/sms/inbound
 *   Status Callback  → POST {APP_URL}/webhook/sms/status
 *   Voice URL        → POST {APP_URL}/webhook/call/missed
 */

import 'dotenv/config';
import twilio from 'twilio';

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`\n✗ Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const accountSid  = required('TWILIO_ACCOUNT_SID');
  const authToken   = required('TWILIO_AUTH_TOKEN');
  const fromNumber  = required('TWILIO_FROM_NUMBER');
  const appUrl      = (process.env.APP_URL ?? '').replace(/\/$/, ''); // strip trailing slash

  if (!appUrl || appUrl === 'http://localhost:3000') {
    console.error('\n✗ APP_URL must be your deployed Railway URL, not localhost.');
    console.error('  Example: APP_URL=https://handled.up.railway.app npm run setup-webhooks\n');
    process.exit(1);
  }

  const smsUrl      = `${appUrl}/webhook/sms/inbound`;
  const statusUrl   = `${appUrl}/webhook/sms/status`;
  const voiceUrl    = `${appUrl}/webhook/call/missed`;

  console.log('\n🔗  HANDLED webhook setup');
  console.log(`   Number : ${fromNumber}`);
  console.log(`   SMS    : POST ${smsUrl}`);
  console.log(`   Status : POST ${statusUrl}`);
  console.log(`   Voice  : POST ${voiceUrl}\n`);

  const client = twilio(accountSid, authToken);

  // Find the incoming phone number resource
  const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber });

  if (numbers.length === 0) {
    console.error(`✗ No Twilio number found matching ${fromNumber}.`);
    console.error('  Check TWILIO_FROM_NUMBER in your .env — must be E.164 format (+447700900100).\n');
    process.exit(1);
  }

  const numberSid = numbers[0].sid;
  console.log(`   SID    : ${numberSid}`);

  // Update all three webhook URLs
  const updated = await client.incomingPhoneNumbers(numberSid).update({
    smsUrl,
    smsMethod:               'POST',
    statusCallback:          statusUrl,
    statusCallbackMethod:    'POST',
    voiceUrl,
    voiceMethod:             'POST',
  });

  console.log('\n✓ Webhooks registered successfully!');
  console.log(`  SMS URL    : ${updated.smsUrl}`);
  console.log(`  Status URL : ${updated.statusCallback}`);
  console.log(`  Voice URL  : ${updated.voiceUrl}`);
  console.log('\n📋  Next steps:');
  console.log('  1. Set STRIPE_WEBHOOK_SECRET — run: stripe listen --forward-to $APP_URL/webhook/stripe');
  console.log('  2. Add Railway cron services (see README → "Set up Railway cron jobs")');
  console.log('  3. Run: npm run pre-deploy\n');
}

main().catch((err) => {
  console.error('\n✗ Setup failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
