import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing Supabase env vars. Check SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'
  );
}

/**
 * Anon client — respects Row Level Security.
 * Use for requests authenticated with a user JWT.
 */
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: false },
});

/**
 * Admin client — bypasses Row Level Security.
 * Use ONLY for server-side operations: cron, webhooks, onboarding provisioning.
 * Never expose this to the browser or untrusted callers.
 */
export const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false },
});
