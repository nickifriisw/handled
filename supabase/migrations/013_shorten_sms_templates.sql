-- 013 — Shorten SMS templates that exceed 160 chars (single-segment limit)
-- Applies only to templates that still match the original defaults.
-- Templates > 160 chars cost double (sent as 2 SMS segments).

-- Booking confirmation: 170 → 148 chars
UPDATE automations
SET template = 'Hi {{customer_name}}, confirmed: {{business_name}} on {{scheduled_date}} at {{scheduled_time}}. Address: {{address}}. Any questions? Just reply here.'
WHERE type = 'booking_confirmation'
  AND template = 'Hi {{customer_name}}, your booking with {{business_name}} is confirmed for {{scheduled_date}} at {{scheduled_time}}. Address: {{address}}. Any questions? Just reply here.';

-- Job complete: 179 → 152 chars
UPDATE automations
SET template = 'Hi {{customer_name}}, thanks for choosing {{business_name}} today! Happy with the work? A Google review means the world to us: {{google_review_link}}'
WHERE type = 'job_complete'
  AND template = 'Hi {{customer_name}}, great to see you today! Thanks for using {{business_name}}. If you''re happy with the work, a quick Google review would mean the world: {{google_review_link}}';

-- Referral ask: 180 → 141 chars
UPDATE automations
SET template = 'Hi {{customer_name}}, hope the work''s holding up well! Know anyone who needs a {{trade_type}}? A recommendation means a lot — {{owner_name}}'
WHERE type = 'referral_ask'
  AND template = 'Hi {{customer_name}}, hope everything is still working great! If you know anyone who needs a {{trade_type}}, I''d really appreciate the recommendation. Thanks again — {{owner_name}}';
