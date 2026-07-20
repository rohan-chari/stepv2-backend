const { prisma } = require("../db");

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

  async create({ appleId, googleSub, email, name, displayName, isReviewAccount }) {
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
    return prisma.user.create({ data });
  },

  async update(id, fields) {
    return prisma.user.update({
      where: { id },
      data: fields,
    });
  },

  // TR-706: persist the user's X-Client-Features tokens (STICKY union — the
  // middleware passes the merged set and calls this ONLY when a new token
  // appeared, so this is never a hot write path). Stamps clientFeaturesAt for
  // observability/debugging.
  async updateClientFeatures(id, features) {
    return prisma.user.update({
      where: { id },
      data: { clientFeatures: features, clientFeaturesAt: new Date() },
    });
  },

  // Sticky-write the user's IANA timezone (§7). Called from requireAuth ONLY
  // when the request carried a real, valid X-Timezone that differs from the
  // stored value — never on every request (mirrors updateClientFeatures; commit
  // 3e6c827's pool-exhaustion lesson). Backs the daily-reward reminder scheduler.
  async updateTimezone(id, timezone) {
    return prisma.user.update({
      where: { id },
      data: { timezone },
    });
  },

  // §9.1: read the user's notification preferences. The column is NOT NULL with a
  // true default, so an absent/never-set preference reads as true.
  async getNotificationPreferences(id) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { dailyRewardRemindersEnabled: true },
    });
    return {
      dailyRewardRemindersEnabled: user?.dailyRewardRemindersEnabled ?? true,
    };
  },

  // §9.1: persist the daily-reward reminder opt-out and return the stored value.
  async setDailyRewardRemindersEnabled(id, enabled) {
    const user = await prisma.user.update({
      where: { id },
      data: { dailyRewardRemindersEnabled: enabled },
      select: { dailyRewardRemindersEnabled: true },
    });
    return { dailyRewardRemindersEnabled: user.dailyRewardRemindersEnabled };
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

module.exports = { User };
