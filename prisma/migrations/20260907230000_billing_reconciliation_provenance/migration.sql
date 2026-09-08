ALTER TABLE billing_purchases ADD COLUMN refund_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_reconciliation ADD COLUMN requested_version INTEGER NOT NULL DEFAULT 0, ADD COLUMN lease_version INTEGER;
ALTER TABLE billing_subscriptions ADD COLUMN provider_status TEXT NOT NULL DEFAULT 'active';
