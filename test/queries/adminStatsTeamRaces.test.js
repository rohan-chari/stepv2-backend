const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetAdminStats } = require("../../src/queries/getAdminStats");

// Team-race adoption counters in the admin stats snapshot (spec §"admin
// adoption counters"): created / completed totals + 7d, so we can watch the
// organic cold start without a launch campaign.
function makeFakePrisma() {
  return {
    async $queryRaw(strings) {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes("is_team_race")) {
        return [
          {
            team_created_total: 12n,
            team_created_7d: 5n,
            team_completed_total: 7n,
            team_completed_7d: 3n,
            team_active_now: 2n,
          },
        ];
      }
      if (sql.includes("FROM users") && sql.includes("new_7d")) {
        return [{ total: 100n, new_7d: 10n, new_30d: 30n }];
      }
      if (sql.includes("dau_in_active_race")) {
        return [{ dau: 20n, dau_in_active_race: 5n }];
      }
      if (sql.includes("bucket")) {
        return [];
      }
      if (sql.includes("d1_cohort")) {
        return [];
      }
      if (sql.includes("link_opens_total")) {
        return [
          {
            link_opens_total: 0n,
            link_opens_7d: 0n,
            referrals_total: 0n,
            referrals_7d: 0n,
            referees_joined_race: 0n,
            referees_finished_race: 0n,
            referrals_rewarded: 0n,
          },
        ];
      }
      return [];
    },
  };
}

test("admin stats include team-race adoption counters", async () => {
  const getAdminStats = buildGetAdminStats({ prisma: makeFakePrisma() });
  const stats = await getAdminStats();
  assert.ok(stats.teamRaces, "teamRaces block present");
  assert.equal(stats.teamRaces.createdTotal, 12);
  assert.equal(stats.teamRaces.createdLast7Days, 5);
  assert.equal(stats.teamRaces.completedTotal, 7);
  assert.equal(stats.teamRaces.completedLast7Days, 3);
  assert.equal(stats.teamRaces.activeNow, 2);
});
