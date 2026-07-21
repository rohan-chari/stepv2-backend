const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetAdminStats } = require("../../src/modules/admin/getAdminStats");

test("admin stats group 7/30/90-day activation totals by version and platform", async () => {
  const prisma = {
    async $queryRaw(strings) {
      const sql = strings.join(" ");
      if (sql.includes("FROM activation_events")) {
        return [
          {
            app_version: "2.0.0",
            platform: "ios",
            name: "onboarding_started",
            count_7d: 4n,
            count_30d: 7n,
            count_90d: 9n,
          },
          {
            app_version: "2.0.0",
            platform: "ios",
            name: "daily_opened",
            count_7d: 3n,
            count_30d: 5n,
            count_90d: 6n,
          },
        ];
      }
      return [];
    },
  };
  const stats = await buildGetAdminStats({ prisma })();
  assert.deepEqual(stats.activationFunnel.last7Days, [
    {
      appVersion: "2.0.0",
      platform: "ios",
      total: 7,
      events: { onboarding_started: 4, daily_opened: 3 },
    },
  ]);
  assert.equal(stats.activationFunnel.last30Days[0].total, 12);
  assert.equal(stats.activationFunnel.last90Days[0].total, 15);
});
