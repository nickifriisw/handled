import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth } from '../middleware/auth';
import { AutomationType } from '../types';

const router = Router();

const updateAutomationSchema = z.object({
  enabled: z.boolean().optional(),
  template: z.string().min(10).optional(),
  delay_minutes: z.number().int().min(0).optional(),
});

/**
 * GET /automations
 * Returns all 6 automation configs for the authenticated owner.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;

  const { data: automations, error } = await supabaseAdmin
    .from('automations')
    .select('*')
    .eq('owner_id', owner.id)
    .order('type');

  if (error) {
    res.status(500).json({ error: 'Failed to fetch automations' });
    return;
  }

  res.json({ automations: automations ?? [] });
});

/**
 * GET /automations/:type
 * Returns a single automation config.
 * e.g. GET /automations/missed_call
 */
router.get('/:type', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const type = req.params.type as string;

  // Validate it's a known type
  const validTypes = Object.values(AutomationType) as string[];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Unknown automation type: ${type}` });
    return;
  }

  const { data: automation, error } = await supabaseAdmin
    .from('automations')
    .select('*')
    .eq('owner_id', owner.id)
    .eq('type', type)
    .single();

  if (error || !automation) {
    res.status(404).json({ error: 'Automation not found' });
    return;
  }

  res.json({ automation });
});

/**
 * PATCH /automations/:type
 * Toggle enabled/disabled, update the template, or change the delay.
 *
 * e.g. PATCH /automations/job_complete
 * Body: { "enabled": false }
 * Body: { "template": "Hi {{customer_name}}, custom message here" }
 * Body: { "delay_minutes": 120 }
 */
router.patch('/:type', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const type = req.params.type as string;

  const validTypes = Object.values(AutomationType) as string[];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Unknown automation type: ${type}` });
    return;
  }

  const parsed = updateAutomationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  const { data: automation, error } = await supabaseAdmin
    .from('automations')
    .update(parsed.data)
    .eq('owner_id', owner.id)
    .eq('type', type)
    .select()
    .single();

  if (error || !automation) {
    res.status(500).json({ error: 'Failed to update automation' });
    return;
  }

  res.json({ automation });
});

/**
 * GET /automations/:type/preview
 * Returns the template rendered with sample variables — no SMS is sent.
 * Uses the owner's actual business name for realism.
 *
 * Response: { preview: string, variables: Record<string, string> }
 */
router.get('/:type/preview', requireAuth, async (req: Request, res: Response) => {
  const owner = req.owner!;
  const type = req.params.type as string;

  const validTypes = Object.values(AutomationType) as string[];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Unknown automation type: ${type}` });
    return;
  }

  const { data: automation, error } = await supabaseAdmin
    .from('automations')
    .select('template')
    .eq('owner_id', owner.id)
    .eq('type', type)
    .single();

  if (error || !automation) {
    res.status(404).json({ error: 'Automation not found' });
    return;
  }

  // Sample variables that cover every {{placeholder}} used across all 6 templates
  const sampleVars: Record<string, string> = {
    business_name:    owner.business_name ?? 'Your Business',
    customer_name:    'Sarah',
    owner_name:       owner.full_name?.split(' ')[0] ?? 'Mike',
    job_description:  'bathroom tap replacement',
    scheduled_time:   'tomorrow at 9am',
    amount:           '£240',
    review_link:      'https://g.page/r/example',
    referral_message: 'Know anyone who needs a plumber? We\'d love a referral!',
    estimate_description: 'full bathroom refit',
    follow_up_day:    '2',
  };

  // Substitute all {{variable}} placeholders
  let preview = automation.template;
  for (const [key, value] of Object.entries(sampleVars)) {
    preview = preview.replaceAll(`{{${key}}}`, value);
  }

  // Surface any un-substituted variables so the owner can see what's missing
  const remaining = [...preview.matchAll(/{{(\w+)}}/g)].map((m) => m[1]);

  res.json({ preview, variables: sampleVars, unresolved: remaining });
});

export default router;
