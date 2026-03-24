import { supabaseAdmin } from '../lib/supabase';
import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner, Customer, Estimate } from '../types';

/**
 * A5 — Estimate Follow-Up Sequence
 *
 * Sends up to 3 follow-ups (days 2, 5, 10 after estimate sent).
 * Triggered by the cron job reading scheduled_messages,
 * AND directly on estimate creation.
 *
 * On creation: schedules all 3 follow-ups in advance.
 * Cron fires them at the right time.
 *
 * Default template (all 3 use same template, cron index controls wording):
 *   "Hi {{customer_name}}, just following up on the quote I sent for
 *    {{description}} (£{{amount}}). Let me know if you have any questions!"
 */

const FOLLOW_UP_DELAYS_DAYS = [2, 5, 10];

export async function scheduleEstimateFollowUps(params: {
  owner: BusinessOwner;
  customer: Customer;
  estimate: Estimate;
}): Promise<void> {
  const { owner, customer, estimate } = params;

  const amountFormatted = (estimate.amount_pence / 100).toFixed(2);

  for (const days of FOLLOW_UP_DELAYS_DAYS) {
    // Check estimate is still in 'sent' state before scheduling each follow-up.
    // Prevents race condition where estimate is accepted/declined while the
    // loop is still scheduling.
    const { data: current } = await supabaseAdmin
      .from('estimates')
      .select('status')
      .eq('id', estimate.id)
      .single();

    if (!current || current.status !== 'sent') break;

    await fireAutomation({
      owner,
      customer,
      automationType: AutomationType.EstimateFollowUp,
      variables: {
        description: estimate.description,
        amount: amountFormatted,
      },
      delayMinutes: days * 24 * 60,
      estimateId: estimate.id,
    });
  }
}

/**
 * Cancel any pending estimate follow-ups.
 * Called when an estimate is accepted or declined.
 */
export async function cancelEstimateFollowUps(estimateId: string): Promise<void> {
  await supabaseAdmin
    .from('scheduled_messages')
    .update({ status: 'cancelled' })
    .eq('estimate_id', estimateId)
    .eq('status', 'pending')
    .eq('automation_type', 'estimate_follow_up');
}
