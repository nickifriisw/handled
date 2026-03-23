import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';

const router = Router();

/**
 * GET /search?q=<query>
 *
 * Searches customers (name, phone), jobs (description, address), and
 * estimates (description) for the authenticated owner.
 *
 * Returns up to 5 results per entity type, ranked by relevance (recency).
 * Minimum query length: 2 characters.
 *
 * Response: { customers, jobs, estimates, total }
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const q = (req.query.q as string ?? '').trim();

  if (q.length < 2) {
    res.status(400).json({ error: 'Query must be at least 2 characters' });
    return;
  }

  const pattern = `%${q}%`;

  const [customersRes, jobsRes, estimatesRes] = await Promise.all([
    supabaseAdmin
      .from('customers')
      .select('id, name, phone, opted_out, created_at')
      .eq('owner_id', owner.id)
      .or(`name.ilike.${pattern},phone.ilike.${pattern}`)
      .order('created_at', { ascending: false })
      .limit(5),

    supabaseAdmin
      .from('jobs')
      .select('id, description, address, status, scheduled_at, created_at, customers(id, name, phone)')
      .eq('owner_id', owner.id)
      .or(`description.ilike.${pattern},address.ilike.${pattern}`)
      .order('created_at', { ascending: false })
      .limit(5),

    supabaseAdmin
      .from('estimates')
      .select('id, description, amount_pence, status, created_at, customers(id, name, phone)')
      .eq('owner_id', owner.id)
      .ilike('description', pattern)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const customers = customersRes.data ?? [];
  const jobs      = jobsRes.data ?? [];
  const estimates = estimatesRes.data ?? [];

  res.json({
    customers,
    jobs,
    estimates,
    total: customers.length + jobs.length + estimates.length,
  });
});

export default router;
