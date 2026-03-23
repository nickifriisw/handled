import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner, Customer, Job } from '../types';

/**
 * A3 — On My Way
 *
 * Triggered when a job status is updated to 'on_my_way' (PATCH /jobs/:id).
 * Sends immediately (delay = 0).
 *
 * Default template:
 *   "Hi {{customer_name}}, {{owner_name}} from {{business_name}} here —
 *    I'm on my way to you now! Should be there in about {{eta_minutes}} mins."
 */
export async function sendOnMyWay(params: {
  owner: BusinessOwner;
  customer: Customer;
  job: Job;
  etaMinutes?: number;
}): Promise<void> {
  const { owner, customer, job, etaMinutes = 20 } = params;

  await fireAutomation({
    owner,
    customer,
    automationType: AutomationType.OnMyWay,
    variables: {
      eta_minutes: String(etaMinutes),
      address: job.address ?? '',
    },
    jobId: job.id,
  });
}
