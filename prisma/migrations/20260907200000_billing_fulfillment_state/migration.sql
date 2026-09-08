ALTER TABLE billing_purchases ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'pending', ADD COLUMN benefit_kind TEXT NOT NULL DEFAULT 'paid', ADD COLUMN effective_expires_at TIMESTAMP(3);
ALTER TABLE billing_credit_lots ADD CONSTRAINT billing_credit_lot_nonnegative CHECK (remaining >= 0 AND granted >= 0 AND remaining <= granted);
ALTER TABLE billing_purchases ADD CONSTRAINT billing_purchase_nonnegative CHECK (quantity > 0 AND granted_coins >= 0 AND granted_credits >= 0 AND recovered_coins >= 0 AND absorbed_coins >= 0 AND revoked_credits >= 0);
