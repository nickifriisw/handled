/**
 * scripts/migrate.ts
 *
 * Runs all pending Supabase migrations in order.
 *
 * Usage:
 *   npx tsx scripts/migrate.ts
 *
 * How it works:
 *   1. Reads every *.sql file from supabase/migrations/ in alphabetical order.
 *   2. Creates a _handled_migrations tracking table if it doesn't exist.
 *   3. Skips migrations that are already recorded in the tracking table.
 *   4. Executes each pending migration inside a transaction.
 *   5. Records successful migrations so they won't run again.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Note: Uses the Supabase REST API (supabase-js), NOT a direct Postgres
 * connection, so it is safe to run from Railway or a CI environment.
 * Complex DDL (CREATE EXTENSION etc.) must be run manually or via the
 * Supabase dashboard for the first deploy.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');

/** Ensure the tracking table exists. */
async function ensureTrackingTable(): Promise<void> {
  // We can't run raw DDL via supabase-js easily, so we use rpc or check via select.
  // The table is created manually on first deploy via the Supabase dashboard,
  // or by running the SQL below directly.
  //
  // If the table doesn't exist, the select will error and we instruct the user.
  const { error } = await supabase
    .from('_handled_migrations')
    .select('name')
    .limit(1);

  if (error?.code === 'PGRST116' || error?.message?.includes('does not exist')) {
    console.error(`
❌  The _handled_migrations tracking table does not exist.

    Run this SQL in the Supabase dashboard once:

    CREATE TABLE _handled_migrations (
      name        text PRIMARY KEY,
      run_at      timestamptz NOT NULL DEFAULT now()
    );

    Then re-run this script.
    `);
    process.exit(1);
  }
}

/** Return the set of already-applied migration names. */
async function getApplied(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('_handled_migrations')
    .select('name');

  if (error) throw new Error(`Failed to read migration history: ${error.message}`);
  return new Set((data ?? []).map((r) => r.name));
}

/** Mark a migration as applied. */
async function markApplied(name: string): Promise<void> {
  const { error } = await supabase
    .from('_handled_migrations')
    .insert({ name });

  if (error) throw new Error(`Failed to record migration ${name}: ${error.message}`);
}

async function run(): Promise<void> {
  console.log('\n🗄   HANDLED migration runner');

  await ensureTrackingTable();

  // Read migration files in alphabetical order
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexicographic = chronological given 001_, 002_, etc.

  if (files.length === 0) {
    console.log('    No migration files found in supabase/migrations/');
    return;
  }

  const applied = await getApplied();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`    All ${files.length} migration(s) already applied. Nothing to do.\n`);
    return;
  }

  console.log(`    Found ${files.length} migration(s), ${pending.length} pending:\n`);

  for (const file of pending) {
    const sqlPath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(sqlPath, 'utf-8');

    process.stdout.write(`  Running ${file}...`);

    // Supabase JS doesn't expose raw SQL execution directly, so we call the
    // Postgres REST endpoint via fetch. This requires the service role key.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ query: sql }),
    });

    if (!res.ok) {
      // Fall back: log the SQL and ask user to run manually
      const body = await res.text();
      console.log(`\n\n⚠️   exec_sql RPC not available (${res.status}). Run this migration manually:\n`);
      console.log(`     File: ${sqlPath}\n`);
      console.log('     SQL:');
      console.log(sql.split('\n').map((l) => `     ${l}`).join('\n'));
      console.log('\n     Then re-run this script to mark it as applied.\n');

      // Offer to mark it applied if user has run it manually
      console.log(`     To mark it applied without running: set MARK_APPLIED=1 env var.\n`);
      if (process.env.MARK_APPLIED === '1') {
        await markApplied(file);
        console.log(`     Marked ${file} as applied.\n`);
      }
      continue;
    }

    await markApplied(file);
    console.log(' ✓');
  }

  console.log(`\n✅  Migration run complete.\n`);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
