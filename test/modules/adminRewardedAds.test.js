const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetAdminStats } = require("../../src/modules/admin/getAdminStats");

test("admin stats reports distinct rewarded-ad watchers as integer percentages of DAU", async () => {
  const prisma = { async $queryRaw(strings) {
    const sql = strings.join(" ");
    if (sql.includes("FROM ad_reward_grants")) return [{ coin_watchers: 18n, extra_spin_watchers: 9n, box_reroll_watchers: 6n }];
    if (sql.includes("dau_in_active_race")) return [{ dau: 120n, dau_in_active_race: 0n }];
    if (sql.includes("FROM users`")) return [{ total: 0n, new_7d: 0n, new_30d: 0n }];
    if (sql.includes("avg_box_openers")) return [{ avg_box_openers: null }];
    if (sql.includes("team_created_total")) return [{}];
    if (sql.includes("link_opens_total")) return [{}];
    return [];
  } };
  const stats = await buildGetAdminStats({ prisma })();
  assert.deepEqual(stats.activity.rewardedAds, {
    timeZone: "America/New_York",
    coinReward: { uniqueDauWatchers: 18, pctOfDau: 15 },
    extraSpin: { uniqueDauWatchers: 9, pctOfDau: 8 },
    boxReroll: { uniqueDauWatchers: 6, pctOfDau: 5 },
  });
});
