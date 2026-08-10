-- Invite-code onboarding spec, part D: coarse-network tier of the referral
-- IP fallback. Mirrors the existing ip_hash column + [ip_hash, created_at]
-- index one-for-one.
--
-- Additive and nullable. Mixed-version safety: an old backend writing a
-- link_opens row simply leaves ip_net_hash NULL, and the new backend's tier-2
-- lookup skips NULL hashes rather than matching them (a `WHERE ip_net_hash IS
-- NULL` match would sweep in every pre-deploy row). Legacy NULL rows therefore
-- can never attribute, and they age out of the 48h fallback window within two
-- days of deploy — so no backfill is needed or wanted.
--
-- The paired index matches the tier-2 query shape (equality on the hash, range
-- on created_at) exactly as ip_hash's does for tier 1.

-- AlterTable
ALTER TABLE "link_opens" ADD COLUMN     "ip_net_hash" TEXT;

-- CreateIndex
CREATE INDEX "link_opens_ip_net_hash_created_at_idx" ON "link_opens"("ip_net_hash", "created_at");
