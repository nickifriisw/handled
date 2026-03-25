import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { sendBookingConfirmation } from '../automations/a2-booking-confirmation';
import { sendOnMyWay } from '../automations/a3-on-my-way';
import { sendJobComplete } from '../automations/a4-job-complete';
import { sendReferralAsk } from '../automations/a6-referral-ask';
import { CreateJobBody, UpdateJobBody, JobStatus } from '../types';

const router = Router();

/**
 * GET /jobs
 * Returns all jobs for the owner, most recent first.
 * Optional query params: ?status=booked&limit=50&offset=0
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const status = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('jobs')
    .select('*, customers(id, phone, name)', { count: 'exact' })
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq('status', status);

  const { data: jobs, error, count } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch jobs' });
    return;
  }

  res.json({ jobs: jobs ?? [], total: count, limit, offset });
});

/**
 * GET /jobs/export
 * Download all jobs as CSV (no pagination).
 * Optional: ?status=booked
 */
router.get('/export', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const status = req.query.status as string | undefined;

  let query = supabaseAdmin
    .from('jobs')
    .select('id, status, description, address, scheduled_at, completed_at, created_at, customers(name, phone)')
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data: jobs, error } = await query;

  if (error || !jobs) {
    res.status(500).json({ error: 'Failed to export jobs' });
    return;
  }

  const header = 'id,status,customer_name,customer_phone,description,address,scheduled_at,completed_at,created_at';
  const rows = jobs.map((j) => {
    const cust = j.customers as unknown as { name: string | null; phone: string } | null;
    return [
      j.id,
      j.status,
      csvCell(cust?.name ?? ''),
      csvCell(cust?.phone ?? ''),
      csvCell(j.description ?? ''),
      csvCell(j.address ?? ''),
      j.scheduled_at ?? '',
      j.completed_at ?? '',
      j.created_at,
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');
  const filename = `jobs-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

const createJobSchema = z.object({
  customer_phone: z.string().min(7),
  customer_name: z.string().optional(),
  description: z.string().min(1),
  scheduled_at: z.string().datetime().optional(),
  address: z.string().optional(),
});

const updateJobSchema = z.object({
  status: z.nativeEnum(JobStatus).optional(),
  completed_at: z.string().datetime().optional(),
  description: z.string().optional(),
  scheduled_at: z.string().datetime().optional(),
  address: z.string().optional(),
  eta_minutes: z.number().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * POST /jobs
 * Create a new job + trigger booking confirmation SMS
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const owner = req.owner!;
  const { customer_phone, customer_name, description, scheduled_at, address } =
    parsed.data as CreateJobBody;

  const { data: customer, error: custErr } = await supabaseAdmin
    .from('customers')
    .upsert(
      { owner_id: owner.id, phone: customer_phone, name: customer_name ?? null },
      { onConflict: 'owner_id,phone', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (custErr || !customer) {
    res.status(500).json({ error: 'Failed to upsert customer' });
    return;
  }

  const { data: job, error: jobErr } = await supabaseAdmin
    .from('jobs')
    .insert({
      owner_id: owner.id,
      customer_id: customer.id,
      description,
      scheduled_at: scheduled_at ?? null,
      address: address ?? null,
      status: 'booked',
    })
    .select()
    .single();

  if (jobErr || !job) {
    res.status(500).json({ error: 'Failed to create job' });
    return;
  }

  sendBookingConfirmation({ owner, customer, job }).catch((err) =>
    console.error('[jobs] booking confirmation error:', err)
  );

  res.status(201).json({ job });
});

/**
 * PATCH /jobs/:id
 * Update job status — triggers on_my_way / job_complete / referral_ask automations
 */
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const parsed = updateJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const owner = req.owner!;
  const jobId = req.params.id;
  const updates = parsed.data as UpdateJobBody & { eta_minutes?: number };

  const { data: existingJob } = await supabaseAdmin
    .from('jobs')
    .select('*, customers(*)')
    .eq('id', jobId)
    .eq('owner_id', owner.id)
    .single();

  if (!existingJob) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  const { eta_minutes, ...jobUpdates } = updates;

  if (jobUpdates.status === JobStatus.Completed && !jobUpdates.completed_at) {
    jobUpdates.completed_at = new Date().toISOString();
  }

  const { data: job, error: updateErr } = await supabaseAdmin
    .from('jobs')
    .update(jobUpdates)
    .eq('id', jobId)
    .select()
    .single();

  if (updateErr || !job) {
    res.status(500).json({ error: 'Failed to update job' });
    return;
  }

  const customer = existingJob.customers;

  if (jobUpdates.status === JobStatus.OnMyWay) {
    sendOnMyWay({ owner, customer, job, etaMinutes: eta_minutes }).catch(console.error);
  }
  if (jobUpdates.status === JobStatus.Completed) {
    sendJobComplete({ owner, customer, job }).catch(console.error);
    sendReferralAsk({ owner, customer, job }).catch(console.error);
  }

  res.json({ job });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wraps a cell value in quotes and escapes internal quotes for RFC 4180 CSV. */
function csvCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export default router;
