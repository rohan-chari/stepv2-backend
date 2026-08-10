-- Invite-code onboarding spec, part B: which mechanism attributed each referral.
--
-- Additive and nullable, so this is safe under mixed versions in both
-- directions: the old backend never selects or writes the column, and the new
-- backend treats NULL as "attributed before tracking" (no backfill by design —
-- historical rows genuinely have no known source, and inventing one would
-- corrupt the very breakdown this column exists to produce).
--
-- No index: the column is read per-row by redeemReferralCode (already keyed on
-- refereeSubHash) and aggregated only by the offline audit script.

-- AlterTable
ALTER TABLE "referrals" ADD COLUMN     "source" TEXT;
