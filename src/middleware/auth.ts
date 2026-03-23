import { Request, Response, NextFunction } from 'express';
import { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { BusinessOwner } from '../types';
import { logger } from '../lib/logger';

// Extend Express Request with the authenticated owner and raw user
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      owner?: BusinessOwner;
      user?: User;   // raw Supabase user — set by requireJwt and requireAuth
      id: string;
    }
  }
}

/**
 * Validates the Supabase JWT from the Authorization header.
 * Attaches the business_owners row to req.owner.
 * Returns 401 if missing/invalid, 403 if subscription is canceled.
 *
 * All responses include request_id for tracing.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header', request_id: req.id });
    return;
  }

  const token = authHeader.slice(7);

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired token', request_id: req.id });
    return;
  }

  const { data: owner, error: ownerError } = await supabase
    .from('business_owners')
    .select('*')
    .eq('id', user.id)
    .single();

  if (ownerError || !owner) {
    res.status(401).json({ error: 'Business owner record not found', request_id: req.id });
    return;
  }

  if (owner.subscription_status === 'canceled') {
    res.status(403).json({ error: 'Subscription canceled', request_id: req.id });
    return;
  }

  req.user = user;
  req.owner = owner as BusinessOwner;

  // Attach request context to the default logger so all child loggers
  // automatically carry owner_id and request_id
  logger.child({ owner_id: owner.id, request_id: req.id });

  next();
}

/**
 * Lighter variant: validates the JWT only — does NOT require a business_owners row.
 * Use this for endpoints that create the owner row (e.g. self-provision).
 */
export async function requireJwt(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header', request_id: req.id });
    return;
  }

  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    res.status(401).json({ error: 'Invalid or expired token', request_id: req.id });
    return;
  }

  req.user = user;
  next();
}
