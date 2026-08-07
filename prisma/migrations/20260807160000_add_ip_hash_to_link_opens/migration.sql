-- Additive: hashed client IP on landing-page opens, powering IP-correlated
-- deferred referral attribution (codeless signup from the same IP within the
-- fallback window attributes to the opened code). Nullable — old rows never match.
ALTER TABLE "link_opens" ADD COLUMN "ip_hash" TEXT;

CREATE INDEX "link_opens_ip_hash_created_at_idx" ON "link_opens"("ip_hash", "created_at");
