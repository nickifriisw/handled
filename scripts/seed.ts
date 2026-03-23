/**
 * Development seed script.
 *
 * Creates one fake business owner + customers + jobs + estimates + messages
 * directly via the Supabase admin client (bypasses RLS).
 *
 * Usage:
 *   cp .env.example .env     # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   npx tsx scripts/seed.ts
 *
 * Safe to run multiple times — clears existing seed data first.
 * Do NOT run against production.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SEED_EMAIL = 'seed-owner@handled.dev';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  console.log('🌱 Seeding HANDLED dev database...\n');

  // ── 1. Clean up previous seed ────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('business_owners')
    .select('id')
    .eq('email', SEED_EMAIL)
    .single();

  if (existing) {
    console.log('Removing previous seed owner...');
    await supabase.from('business_owners').delete().eq('id', existing.id);
  }

  // ── 2. Create owner ───────────────────────────────────────────────────────
  // Note: In production, the auth.users row is created by Supabase Auth.
  // For seeding, we insert directly into business_owners with a fake UUID.
  const ownerId = '00000000-0000-0000-0000-000000000001';

  const { data: owner, error: ownerErr } = await supabase
    .from('business_owners')
    .insert({
      id: ownerId,
      email: SEED_EMAIL,
      full_name: 'Dave Smith',
      business_name: 'Smith Plumbing',
      trade_type: 'plumber',
      twilio_number: '+447700900001',
      google_review_link: 'https://g.page/r/fake-review-link',
      subscription_status: 'active',
      timezone: 'Europe/London',
    })
    .select()
    .single();

  if (ownerErr) {
    console.error('Failed to create owner:', ownerErr.message);
    process.exit(1);
  }
  console.log(`✓ Owner: ${owner.full_name} (${owner.business_name})`);

  // ── 3. Seed automations ───────────────────────────────────────────────────
  const automations = [
    {
      owner_id: ownerId,
      type: 'missed_call',
      enabled: true,
      template:
        "Hi {{customer_name}}, sorry I missed your call! I'm {{owner_name}} from {{business_name}}. I'll call you back shortly — or reply here if easier.",
      delay_minutes: 0,
    },
    {
      owner_id: ownerId,
      type: 'booking_confirmation',
      enabled: true,
      template:
        'Hi {{customer_name}}, your booking with {{business_name}} is confirmed for {{scheduled_date}} at {{scheduled_time}}. Address: {{address}}. Any questions? Just reply here.',
      delay_minutes: 0,
    },
    {
      owner_id: ownerId,
      type: 'on_my_way',
      enabled: true,
      template:
        "Hi {{customer_name}}, {{owner_name}} from {{business_name}} here — I'm on my way now! Should be there in about {{eta_minutes}} mins.",
      delay_minutes: 0,
    },
    {
      owner_id: ownerId,
      type: 'job_complete',
      enabled: true,
      template:
        "Hi {{customer_name}}, great to see you today! Thanks for using {{business_name}}. If you're happy with the work, a quick Google review would mean the world: {{google_review_link}}",
      delay_minutes: 60,
    },
    {
      owner_id: ownerId,
      type: 'estimate_follow_up',
      enabled: true,
      template:
        "Hi {{customer_name}}, just following up on the quote I sent for {{description}} (£{{amount}}). Let me know if you have any questions!",
      delay_minutes: 0,
    },
    {
      owner_id: ownerId,
      type: 'referral_ask',
      enabled: true,
      template:
        "Hi {{customer_name}}, hope everything's still working great! If you know anyone who needs a {{trade_type}}, I'd really appreciate the recommendation. Thanks — {{owner_name}}",
      delay_minutes: 4320,
    },
  ];

  await supabase.from('automations').insert(automations);
  console.log(`✓ Seeded ${automations.length} automations`);

  // ── 4. Seed customers ─────────────────────────────────────────────────────
  const customerData = [
    { owner_id: ownerId, phone: '+447700900100', name: 'Sarah Johnson' },
    { owner_id: ownerId, phone: '+447700900101', name: 'Mike Peters' },
    { owner_id: ownerId, phone: '+447700900102', name: 'Claire Williams' },
    { owner_id: ownerId, phone: '+447700900103', name: 'Tom Baker' },
    { owner_id: ownerId, phone: '+447700900104', name: null }, // unknown caller
  ];

  const { data: customers } = await supabase
    .from('customers')
    .insert(customerData)
    .select();

  console.log(`✓ Seeded ${customers?.length ?? 0} customers`);
  if (!customers || customers.length === 0) process.exit(1);

  const [sarah, mike, claire, tom, unknown] = customers;

  // ── 5. Seed jobs ──────────────────────────────────────────────────────────
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const { data: jobs } = await supabase
    .from('jobs')
    .insert([
      {
        owner_id: ownerId,
        customer_id: sarah.id,
        description: 'Fix leaking kitchen tap',
        scheduled_at: tomorrow.toISOString(),
        address: '12 Oak Street, London, SE1 2AB',
        status: 'booked',
      },
      {
        owner_id: ownerId,
        customer_id: mike.id,
        description: 'Replace bathroom radiator',
        scheduled_at: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        address: '45 Elm Road, London, SW2 3CD',
        status: 'booked',
      },
      {
        owner_id: ownerId,
        customer_id: claire.id,
        description: 'Annual boiler service',
        scheduled_at: yesterday.toISOString(),
        address: '8 Maple Avenue, London, W1 4EF',
        status: 'completed',
        completed_at: yesterday.toISOString(),
      },
    ])
    .select();

  console.log(`✓ Seeded ${jobs?.length ?? 0} jobs`);

  // ── 6. Seed estimates ─────────────────────────────────────────────────────
  await supabase.from('estimates').insert([
    {
      owner_id: ownerId,
      customer_id: tom.id,
      amount_pence: 45000,
      description: 'Full bathroom refit — new suite, tiling, plumbing',
      status: 'sent',
      sent_at: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      follow_up_count: 1,
    },
    {
      owner_id: ownerId,
      customer_id: sarah.id,
      amount_pence: 12000,
      description: 'Replace kitchen sink unit',
      status: 'accepted',
      sent_at: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ]);
  console.log('✓ Seeded 2 estimates');

  // ── 7. Seed messages ──────────────────────────────────────────────────────
  await supabase.from('messages').insert([
    {
      owner_id: ownerId,
      customer_id: unknown.id,
      direction: 'inbound',
      body: '',
      twilio_sid: 'CA_seed_001',
      status: 'delivered',
      automation_type: null,
    },
    {
      owner_id: ownerId,
      customer_id: unknown.id,
      direction: 'outbound',
      body: "Hi, sorry I missed your call! I'm Dave from Smith Plumbing. I'll call you back shortly — or reply here if easier.",
      twilio_sid: 'CA_seed_002',
      status: 'delivered',
      automation_type: 'missed_call',
    },
    {
      owner_id: ownerId,
      customer_id: sarah.id,
      direction: 'outbound',
      body: "Hi Sarah, your booking with Smith Plumbing is confirmed for tomorrow. Address: 12 Oak Street. Any questions? Just reply here.",
      twilio_sid: 'CA_seed_003',
      status: 'delivered',
      automation_type: 'booking_confirmation',
    },
    {
      owner_id: ownerId,
      customer_id: sarah.id,
      direction: 'inbound',
      body: 'Thanks Dave, see you then!',
      twilio_sid: 'CA_seed_004',
      status: 'delivered',
      automation_type: null,
    },
    {
      owner_id: ownerId,
      customer_id: claire.id,
      direction: 'outbound',
      body: "Hi Claire, great to see you today! Thanks for using Smith Plumbing. A quick Google review would mean the world: https://g.page/r/fake-review-link",
      twilio_sid: 'CA_seed_005',
      status: 'delivered',
      automation_type: 'job_complete',
    },
  ]);
  console.log('✓ Seeded 5 messages');

  console.log('\n✅ Seed complete!');
  console.log(`\nOwner ID: ${ownerId}`);
  console.log('To test the API, log in as this user via Supabase Auth (seed-owner@handled.dev)');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
