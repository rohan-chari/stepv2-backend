-- Google subscriptions can be paused indefinitely with null current-period dates.
ALTER TABLE billing_subscriptions ALTER COLUMN period_starts_at DROP NOT NULL;
ALTER TABLE billing_subscriptions ALTER COLUMN access_until DROP NOT NULL;
