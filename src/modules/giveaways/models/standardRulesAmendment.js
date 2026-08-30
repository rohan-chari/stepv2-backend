const { adminContest } = require("./contest");
const { getContestStandings } = require("../queries/getContestStandings");

function buildStandardRulesAmendmentModel() {
  async function lockContest(tx, contestId) {
    await tx.$queryRaw`
      SELECT id FROM giveaway_contests WHERE id = ${contestId} FOR UPDATE
    `;
    return tx.giveawayContest.findUnique({ where: { id: contestId } });
  }

  async function replaceRules(tx, {
    contestId,
    revision,
    rulesVersion,
    rulesHash,
    rulesSections,
  }) {
    const changed = await tx.giveawayContest.updateMany({
      where: { id: contestId, revision },
      data: {
        rulesVersion,
        rulesHash,
        rulesSections,
        revision: { increment: 1 },
      },
    });
    if (changed.count !== 1) return null;
    return tx.giveawayContest.findUnique({ where: { id: contestId } });
  }

  async function fullAdminResponse(tx, contest, now) {
    const [entrants, rankedResults, standings] = await Promise.all([
      tx.giveawayEntrant.count({ where: { contestId: contest.id } }),
      tx.giveawayResult.count({ where: { entrant: { contestId: contest.id } } }),
      getContestStandings(contest, { db: tx }),
    ]);
    return adminContest(contest, now, {
      entrants,
      rankedResults,
      reviewableFacts: standings.reduce(
        (sum, row) => sum + Number(row.reviewableCount || 0),
        0,
      ),
    });
  }

  async function createAudit(tx, data) {
    return tx.giveawayAuditEvent.create({ data });
  }

  return {
    createAudit,
    fullAdminResponse,
    lockContest,
    replaceRules,
  };
}

module.exports = { buildStandardRulesAmendmentModel };
