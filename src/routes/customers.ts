import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /customers
 * List all customers for the owner, ordered by most recently active.
 * Optional: ?limit=50&offset=0&search=<name or phone>
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const search = req.query.search as string | undefined;

  let query = supabaseAdmin
    .from('customers')
    .select('*', { count: 'exact' })
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data: customers, error, count } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch customers' });
    return;
  }

  res.json({ customers: customers ?? [], total: count, limit, offset });
});

/**
 * GET /customers/export
 * Download all customers as a CSV file.
 */
router.get('/export', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;

  const { data: customers, error } = await supabaseAdmin
    .from('customers')
    .select('id, name, phone, opted_out, created_at')
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false });

  if (error || !customers) {
    res.status(500).json({ error: 'Failed to export customers' });
    return;
  }

  const header = 'id,name,phone,opted_out,created_at';
  const rows = customers.map((c) =>
    [c.id, csvCell(c.name ?? ''), csvCell(c.phone), c.opted_out ? 'true' : 'false', c.created_at].join(',')
  );

  const csv = [header, ...rows].join('\n');
  const filename = `customers-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

/**
 * GET /customers/:id
 * Returns a single customer with their full message history and job/estimate summary.
 */
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const customerId = req.params.id as string;

  const { data: customer, error: custErr } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('owner_id', owner.id)
    .single();

  if (custErr || !customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const [
    { data: messages },
    { data: jobs },
    { data: estimates },
  ] = await Promise.all([
    supabaseAdmin
      .from('messages')
      .select('*')
      .eq('customer_id', customerId)
      .eq('owner_id', owner.id)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('customer_id', customerId)
      .eq('owner_id', owner.id)
      .order('created_at', { ascending: false }),
    supabaseAdmin
      .from('estimates')
      .select('*')
      .eq('customer_id', customerId)
      .eq('owner_id', owner.id)
      .order('created_at', { ascending: false }),
  ]);

  res.json({
    customer,
    messages: messages ?? [],
    jobs: jobs ?? [],
    estimates: estimates ?? [],
  });
});

/**
 * PATCH /customers/:id
 * Update customer name or opt-out status.
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const customerId = req.params.id as string;

  const { name, opted_out, notes } = req.body as { name?: string; opted_out?: boolean; notes?: string | null };

  const updates: Record<string, unknown> = {};
  if (typeof name === 'string') updates.name = name;
  if (typeof opted_out === 'boolean') updates.opted_out = opted_out;
  if (notes !== undefined) updates.notes = notes;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const { data: customer, error } = await supabaseAdmin
    .from('customers')
    .update(updates)
    .eq('id', customerId)
    .eq('owner_id', owner.id)
    .select()
    .single();

  if (error || !customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  res.json({ customer });
});


/**
 * POST /customers/import
 *
 * Bulk-import customers from CSV text. Accepts a JSON body:
 *   { csv: string }   — raw CSV text (UTF-8)
 *
 * The CSV must have a header row. Recognised column names (case-insensitive):
 *   phone / mobile / number  → phone (required)
 *   name / full_name         → name  (optional)
 *
 * Returns { imported, skipped, errors[] }.
 */
router.post('/import', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const csv: string = req.body?.csv ?? '';

  if (!csv || typeof csv !== 'string') {
    res.status(400).json({ error: 'Body must include { csv: string }' });
    return;
  }

  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
    return;
  }

  // Parse header
  const headers = splitCsvRow(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
  const phoneCol = headers.findIndex((h) => ['phone', 'mobile', 'number', 'phonenumber', 'tel'].includes(h));
  const nameCol  = headers.findIndex((h) => ['name', 'fullname', 'customername', 'contact'].includes(h));

  if (phoneCol === -1) {
    res.status(400).json({ error: 'CSV must contain a phone/mobile column' });
    return;
  }

  let imported = 0;
  let skipped  = 0;
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvRow(lines[i]);
    const phone = (cells[phoneCol] ?? '').trim().replace(/\s/g, '');
    const name  = nameCol >= 0 ? (cells[nameCol] ?? '').trim() || null : null;

    if (!phone || phone.length < 7) {
      errors.push(`Row ${i + 1}: invalid phone ${phone}`);
      skipped++;
      continue;
    }

    const { error } = await supabaseAdmin
      .from('customers')
      .upsert(
        { owner_id: owner.id, phone, name },
        { onConflict: 'owner_id,phone', ignoreDuplicates: false }
      );

    if (error) {
      errors.push(`Row ${i + 1}: ${error.message}`);
      skipped++;
    } else {
      imported++;
    }
  }

  res.json({ imported, skipped, errors: errors.slice(0, 20) }); // cap errors array
});

// ─── Helpers ──────────────────────────────────────────────────────────────────


/**
 * Minimal RFC 4180 CSV row parser.
 * Handles quoted fields containing commas and escaped double-quotes.
 */
function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function csvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}


/**
 * DELETE /customers/:id
 *
 * GDPR right to erasure — permanently deletes a customer and ALL data
 * associated with them (messages, jobs, estimates, scheduled_messages).
 *
 * Supabase cascades take care of related rows if FK constraints are set
 * to ON DELETE CASCADE. If not, we delete manually in dependency order.
 *
 * This action is irreversible.
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const customerId = req.params.id as string;

  // Verify the customer belongs to this owner before deleting
  const { data: customer, error: fetchErr } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('owner_id', owner.id)
    .single();

  if (fetchErr || !customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  // Delete in dependency order (in case cascades aren't configured)
  await supabaseAdmin.from('scheduled_messages').delete().eq('customer_id', customerId);
  await supabaseAdmin.from('messages').delete().eq('customer_id', customerId);
  await supabaseAdmin.from('estimates').delete().eq('customer_id', customerId);
  await supabaseAdmin.from('jobs').delete().eq('customer_id', customerId);
  await supabaseAdmin.from('customers').delete().eq('id', customerId);

  res.status(204).send();
});

export default router;
