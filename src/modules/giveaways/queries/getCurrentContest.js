const { prisma } = require("../../../db");
const { deriveContestStatus } = require("../models/contest");

async function getCurrentContest({ db = prisma, now = new Date() } = {}) {
  const contests = await db.giveawayContest.findMany({
    where: { lifecycleStatus: { in: ["PUBLISHED", "FINAL"] } },
    orderBy: [{ updatedAt: "desc" }],
  });
  const priority = { ACTIVE: 0, VERIFYING: 1, SCHEDULED: 2, FINAL: 3 };
  contests.sort((a, b) => (priority[deriveContestStatus(a, now)] ?? 99) - (priority[deriveContestStatus(b, now)] ?? 99));
  return contests[0] || null;
}

module.exports = { getCurrentContest };
