// ─── Enums ────────────────────────────────────────────────────────────────────

export enum SubscriptionStatus {
  Trialing = 'trialing',
  Active = 'active',
  PastDue = 'past_due',
  Canceled = 'canceled',
}

export enum JobStatus {
  Booked = 'booked',
  OnMyWay = 'on_my_way',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

export enum EstimateStatus {
  Sent = 'sent',
  Accepted = 'accepted',
  Declined = 'declined',
  Expired = 'expired',
}

export enum MessageDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
}

export enum MessageStatus {
  Queued = 'queued',
  Sent = 'sent',
  Delivered = 'delivered',
  Failed = 'failed',
}

export enum AutomationType {
  MissedCall = 'missed_call',
  BookingConfirmation = 'booking_confirmation',
  OnMyWay = 'on_my_way',
  JobComplete = 'job_complete',
  EstimateFollowUp = 'estimate_follow_up',
  ReferralAsk = 'referral_ask',
}

export enum ScheduledMessageStatus {
  Pending = 'pending',
  Sent = 'sent',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

// ─── Database row types ───────────────────────────────────────────────────────

export interface BusinessOwner {
  id: string;
  email: string;
  full_name: string;
  business_name: string;
  trade_type: string;
  twilio_number: string | null;
  owner_mobile: string | null;   // Personal mobile for SMS notifications
  google_review_link: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  timezone: string;
  created_at: string;
}

export interface Customer {
  id: string;
  owner_id: string;
  phone: string;
  name: string | null;
  opted_out: boolean;
  notes: string | null;
  created_at: string;
}

export interface Job {
  id: string;
  owner_id: string;
  customer_id: string;
  description: string;
  scheduled_at: string | null;
  address: string | null;
  status: JobStatus;
  completed_at: string | null;
  created_at: string;
}

export interface Estimate {
  id: string;
  owner_id: string;
  customer_id: string;
  amount_pence: number;
  description: string;
  status: EstimateStatus;
  sent_at: string | null;
  follow_up_count: number;
  public_token: string;          // UUID — used to build the /e/<token> acceptance URL
  responded_at: string | null;   // When the customer accepted or declined
  created_at: string;
}

export interface Message {
  id: string;
  owner_id: string;
  customer_id: string;
  direction: MessageDirection;
  body: string;
  twilio_sid: string | null;
  status: MessageStatus;
  automation_type: AutomationType | null;
  created_at: string;
}

export interface Automation {
  id: string;
  owner_id: string;
  type: AutomationType;
  enabled: boolean;
  template: string;
  delay_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduledMessage {
  id: string;
  owner_id: string;
  customer_id: string;
  body: string;
  send_at: string;
  status: ScheduledMessageStatus;
  automation_type: AutomationType | null;
  job_id: string | null;
  estimate_id: string | null;
  created_at: string;
}

// ─── API request/response shapes ─────────────────────────────────────────────

export interface InboundSmsWebhook {
  From: string;
  To: string;
  Body: string;
  MessageSid: string;
  AccountSid: string;
}

export interface MissedCallWebhook {
  From: string;
  To: string;
  CallSid: string;
  CallStatus: string;
}

export interface CreateJobBody {
  customer_phone: string;
  customer_name?: string;
  description: string;
  scheduled_at?: string;
  address?: string;
}

export interface UpdateJobBody {
  status?: JobStatus;
  completed_at?: string;
  description?: string;
  scheduled_at?: string;
  address?: string;
}

export interface CreateEstimateBody {
  customer_phone: string;
  customer_name?: string;
  amount_pence: number;
  description: string;
}

export interface UpdateEstimateBody {
  status?: EstimateStatus;
  amount_pence?: number;
  description?: string;
}
