import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner, Customer, Job } from '../types';

/**
 * A6 — Referral Ask
 *
 * Triggered 3 days after a job is marked complete.
 * Default delay: 4320 minutes (3 days).
 *
 * Default template:
 *   "Hi {{customer_name}}, hope everything is still working great!
 *    If you know anyone who needs a {{trade_type}}, I'd really appreciate
 *    the recommendation. Thanks again — {{owner_name}}"
 */
export async function sendReferralAsk(params: {
  owner: BusinessOwner;
  customer: Customer;
  job: Job;
}): Promise<void> {
  const { owner, customer, job } = params;

  await fireAutomation({
    owner,
    customer,
    automationType: AutomationType.ReferralAsk,
    variables: {
      trade_type: owner.trade_type,
    },
    jobId: job.id,
  });
}
