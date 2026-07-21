const assert = require("node:assert/strict");
const test = require("node:test");

const {
  summarizeWeekRows,
  rankCohortMembers,
  chunkIntoCohorts,
  normalizeTier,
  placeNewParticipants,
} = require("../../src/modules/ranked/services/rankedCohorts");
const {
  zoneSizes,
  placementReward,
  nextTierUp,
  nextTierDown,
  COHORT_TARGET_SIZE,
} = require("../../src/modules/ranked/constants/rankedCohorts");

// In-memory fakes for the cohort models, enough to exercise placeNewParticipants.
function makeFakeModels({ cohorts = [], members = [] } = {}) {
  let cSeq = cohorts.length;
  let mSeq = members.length;
  const cohortStore = cohorts.map((c) => ({ ...c }));
  const memberStore = members.map((m) => ({ ...m }));

  const RankedCohort = {
    async create({ weekId, tier }) {
      const c = { id: `c${++cSeq}`, weekId, tier };
      cohortStore.push(c);
      return c;
    },
    async listForWeek(weekId, { tier } = {}) {
      return cohortStore
        .filter((c) => c.weekId === weekId && (!tier || c.tier === tier))
        .map((c) => ({
          ...c,
          _count: { members: memberStore.filter((m) => m.cohortId === c.id).length },
        }));
    },
  };

  const RankedCohortMember = {
    async createMany(rows) {
      for (const r of rows) {
        memberStore.push({ id: `m${++mSeq}`, provisionalRank: null, weeklySteps: 0, ...r });
      }
      return { count: rows.length };
    },
    async reassignCohort({ id, cohortId }) {
      const m = memberStore.find((x) => x.id === id);
      if (m) m.cohortId = cohortId;
      return m;
    },
    async listForWeek(weekId) {
      return memberStore.filter((m) => m.weekId === weekId);
    },
  };

  // Helper: sizes per tier, sorted ascending.
  function sizesByTier(tier) {
    return cohortStore
      .filter((c) => c.tier === tier)
      .map((c) => memberStore.filter((m) => m.cohortId === c.id).length)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }

  return { RankedCohort, RankedCohortMember, cohortStore, memberStore, sizesByTier };
}

function seedTier({ weekId, cohortId, tier, count, startIndex = 0, baseSteps = 1000 }) {
  const members = [];
  for (let i = 0; i < count; i++) {
    const n = startIndex + i;
    members.push({
      id: `m-${tier}-${n}`,
      weekId,
      cohortId,
      userId: `u${String(n).padStart(2, "0")}`,
      tier,
      weeklySteps: baseSteps + n, // distinct, deterministic
      provisionalRank: null,
    });
  }
  return members;
}

// ── placeNewParticipants: early-week tier rebalance ──────────────────────────

test("placeNewParticipants rebalances a lopsided tier within the early-week window (37 -> 19/18)", async () => {
  const weekId = "wk1";
  const startsOn = new Date("2026-06-08T00:00:00Z");
  // One seeded Bronze cohort of 30 (the rollover seed).
  const seeded = seedTier({ weekId, cohortId: "c1", tier: "BRONZE", count: 30 });
  const { RankedCohort, RankedCohortMember, sizesByTier } = makeFakeModels({
    cohorts: [{ id: "c1", weekId, tier: "BRONZE" }],
    members: seeded,
  });

  // 7 mid-rollover newcomers, all Bronze, all active this week.
  const totalsByUser = new Map();
  for (const m of seeded) totalsByUser.set(m.userId, { weeklySteps: m.weeklySteps, activeDays: 5 });
  for (let i = 30; i < 37; i++) totalsByUser.set(`u${i}`, { weeklySteps: 2000 + i, activeDays: 5 });

  const placed = await placeNewParticipants({
    week: { id: weekId, startsOn },
    totalsByUser,
    existingMembers: seeded,
    RankedCohort,
    RankedCohortMember,
    getUserTiers: async (ids) => new Map(ids.map((id) => [id, "BRONZE"])),
    now: new Date("2026-06-08T06:00:00Z"), // 6h into the week — within rebalance window
  });

  assert.equal(placed.length, 7, "all 7 newcomers are placed");
  const sizes = sizesByTier("BRONZE");
  assert.deepEqual(sizes, [18, 19], "37 Bronze players balance into 18 + 19, not 35 + 2");
});

