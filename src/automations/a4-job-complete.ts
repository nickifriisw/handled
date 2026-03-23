import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner, Customer, Job } from '../types';

/**
 * A4 — Job Complete + Review Request
 *
 * Triggered when a job status is updated to 'completed' (PATCH /jobs/:id).
 * Default delay: 60 minutes (configurable via automation.delay_minutes).
 *
 * Default template:
 *   "Hi {{customer_name}}, great to see you today! Thanks for using
 *    {{business_name}}. If you're happy with the work, a quick Google
 *    review would mean the world to us: {{google_review_link}}"
 */
export async function sendJobComplete(params: {
  owner: BusinessOwner;
  customer: Customer;
  job: Job;
}): Promise<void> {
  const { owner, customer, job } = params;

  await fireAutomation({
    owner,
    customer,
    automationType: AutomationType.JobComplete,
    variables: {
      google_review_link: owner.google_review_link ?? '',
    },
    jobId: job.id,
  });
}
