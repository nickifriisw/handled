import { fireAutomation } from './engine';
import { AutomationType, BusinessOwner, Customer, Job } from '../types';

/**
 * A2 — Booking Confirmation
 *
 * Triggered when a job is created (POST /jobs).
 * Sends immediately (delay = 0).
 *
 * Default template:
 *   "Hi {{customer_name}}, your booking with {{business_name}} is
 *    confirmed for {{scheduled_date}} at {{scheduled_time}}.
 *    Address: {{address}}. Any questions? Just reply here."
 */
export async function sendBookingConfirmation(params: {
  owner: BusinessOwner;
  customer: Customer;
  job: Job;
}): Promise<void> {
  const { owner, customer, job } = params;

  let scheduledDate = '';
  let scheduledTime = '';
  if (job.scheduled_at) {
    const d = new Date(job.scheduled_at);
    scheduledDate = d.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    scheduledTime = d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  await fireAutomation({
    owner,
    customer,
    automationType: AutomationType.BookingConfirmation,
    variables: {
      scheduled_date: scheduledDate || 'TBC',
      scheduled_time: scheduledTime || 'TBC',
      address: job.address ?? 'TBC',
      description: job.description,
    },
    jobId: job.id,
  });
}
