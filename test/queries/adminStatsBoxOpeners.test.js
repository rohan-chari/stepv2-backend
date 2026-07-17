const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetAdminStats } = require("../../src/queries/getAdminStats");

// Item 9: admin stats gain activity.avgUniqueBoxOpenersPerDay — the average of
// DISTINCT box openers per ET day, computed in SQL from MYSTERY_BOX_OPENED rows.
// Null when there's no data yet.
function makeFakePrisma({ boxAvg }) {
  return {
    async $queryRaw(strings) {
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes("MYSTERY_BOX_OPENED")) return [{ avg_box_openers: boxAvg }];
      if (sql.includes("FROM users") && sql.includes("new_7d")) return [{ total: 1n, new_7d: 0n, new_30d: 0n }];
      if (sql.includes("dau_in_active_race")) return [{ dau: 0n, dau_in_active_race: 0n }];
      return [];
    },
  };
}

test("avgUniqueBoxOpenersPerDay is rounded to 1 decimal", async () => {
  const stats = await buildGetAdminStats({ prisma: makeFakePrisma({ boxAvg: 12.34 }) })();
  assert.equal(stats.activity.avgUniqueBoxOpenersPerDay, 12.3);
});

test("avgUniqueBoxOpenersPerDay is null when there is no box-open data yet", async () => {
  const stats = await buildGetAdminStats({ prisma: makeFakePrisma({ boxAvg: null }) })();
  assert.equal(stats.activity.avgUniqueBoxOpenersPerDay, null);
});