test("placeNewParticipants does NOT reshuffle existing members outside the rebalance window", async () => {
  const weekId = "wk2";
  const startsOn = new Date("2026-06-08T00:00:00Z");
  const seeded = seedTier({ weekId, cohortId: "c1", tier: "BRONZE", count: 30 });
  const { RankedCohort, RankedCohortMember, memberStore } = makeFakeModels({
    cohorts: [{ id: "c1", weekId, tier: "BRONZE" }],
    members: seeded,
  });

  const totalsByUser = new Map();
  for (const m of seeded) totalsByUser.set(m.userId, { weeklySteps: m.weeklySteps, activeDays: 5 });
  for (let i = 30; i < 37; i++) totalsByUser.set(`u${i}`, { weeklySteps: 2000 + i, activeDays: 5 });

  const placed = await placeNewParticipants({
    week: { id: weekId, startsOn },
    totalsByUser,
    existingMembers: seeded,
    RankedCohort,
    RankedCohortMember,
    getUserTiers: async (ids) => new Map(ids.map((id) => [id, "BRONZE"])),
    now: new Date("2026-06-11T00:00:00Z"), // 3 days in — past the rebalance window
  });

  assert.equal(placed.length, 7, "newcomers still get placed late-week");
  // None of the original 30 were moved out of c1.
  const movedOriginals = seeded.filter((s) => {
    const cur = memberStore.find((m) => m.id === s.id);
    return cur.cohortId !== "c1";
  });
  assert.equal(movedOriginals.length, 0, "existing members keep their cohort late-week");
});

test("placeNewParticipants opens a cohort for a tier that has none yet", async () => {
  const weekId = "wk3";
  const startsOn = new Date("2026-06-08T00:00:00Z");
  const { RankedCohort, RankedCohortMember, sizesByTier } = makeFakeModels();

  const totalsByUser = new Map([["uA", { weeklySteps: 5000, activeDays: 5 }]]);
  const placed = await placeNewParticipants({
    week: { id: weekId, startsOn },
    totalsByUser,
    existingMembers: [],
    RankedCohort,
    RankedCohortMember,
    getUserTiers: async () => new Map([["uA", "SILVER"]]),
    now: new Date("2026-06-08T03:00:00Z"),
  });

  assert.equal(placed.length, 1);
  assert.deepEqual(sizesByTier("SILVER"), [1]);
});

// ── summarizeWeekRows ────────────────────────────────────────────────────────

test("summarizeWeekRows totals steps and counts active days at the 5k floor", () => {
  const rows = [
    { userId: "a", date: new Date("2026-06-01"), steps: 6000 },
    { userId: "a", date: new Date("2026-06-02"), steps: 4999 },
    { userId: "a", date: new Date("2026-06-03"), steps: 5000 },
    { userId: "b", date: new Date("2026-06-01"), steps: 1000 },
  ];
  const totals = summarizeWeekRows(rows);
  assert.deepEqual(totals.get("a"), { weeklySteps: 15999, activeDays: 2 });
  assert.deepEqual(totals.get("b"), { weeklySteps: 1000, activeDays: 0 });
});

test("summarizeWeekRows tolerates null/zero steps", () => {
  const totals = summarizeWeekRows([{ userId: "a", date: new Date(), steps: null }]);
  assert.deepEqual(totals.get("a"), { weeklySteps: 0, activeDays: 0 });
});

// ── rankCohortMembers ────────────────────────────────────────────────────────

test("rankCohortMembers sorts steps desc with deterministic userId tiebreak", () => {
  const members = [
    { id: "m1", userId: "zed" },
    { id: "m2", userId: "amy" },
    { id: "m3", userId: "bob" },
  ];
  const totals = new Map([
    ["zed", { weeklySteps: 100, activeDays: 1 }],
    ["amy", { weeklySteps: 100, activeDays: 1 }],
    ["bob", { weeklySteps: 500, activeDays: 1 }],
  ]);
  const ranked = rankCohortMembers(members, totals);
  assert.deepEqual(
    ranked.map((m) => [m.rank, m.userId]),
    [
      [1, "bob"],
      [2, "amy"], // tie at 100 → userId asc
      [3, "zed"],
    ]
  );
});

test("rankCohortMembers gives members without step rows 0 steps", () => {
  const ranked = rankCohortMembers([{ id: "m1", userId: "ghost" }], new Map());
  assert.equal(ranked[0].weeklySteps, 0);
  assert.equal(ranked[0].activeDays, 0);
  assert.equal(ranked[0].rank, 1);
});

// ── chunkIntoCohorts ─────────────────────────────────────────────────────────

