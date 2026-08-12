const { prisma } = require("../../../db");
const { addDaysToDateString } = require("../../../shared/time/week");

// Ceiling for User.renameChipShownCount. The client only ever needs to compare
// against maxRenameChipShows (3); the clamp exists so a misbehaving or looping
// client cannot unbounded-increment a prod column.
const MAX_RENAME_CHIP_SHOWN_COUNT = 99;

// C5 (spec §5 Phase E2): the users row is the bulk of the `/auth/me` payload,
// so THIS MODEL is the invalidation chokepoint for it. Every users-row mutation
// in the codebase routes through one of the methods below except the raw
// `tx.user.update` calls nested inside larger transactions and the two coin
// seams — those are hooked individually (see the inventory table in
// services/authMeCache.js). Hooking here rather than at ~30 call sites is what
// makes "did we miss a seam?" answerable by reading one file.
//
// Lazy require: authMeCache pulls in the Redis wrapper, and this model is
// loaded by the auth middleware on every request path.
async function invalidateAuthMe(id) {
  try {
    await require("../services/authMeCache").invalidateSafe(id);
  } catch {
    // Cache bookkeeping must never fail a user write.
  }
}

const User = {
  async findById(id) {
    return prisma.user.findUnique({ where: { id } });
  },

  async findByAppleId(appleId) {
    return prisma.user.findUnique({ where: { appleId } });
  },

  async findByGoogleSub(googleSub) {
    return prisma.user.findUnique({ where: { googleSub } });
  },

  async findByEmail(email) {
    return prisma.user.findFirst({ where: { email } });
  },

  async findByReferralCode(referralCode) {
    if (!referralCode) return null;
    return prisma.user.findUnique({ where: { referralCode } });
  },

  async create({
    appleId,
    googleSub,
    email,
    name,
    displayName,
    isReviewAccount,
    nameSetupOnboardingRequired,
  }) {
    // A user is keyed on exactly one provider id (appleId for iOS, googleSub for
    // Android). Only set the one that was supplied so the other stays null.
    const data = { email, name };
    if (appleId !== undefined) {
      data.appleId = appleId;
    }
    if (googleSub !== undefined) {
      data.googleSub = googleSub;
    }
    if (displayName !== undefined) {
      data.displayName = displayName;
    }
    if (isReviewAccount !== undefined) {
      data.isReviewAccount = isReviewAccount;
    }
    if (nameSetupOnboardingRequired !== undefined) {
      data.nameSetupOnboardingRequired = nameSetupOnboardingRequired === true;
    }
    return prisma.user.create({ data });
  },

  async update(id, fields) {
    const updated = await prisma.user.update({
      where: { id },
      data: fields,
    });
    await invalidateAuthMe(id);
    return updated;
  },

  // TR-706: persist the user's X-Client-Features tokens (STICKY union — the
  // middleware passes the merged set and calls this ONLY when a new token
  // appeared, so this is never a hot write path). Stamps clientFeaturesAt for
  // observability/debugging.
  async updateClientFeatures(id, features) {
    const updated = await prisma.user.update({
      where: { id },
      data: { clientFeatures: features, clientFeaturesAt: new Date() },
    });
    await invalidateAuthMe(id);
    return updated;
  },

  // Sticky-write the user's IANA timezone (§7). Called from requireAuth ONLY
  // when the request carried a real, valid X-Timezone that differs from the
  // stored value — never on every request (mirrors updateClientFeatures; commit
  // 3e6c827's pool-exhaustion lesson). Backs the daily-reward reminder scheduler.
  async updateTimezone(id, timezone) {
    const updated = await prisma.user.update({
      where: { id },
      data: { timezone },
    });
    await invalidateAuthMe(id);
    return updated;
  },

  // Batch 2026-08-08 item 9: stamp `lastSeenAt` (+ `lastAppVersion` when this
  // request carried a valid X-App-Version) for the admin version-spread report.
  //
  // THE ONE METHOD ON THIS MODEL THAT DELIBERATELY DOES NOT INVALIDATE THE
  // /auth/me CACHE, and the reason is the whole point of the method existing:
  //
  //   * Every sibling above routes through the C5 chokepoint and DELs
  //     `v1:user:{id}:authme`. `/auth/me` is the #2 endpoint by volume with a
  //     10-SECOND TTL, so its value is entirely in the warm window.
  //   * requireAuth calls this once per user per UTC day (plus once per app
  //     upgrade). Invalidating would therefore evict a warm payload for
  //     essentially EVERY active user EVERY day — a measurable hit-rate loss
  //     bought for a field no client ever reads.
  //   * Skipping the DEL is safe because neither column is serialized to any
  //     client: `withRuntimeFlags` in users/routes.js strips both from every
  //     user payload this backend emits, and an integration test pins that. A
  //     stale cached payload therefore cannot differ in any observable field.
  //
  // If either column is ever exposed to a client, this method MUST start
  // invalidating (or the exposure must be reverted).
  //
  // updateMany, not update: a request that races account deletion must no-op,
  // not throw a P2025 into the auth middleware.
  async touchLastSeen(id, fields) {
    if (!id || !fields || Object.keys(fields).length === 0) return;
    await prisma.user.updateMany({ where: { id }, data: fields });
  },

  // §9.1: read the user's notification preferences. The column is NOT NULL with a
  // true default, so an absent/never-set preference reads as true.
  async getNotificationPreferences(id) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        dailyRewardRemindersEnabled: true,
        stepMilestoneRemindersEnabled: true,
      },
    });
    return {
      dailyRewardRemindersEnabled: user?.dailyRewardRemindersEnabled ?? true,
      stepMilestoneRemindersEnabled: user?.stepMilestoneRemindersEnabled ?? true,
    };
  },

  // §9.1: persist the daily-reward reminder opt-out and return the stored value.
  async setDailyRewardRemindersEnabled(id, enabled) {
    const user = await prisma.user.update({
      where: { id },
      data: { dailyRewardRemindersEnabled: enabled },
      select: { dailyRewardRemindersEnabled: true },
    });
    await invalidateAuthMe(id);
    return { dailyRewardRemindersEnabled: user.dailyRewardRemindersEnabled };
  },

  // Batch 2026-08-08 item 3: persist the step-milestone reminder opt-out. A
  // SEPARATE setter (not a merged "setNotificationPreferences") so a frozen
  // client's PATCH — which only ever carries dailyRewardRemindersEnabled —
  // physically cannot write this column. Mirrors the daily-reward setter,
  // including the /auth/me cache invalidation.
  async setStepMilestoneRemindersEnabled(id, enabled) {
    const user = await prisma.user.update({
      where: { id },
      data: { stepMilestoneRemindersEnabled: enabled },
      select: { stepMilestoneRemindersEnabled: true },
    });
    await invalidateAuthMe(id);
    return { stepMilestoneRemindersEnabled: user.stepMilestoneRemindersEnabled };
  },

  // Home SETUP section — rename-chip nudge state.
  //
  // Both writes are expressed as conditional updateMany + re-read rather than a
  // read-modify-write so two concurrent requests from the same account cannot
  // race past the clamp or move an existing dismissal timestamp.
  //
  // Clamped increment. No-ops (returning the unchanged row) when the user has
  // already dismissed the chip — it should never have been shown, so don't count
  // it, and don't error — or when the count has already hit the ceiling.
  async recordRenameChipShown(id) {
    await prisma.user.updateMany({
      where: {
        id,
        renameChipDismissedAt: null,
        renameChipShownCount: { lt: MAX_RENAME_CHIP_SHOWN_COUNT },
      },
      data: { renameChipShownCount: { increment: 1 } },
    });
    await invalidateAuthMe(id);
    return prisma.user.findUnique({ where: { id } });
  },

  // Idempotent stamp: a second call leaves the original timestamp in place.
  async dismissRenameChip(id, dismissedAt = new Date()) {
    await prisma.user.updateMany({
      where: { id, renameChipDismissedAt: null },
      data: { renameChipDismissedAt: dismissedAt },
    });
    await invalidateAuthMe(id);
    return prisma.user.findUnique({ where: { id } });
  },

  // Batch 2026-08-10 item 1 — the seeded-race prune's auto-enroll flip. The
  // ONLY writer of auto_join_featured_races outside the user's own toggle, and
  // it lives here rather than as a raw updateMany in the races module because
  // this model is the /auth/me invalidation chokepoint: the flag is served from
  // the cached payload, so a bypassing write would leave a stale `true` for the
  // cache TTL.
  //
  // Guarded updateMany (only rows still true) so a repeat cron pass writes
  // nothing, and so an account that re-enabled the toggle between the read and
  // the write is never silently flipped back. Returns the ids it turned off,
  // for the caller's capped observability log.
  async disableAutoJoinFeaturedRaces(userIds, { prisma: client = prisma } = {}) {
    const ids = [...new Set(userIds || [])];
    if (ids.length === 0) return [];

    const rows = await client.user.findMany({
      where: { id: { in: ids }, autoJoinFeaturedRaces: true },
      select: { id: true },
    });
    if (rows.length === 0) return [];

    const targets = rows.map((row) => row.id);
    const { count } = await client.user.updateMany({
      where: { id: { in: targets }, autoJoinFeaturedRaces: true },
      data: { autoJoinFeaturedRaces: false },
    });
    if (count === 0) return [];

    for (const id of targets) await invalidateAuthMe(id);
    if (count === targets.length) return targets;

    // Someone re-enabled the toggle between the read and the guarded write, so
    // the pre-read list over-reports. Re-read rather than return ids we did not
    // actually turn off — the caller logs this list as the flip batch.
    const flipped = await client.user.findMany({
      where: { id: { in: targets }, autoJoinFeaturedRaces: false },
      select: { id: true },
    });
    return flipped.map((row) => row.id);
  },

  async findCoins(id) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { coins: true },
    });
    return user?.coins ?? 0;
  },

  async getHeldCoins(userId) {
    const result = await prisma.raceParticipant.aggregate({
      where: {
        userId,
        buyInStatus: "HELD",
      },
      _sum: {
        buyInAmount: true,
      },
    });

    return result._sum.buyInAmount || 0;
  },

  // §7 daily-reward reminder scheduler support.
  // The DISTINCT set of IANA zones users are in (a few dozen in practice). Used
  // to decide which zones are currently at a reminder slot WITHOUT computing Intl
  // per user row — we compute local time only for these zones, then query the
  // users in the qualifying ones. Uses the users_timezone index.
  async distinctTimezones() {
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT timezone FROM users WHERE timezone IS NOT NULL`;
    return rows.map((r) => r.timezone).filter(Boolean);
  },

  // Users in the given zones who have NOT opted out of daily-reward reminders.
  // Lean select: everything the send decision needs (no hot columns). When
  // `includeNull` is true (only for the America/New_York default bucket), users
  // with NO recorded timezone are also matched — they fall back to the default
  // zone (§7). Old rows with a null timezone therefore still get reminded at NY
  // local time until their real zone is captured.
  async findRemindableInZones(zones, { includeNull = false } = {}) {
    if ((!zones || zones.length === 0) && !includeNull) return [];
    const timezoneClause = includeNull
      ? { OR: [{ timezone: { in: zones || [] } }, { timezone: null }] }
      : { timezone: { in: zones } };
    return prisma.user.findMany({
      where: {
        dailyRewardRemindersEnabled: true,
        ...timezoneClause,
      },
      select: { id: true, timezone: true, lastDailyClaimDate: true },
    });
  },

  // Batch 2026-08-08 item 3 — step-milestone evening reminder eligibility.
  //
  // ONE set-based query per zone (not N per-user round trips):
  //   * opted in to THIS reminder (findRemindableInZones hardcodes the
  //     daily-reward pref, so it cannot be reused),
  //   * has at least one device token (EXISTS, not a per-user fetch loop),
  //   * has a steps row for the zone's local date at/above the first threshold,
  //   * crossed more thresholds than they have claimed for that date, and
  //   * has NO claim for localDate-1 / localDate / localDate+1 (bias to
  //     silence: the client's claim date is device wall-clock and can disagree
  //     with the server's tz-derived date by a day near midnight).
  //
  // TYPE TRAP: steps.date is a Postgres DATE while step_milestone_claims
  // .claimed_date is TEXT. Both are driven from the SAME 'YYYY-MM-DD' string,
  // with an explicit ::date cast on the steps side only.
  async findStepMilestoneRemindable(
    zone,
    localDate,
    { includeNull = false, thresholds = [] } = {}
  ) {
    if (!thresholds.length) return [];
    const sorted = [...thresholds].sort((a, b) => a - b);
    const minThreshold = sorted[0];
    const prevDate = addDaysToDateString(localDate, -1);
    const nextDate = addDaysToDateString(localDate, 1);

    const rows = await prisma.$queryRaw`
      SELECT u.id
      FROM users u
      JOIN steps s
        ON s.user_id = u.id
       AND s.date = ${localDate}::date
      WHERE u.step_milestone_reminders_enabled = true
        AND (
          u.timezone = ${zone}
          OR (${includeNull}::boolean AND u.timezone IS NULL)
        )
        AND s.steps >= ${minThreshold}
        AND EXISTS (
          SELECT 1 FROM device_tokens d WHERE d.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM step_milestone_claims c
          WHERE c.user_id = u.id
            AND c.claimed_date IN (${prevDate}, ${localDate}, ${nextDate})
        )
        AND (
          SELECT count(*) FROM unnest(${sorted}::int[]) AS t(threshold)
          WHERE s.steps >= t.threshold
        ) > (
          SELECT count(*) FROM step_milestone_claims c2
          WHERE c2.user_id = u.id AND c2.claimed_date = ${localDate}
        )`;
    return rows.map((r) => ({ id: r.id }));
  },

  async findByDisplayNameInsensitive(displayName, excludeUserId) {
    return prisma.user.findFirst({
      where: {
        displayName: { equals: displayName, mode: "insensitive" },
        id: { not: excludeUserId },
      },
    });
  },

  async searchByDisplayName(query, excludeUserId) {
    return prisma.user.findMany({
      where: {
        displayName: { contains: query, mode: "insensitive" },
        id: { not: excludeUserId },
        NOT: { displayName: null },
        // Hide review/demo accounts from real users' friend search.
        isReviewAccount: false,
      },
      select: { id: true, displayName: true, profilePhotoUrl: true },
      take: 20,
    });
  },
};

module.exports = { User, MAX_RENAME_CHIP_SHOWN_COUNT };
