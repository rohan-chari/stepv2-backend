-- HITCHHIKE + QUICK_RINSE powerups and the PowerupCopy catalog. ADDITIVE ONLY.
--
-- Both new powerups are store-only (coin store, like IMPOSTER / RAINSTORM /
-- SIGNAL_JAMMER / LEECH): neither ever rolls from a mystery box or a daily
-- reward box, so no rarity-tier data changes.
--   * HITCHHIKE   — targeted, TARGET-driven copy. For 60 minutes the caster
--     COPIES the target's recorded raw steps 1:1 into their own score; the
--     target loses nothing. One active link per caster AND one per target.
--     Compression Socks block it, a Mirror never reflects it, Cleanse clamps it,
--     Quick Rinse halves it, and copied steps never advance mystery-box progress.
--   * QUICK_RINSE — self-only and instantaneous. Halves the REMAINING duration
--     of every active timed opponent-inflicted effect on the user. Creates no
--     effect of its own. Blocked while jammed, exactly like Cleanse.
--
-- ORDERING: new values MUST be added BEFORE 'mystery_box' to match the ordering
-- declared in prisma/schema.prisma. A bare ADD VALUE appends after mystery_box
-- and the next `prisma migrate diff` then reports spurious drift.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run in the same transaction as
-- statements that USE the new value. These are isolated statements, so they are
-- safe. If applied by hand and Postgres complains, run each on its own first.
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'hitchhike' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'quick_rinse' BEFORE 'mystery_box';

-- PowerupCopy — the single source of truth for user-facing powerup copy (§9.5).
-- Keyed by PowerupType, not by SKU: only 6 of the usable types have a shop row,
-- so PowerupShopItem could never cover the in-race surfaces. MYSTERY_BOX is
-- intentionally excluded (a container state, not a usable powerup).
--
-- Back-compat: a brand-new table plus two additive enum values. Nothing is
-- dropped or renamed. powerup_shop_items.name / .description stay in place and
-- keep being RETURNED by GET /shop/powerups — they simply stop being the source
-- of the strings. Old clients never call GET /powerups/catalog and are entirely
-- unaffected; the deploy runs under pm2 cluster mode, and both old and new
-- processes are safe during the overlap (old ones never emit the new values and
-- never read the new table).
CREATE TABLE IF NOT EXISTS "powerup_copy" (
    "powerup_type" "PowerupType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "short_description" TEXT,
    "upgrade_tier_labels" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "powerup_copy_pkey" PRIMARY KEY ("powerup_type")
);