test("chunkIntoCohorts splits into balanced ~30 person groups", () => {
  const ids = Array.from({ length: 70 }, (_, i) => `u${i}`);
  const chunks = chunkIntoCohorts(ids, COHORT_TARGET_SIZE);
  assert.equal(chunks.length, 3); // ceil(70/30)
  const sizes = chunks.map((c) => c.length);
  assert.deepEqual(sizes, [24, 23, 23]); // balanced, max diff 1
  assert.equal(sizes.reduce((a, b) => a + b, 0), 70);
});

test("chunkIntoCohorts keeps input order (step-matching)", () => {
  const chunks = chunkIntoCohorts(["a", "b", "c", "d"], 2);
  assert.deepEqual(chunks, [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("chunkIntoCohorts handles fewer users than one cohort", () => {
  assert.deepEqual(chunkIntoCohorts(["a", "b"], 30), [["a", "b"]]);
  assert.deepEqual(chunkIntoCohorts([], 30), []);
});

// ── tiers, zones, rewards ────────────────────────────────────────────────────

test("normalizeTier maps unknown/null tiers to BRONZE", () => {
  assert.equal(normalizeTier(null), "BRONZE");
  assert.equal(normalizeTier("DIAMOND"), "DIAMOND");
  assert.equal(normalizeTier("WOOD"), "BRONZE");
});

test("zoneSizes: full cohort promotes/demotes 7; Bronze never demotes; Legend never promotes", () => {
  assert.deepEqual(zoneSizes(30, "GOLD"), { promote: 7, demote: 7 });
  assert.deepEqual(zoneSizes(30, "BRONZE"), { promote: 7, demote: 0 });
  assert.deepEqual(zoneSizes(30, "LEGEND"), { promote: 0, demote: 7 });
});

test("zoneSizes scale proportionally for small cohorts and never overlap", () => {
  const { promote, demote } = zoneSizes(12, "SILVER");
  assert.equal(promote, 3);
  assert.equal(demote, 3);
  for (let n = 1; n <= 40; n++) {
    const z = zoneSizes(n, "GOLD");
    assert.ok(z.promote + z.demote <= n, `overlap at n=${n}`);
  }
});

test("placementReward pays the approved base table for a full Bronze cohort", () => {
  assert.equal(placementReward(1, 30, "BRONZE"), 200);
  assert.equal(placementReward(2, 30, "BRONZE"), 150);
  assert.equal(placementReward(3, 30, "BRONZE"), 120);
  assert.equal(placementReward(7, 30, "BRONZE"), 80); // promotion zone
  assert.equal(placementReward(10, 30, "BRONZE"), 40); // upper hold
  assert.equal(placementReward(20, 30, "BRONZE"), 20); // lower hold
  // Bronze has no demotion zone, so its bottom ranks are lower hold (paid 20),
  // not a 0-pay demotion zone.
  assert.equal(placementReward(30, 30, "BRONZE"), 20);
});

test("placementReward pays 0 to the demotion zone where one exists (base table)", () => {
  // Silver multiplier is 1.25: 80*1.25=100, 20*1.25=25.
  assert.equal(placementReward(7, 30, "SILVER"), 100); // promotion zone
  assert.equal(placementReward(24, 30, "SILVER"), 0); // demotion zone starts
  assert.equal(placementReward(30, 30, "SILVER"), 0);
});

test("placementReward applies the tier multiplier rounded to 5", () => {
  assert.equal(placementReward(1, 30, "LEGEND"), 600); // 200 * 3.0
  assert.equal(placementReward(10, 30, "GOLD"), 60); // 40 * 1.5
  assert.equal(placementReward(2, 30, "SILVER"), 190); // 150 * 1.25 = 187.5 → 190
});

test("placementReward never pays the demotion zone in any tier or size", () => {
  for (const tier of ["BRONZE", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "LEGEND"]) {
    for (const size of [5, 12, 30, 35]) {
      const { demote } = zoneSizes(size, tier);
      for (let r = size - demote + 1; r <= size; r++) {
        assert.equal(placementReward(r, size, tier), 0, `${tier} ${r}/${size}`);
      }
    }
  }
});

test("nextTierUp/nextTierDown clamp at the ladder ends", () => {
  assert.equal(nextTierUp("GOLD"), "PLATINUM");
  assert.equal(nextTierUp("LEGEND"), "LEGEND");
  assert.equal(nextTierDown("SILVER"), "BRONZE");
  assert.equal(nextTierDown("BRONZE"), "BRONZE");
});
