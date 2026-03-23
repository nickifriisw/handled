/**
 * scripts/db-backup.ts
 *
 * Exports every row from all 8 HANDLED tables to a single timestamped JSON
 * file: backup/YYYY-MM-DDTHH-mm.json
 *
 * Usage:
 *   npx tsx scripts/db-backup.ts
 *
 * Run manually or schedule as a Railway cron job:
 *   0 3 * * *  npx tsx scripts/db-backup.ts   # 03:00 UTC daily
 *
 * The backup file is written to ./backup/ (relative to the project root).
 * In production you'd pipe this to S3/R2/GCS — add that here when ready.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

// --- Minimal inline env validation (no import from src/lib/env so this
//     script can run standalone without all 15 vars present).
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

// Tables to back up, in dependency order (parents before children)
const TABLES = [
  'business_owners',
  'customers',
  'jobs',
  'estimates',
  'messages',
  'automations',
  'scheduled_messages',
  'stripe_events',
] as const;

type TableName = typeof TABLES[number];
type BackupData = Partial<Record<TableName, unknown[]>>;

async function exportTable(table: TableName): Promise<unknown[]> {
  let rows: unknown[] = [];
  let offset = 0;
  const PAGE = 1000;

  // Paginate to handle large tables without hitting PostgREST limits
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(offset, offset + PAGE - 1)
      .order('created_at' as string, { ascending: true });

    if (error) throw new Error(`[${table}] ${error.message}`);
    if (!data || data.length === 0) break;

    rows = rows.concat(data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return rows;
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  console.log('\n🔒  HANDLED database backup');
  console.log(`    Supabase: ${SUPABASE_URL}`);
  console.log(`    Tables:   ${TABLES.join(', ')}\n`);

  const backup: BackupData & {
    _meta: { exported_at: string; duration_ms?: number; row_counts: Record<string, number> };
  } = {
    _meta: {
      exported_at: new Date().toISOString(),
      row_counts: {},
    },
  };

  for (const table of TABLES) {
    process.stdout.write(`  Exporting ${table.padEnd(24)}...`);
    try {
      const rows = await exportTable(table);
      (backup as Record<string, unknown>)[table] = rows;
      backup._meta.row_counts[table] = rows.length;
      console.log(` ✓  ${rows.length} rows`);
    } catch (err) {
      console.error(` ✗  ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  backup._meta.duration_ms = Date.now() - startedAt;

  // ── Write to disk ──────────────────────────────────────────────────────────
  const backupDir = path.join(process.cwd(), 'backup');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 16); // YYYY-MM-DDTHH-mm
  const filename = path.join(backupDir, `${timestamp}.json`);

  fs.writeFileSync(filename, JSON.stringify(backup, null, 2));

  const fileSizeKb = Math.round(fs.statSync(filename).size / 1024);
  const totalRows = Object.values(backup._meta.row_counts).reduce((a, b) => a + b, 0);

  console.log(`\n✅  Backup complete`);
  console.log(`    File:     ${filename}`);
  console.log(`    Size:     ${fileSizeKb} KB`);
  console.log(`    Rows:     ${totalRows}`);
  console.log(`    Duration: ${backup._meta.duration_ms}ms\n`);
}

run().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
