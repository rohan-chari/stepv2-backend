const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGetAdminStats } = require("../../src/modules/admin/getAdminStats");

// Batch 2026-08-09 item 10 — `GET /admin/stats?sections=`.
//
// The LOCKED contract this pins:
//   * no `sections`  -> EXACTLY today's payload, and EXACTLY today's query set.
//     The shipped admin build must not pay for aggregates it cannot render, on
//     a one-vCPU box. This is asserted structurally (query count + absence of
//     the new keys), not by eyeballing the JSON.
//   * sections=economy -> adds `coinEconomy`
//   * sections=ads     -> adds `adRevenue`
// Key names are frontend-visible and must never be renamed.

// A prisma double that records every SQL statement it is asked to run, so a
// test can assert that an unrequested section costs ZERO extra queries.
function makeFakePrisma(handlers = {}) {
  const seen = [];
  return {
    seen,
    async $queryRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join(" ? ") : String(strings);
      seen.push(sql);
      for (const [needle, rows] of Object.entries(handlers)) {
        if (sql.includes(needle)) return rows;
      }
      // Defaults for the always-on blocks so the assembler never throws.
      if (sql.includes("FROM users") && sql.includes("new_7d")) {
        return [{ total: 0n, new_7d: 0n, new_30d: 0n }];
      }
      if (sql.includes("dau_in_active_race")) {
        return [{ dau: 0n, dau_in_active_race: 0n }];
      }
      return [];
    },
  };
}

// The new aggregates each carry a unique SQL comment marker so a test can
// identify them without matching a table name that a legacy query also uses
// (`ad_reward_grants` and `MYSTERY_BOX_OPENED` both already appear above).
const ECONOMY_MARKERS = ["coinLedgerDaily", "purchasesBySku", "boxOpensDaily"];
const AD_MARKERS = ["adWatchesDaily", "adCapUtilization"];

function matching(seen, markers) {
  return seen.filter((sql) => markers.some((m) => sql.includes(m)));
}

function economyMarkers(seen) {
  return matching(seen, ECONOMY_MARKERS);
}

function adMarkers(seen) {
  return matching(seen, AD_MARKERS);
}

test("no sections param: today's payload, and no new keys", async () => {
  const prisma = makeFakePrisma();
  const stats = await buildGetAdminStats({ prisma })();

  // The keys the current admin build reads must all still be there.
  for (const key of [
    "generatedAt",
    "users",
    "activity",
    "friends",
    "retention",
    "teamRaces",
    "referralFunnel",
    "activationFunnel",
    "versions",
    "versionsSince",
    "versionsWindowDays",
    "races",
    "onboardingFunnel",
  ]) {
    assert.ok(key in stats, `legacy key ${key} must still be present`);
  }

  assert.equal("coinEconomy" in stats, false);
  assert.equal("adRevenue" in stats, false);
});

test("no sections param: the new aggregates are not even queried", async () => {
  const prisma = makeFakePrisma();
  await buildGetAdminStats({ prisma })();
  assert.deepEqual(economyMarkers(prisma.seen), []);
  assert.deepEqual(adMarkers(prisma.seen), []);
});

test("the default query set is byte-stable when sections are requested", async () => {
  const base = makeFakePrisma();
  await buildGetAdminStats({ prisma: base })();

  const withSections = makeFakePrisma();
  await buildGetAdminStats({ prisma: withSections })({
    sections: ["economy", "ads"],
  });

  // Every query the legacy call made is still made, unchanged, in order.
  assert.deepEqual(
    withSections.seen.slice(0, base.seen.length),
    base.seen,
    "requesting a section must not alter the default query set"
  );
});

test("sections=economy adds coinEconomy in the locked shape", async () => {
  const prisma = makeFakePrisma({
    coinLedgerDaily: [
      { date: "2026-08-01", minted: 500n, sunk: 300n },
      { date: "2026-08-02", minted: 10n, sunk: 0n },
    ],
    purchasesBySku: [
      { sku: "powerup_leg_cramp", count: 4n, coins: 400n },
      { sku: "hat_cowboy", count: 1n, coins: 250n },
    ],
    boxOpensDaily: [{ date: "2026-08-01", count: 42n }],
  });

  const stats = await buildGetAdminStats({ prisma })({ sections: ["economy"] });

  assert.deepEqual(stats.coinEconomy, {
    windowDays: 30,
    timeZone: "America/New_York",
    days: [
      { date: "2026-08-01", minted: 500, sunk: 300 },
      { date: "2026-08-02", minted: 10, sunk: 0 },
    ],
    purchasesBySku: [
      { sku: "powerup_leg_cramp", count: 4, coins: 400 },
      { sku: "hat_cowboy", count: 1, coins: 250 },
    ],
    boxOpens: [{ date: "2026-08-01", count: 42 }],
  });

  // Not requested -> not computed.
  assert.equal("adRevenue" in stats, false);
  assert.deepEqual(adMarkers(prisma.seen), []);
});

test("sections=ads adds adRevenue in the locked shape", async () => {
  const prisma = makeFakePrisma({
    adWatchesDaily: [
      { date: "2026-08-01", coin_reward_watches: 9n, extra_spin_watches: 3n },
    ],
    adCapUtilization: [{ avg_watches_per_user: 2.25, users_at_cap: 7n }],
  });

  const stats = await buildGetAdminStats({ prisma })({ sections: ["ads"] });

  assert.deepEqual(stats.adRevenue, {
    windowDays: 30,
    timeZone: "America/New_York",
    days: [{ date: "2026-08-01", coinRewardWatches: 9, extraSpinWatches: 3 }],
    capUtilization: { avgWatchesPerUser: 2.3, usersAtCap: 7 },
  });

  assert.equal("coinEconomy" in stats, false);
  assert.deepEqual(economyMarkers(prisma.seen), []);
});

test("ad capUtilization degrades to nulls/zero rather than NaN with no data", async () => {
  const prisma = makeFakePrisma({
    adCapUtilization: [{ avg_watches_per_user: null, users_at_cap: 0n }],
  });
  const stats = await buildGetAdminStats({ prisma })({ sections: ["ads"] });
  assert.deepEqual(stats.adRevenue.capUtilization, {
    avgWatchesPerUser: null,
    usersAtCap: 0,
  });
  assert.deepEqual(stats.adRevenue.days, []);
});

test("both sections can be requested at once", async () => {
  const prisma = makeFakePrisma();
  const stats = await buildGetAdminStats({ prisma })({
    sections: ["economy", "ads"],
  });
  assert.ok("coinEconomy" in stats);
  assert.ok("adRevenue" in stats);
});

test("unknown section names are ignored, not fatal", async () => {
  const prisma = makeFakePrisma();
  const stats = await buildGetAdminStats({ prisma })({
    sections: ["economy", "totally-made-up"],
  });
  assert.ok("coinEconomy" in stats);
  assert.equal("adRevenue" in stats, false);
});

test("every new aggregate is bounded to 30 days", async () => {
  const prisma = makeFakePrisma();
  await buildGetAdminStats({ prisma })({ sections: ["economy", "ads"] });
  const added = [...economyMarkers(prisma.seen), ...adMarkers(prisma.seen)];
  assert.ok(added.length >= 4, "expected the new aggregates to have run");
  for (const sql of added) {
    assert.match(
      sql,
      /interval '30 days'/,
      `unbounded admin aggregate: ${sql.slice(0, 120)}`
    );
  }
});
