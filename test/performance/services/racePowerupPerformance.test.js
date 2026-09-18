const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readPerformanceFlags,
} = require("../../src/shared/config/performanceFlags");
const {
  buildRepairRacePowerupInventory,
} = require("../../src/modules/races/services/racePowerupInventoryRepair");
const {
  buildGetSneakySwapTargets,
} = require("../../src/modules/races/queries/getSneakySwapTargets");
const {
  lockPowerupUseParticipants,
} = require("../../src/modules/powerups/commands/usePowerup");

test("Pinecone use locks only its caster while other powerups retain the cohort lock", async () => {
  const queries = [];
  const tx = {
    async $queryRaw(strings) {
      const query = strings.join("?");
      queries.push(query);
      if (/race_powerups/i.test(query)) {
        return [{ participant_id: "caster-row", type: "PINECONE_TOSS" }];
      }
      return [];
    },
  };

  await lockPowerupUseParticipants(tx, { raceId: "race-1", powerupId: "power-1" });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /WHERE id/);
  assert.doesNotMatch(queries[1], /race_id/);
  assert.match(queries[1], /FOR UPDATE/);

  queries.length = 0;
  tx.$queryRaw = async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    if (/race_powerups/i.test(query)) {
      return [{ participant_id: "caster-row", type: "SNEAKY_SWAP" }];
    }
    return [];
  };
  await lockPowerupUseParticipants(tx, { raceId: "race-1", powerupId: "power-2" });
  assert.match(queries[1], /race_id/);
  assert.match(queries[1], /status = 'accepted'/i);
  assert.match(queries[1], /ORDER BY user_id ASC/);
  assert.match(queries[1], /FOR UPDATE/);
});

test("performance rollout paths are permanent while concurrency is clamped", () => {
  const dark = readPerformanceFlags({});
  assert.equal(dark.placementDistributedClaimEnabled, true);
  assert.equal(dark.placementLeanBaselineWritesEnabled, true);
  assert.equal(dark.placementInertPushSuppressionEnabled, true);
  assert.equal(dark.stepSyncBulkEnabled, true);
  assert.equal(dark.apnsSessionReuseEnabled, true);
  assert.equal(dark.placementBaselineWriteConcurrency, 4);
  assert.equal(dark.stepSyncPushConcurrency, 8);

  const enabled = readPerformanceFlags({
    PLACEMENT_DISTRIBUTED_CLAIM_ENABLED: "true",
    PLACEMENT_LEAN_BASELINE_WRITES_ENABLED: "TRUE",
    PLACEMENT_BASELINE_WRITE_CONCURRENCY: "99",
    STEP_SYNC_PUSH_CONCURRENCY: "0",
  });
  assert.equal(enabled.placementDistributedClaimEnabled, true);
  assert.equal(enabled.placementLeanBaselineWritesEnabled, true);
  assert.equal(enabled.placementBaselineWriteConcurrency, 8);
  assert.equal(enabled.stepSyncPushConcurrency, 1);
});

test("narrow inventory repair applies exact gates before any inventory reads", async () => {
  let occupiedReads = 0;
  let repairs = 0;
  const repair = buildRepairRacePowerupInventory({
    RaceParticipant: {
      async updateMaxBonusSteps() { repairs += 1; },
    },
    RacePowerup: {
      async countOccupiedSlots() { occupiedReads += 1; return 0; },
      async findQueuedByParticipant() { return []; },
      async countQueuedByParticipant() { return 0; },
      async update() {},
    },
  });

  const participant = {
    id: "p1",
    userId: "u1",
    status: "ACCEPTED",
    powerupSlots: 3,
    bonusSteps: 10,
    maxBonusSteps: 0,
  };
  const blockedRaces = [
    { status: "PENDING", powerupsEnabled: true, powerupStepInterval: 100 },
    { status: "ACTIVE", powerupsEnabled: false, powerupStepInterval: 100 },
    { status: "ACTIVE", powerupsEnabled: true, powerupStepInterval: null },
    { status: "ACTIVE", powerupsEnabled: true, powerupStepInterval: 0 },
  ];
  for (const race of blockedRaces) {
    await repair({ race, participant });
  }
  await repair({
    race: { status: "ACTIVE", powerupsEnabled: true, powerupStepInterval: 100 },
    participant: { ...participant, status: "DECLINED" },
  });
  assert.equal(occupiedReads, 0);
  assert.equal(repairs, 0);
});

