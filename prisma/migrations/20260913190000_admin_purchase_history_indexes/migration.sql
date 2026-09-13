-- Additive, read-path-only indexes. Run outside a transaction: concurrent builds
-- keep existing purchase writes available throughout deployment. C collation
-- matches the opaque cursor's stable source/id ordering. Predicate indexes keep
-- unrelated high-frequency ledger writes out of the admin purchase index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_purchases_admin_history_idx
  ON billing_purchases (environment, purchased_at DESC, id COLLATE "C" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS shop_purchase_requests_admin_history_idx
  ON shop_purchase_requests (created_at DESC, id COLLATE "C" DESC)
  WHERE status = 'SUCCEEDED'
    AND (result_json #> '{purchase,alreadyOwned}') IS DISTINCT FROM 'true'::jsonb;
CREATE INDEX CONCURRENTLY IF NOT EXISTS powerup_purchase_requests_admin_history_idx
  ON powerup_purchase_requests (created_at DESC, id COLLATE "C" DESC)
  WHERE status = 'SUCCEEDED'
    AND (result_json #> '{purchase,alreadyOwned}') IS DISTINCT FROM 'true'::jsonb;
CREATE INDEX CONCURRENTLY IF NOT EXISTS coin_transactions_admin_history_idx
  ON coin_transactions (created_at DESC, id COLLATE "C" DESC)
  WHERE reason IN ('powerup_upgrade', 'billing_reroll') AND amount < 0;