test("narrow inventory repair heals bonus high-water and promotes oldest queued rows", async () => {
  const promoted = [];
  let maxBonus;
  const repair = buildRepairRacePowerupInventory({
    RaceParticipant: {
      async updateMaxBonusSteps(_id, value) { maxBonus = value; },
    },
    RacePowerup: {
      async countOccupiedSlots() { return 1; },
      async findQueuedByParticipant() { return [{ id: "old" }, { id: "new" }, { id: "later" }]; },
      async countQueuedByParticipant() { return 1; },
      async update(id, fields) { promoted.push([id, fields.status]); },
    },
  });
  const result = await repair({
    race: { status: "ACTIVE", powerupsEnabled: true, powerupStepInterval: 100 },
    participant: {
      id: "p1",
      userId: "u1",
      status: "ACCEPTED",
      powerupSlots: 3,
      bonusSteps: 50,
      maxBonusSteps: 10,
    },
  });
  assert.equal(maxBonus, 50);
  assert.deepEqual(promoted, [["old", "MYSTERY_BOX"], ["new", "MYSTERY_BOX"]]);
  assert.equal(result.queuedBoxCount, 1);
});

test("Sneaky target work stays two bulk reads as candidate count grows", async () => {
  async function run(candidateCount) {
    const calls = { effects: 0, inventory: 0, perCandidate: 0 };
    const participants = [
      { id: "me", userId: "u-me", status: "ACCEPTED", joinedAt: new Date(0), user: { displayName: "Me" } },
      ...Array.from({ length: candidateCount }, (_, index) => ({
        id: `p-${index}`,
        userId: `u-${index}`,
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        joinedAt: new Date(index + 1),
        user: { displayName: `Racer ${index}` },
      })),
    ];
    const getTargets = buildGetSneakySwapTargets({
      Race: {
        async findSneakySwapTargetContext() {
          return { id: "r1", status: "ACTIVE", isTeamRace: false, participants };
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipants() { calls.effects += 1; return []; },
        async findActiveByTypeForParticipant() { calls.perCandidate += 1; return null; },
      },
      RacePowerup: {
        async findInventoryForParticipants(ids) {
          calls.inventory += 1;
          return ids.map((participantId) => ({ participantId, type: "SHORTCUT", status: "HELD" }));
        },
        async findHeldByParticipant() { calls.perCandidate += 1; return []; },
      },
    });
    const result = await getTargets("u-me", "r1");
    assert.equal(result.targets.length, candidateCount);
    return calls;
  }

  assert.deepEqual(await run(10), { effects: 1, inventory: 1, perCandidate: 0 });
  assert.deepEqual(await run(300), { effects: 1, inventory: 1, perCandidate: 0 });
});

test("lean race projections and Trail Mine path structurally exclude cosmetic hydration", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const raceSource = fs.readFileSync(
    path.join(repoRoot, "src/modules/races/models/race.js"),
    "utf8"
  );
  const useSource = fs.readFileSync(
    path.join(repoRoot, "src/modules/powerups/commands/usePowerup.js"),
    "utf8"
  );

  for (const method of [
    "findMysteryBoxContext",
    "findPowerupUseContext",
    "findSneakySwapTargetContext",
    "findForResolution",
    "findPowerupRepairContext",
  ]) {
    assert.match(raceSource, new RegExp(`async ${method}\\(`));
  }
  const leanRegion = raceSource.slice(
    raceSource.indexOf("const mysteryBoxParticipantSelect"),
    raceSource.indexOf("const Race =")
  );
  assert.doesNotMatch(leanRegion, /equippedAccessories|shopItems|participantInclude/);
  assert.match(useSource, /computed\.result\?\.race/);
  assert.match(useSource, /findPowerupUseContext/);
  assert.doesNotMatch(useSource, /await syncRacePowerupState\(/);
});
