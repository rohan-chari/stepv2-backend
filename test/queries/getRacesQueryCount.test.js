const assert = require("node:assert/strict");
const test = require("node:test");

// Proves the Phase B invariant: GET /races issues a BOUNDED number of powerup/
// effect queries independent of the user's active powerup-race count. Growing
// the fixture from 1 to 50 active powerup races must NOT add per-race Detour,
// queued-count, or slot-inventory queries. Same monkey-patch seam the other
// getRaces tests use (getRaces imports the model singletons directly).
function activePowerupRace(id) {
  return {
    id,
    name: `Race ${id}`,
    status: "ACTIVE",
    powerupsEnabled: true,
    maxDurationDays: 7,
    targetSteps: 50000,
    buyInAmount: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    potCoins: 0,
    seedId: null,
    startedAt: new Date(),
    endsAt: null,
    completedAt: null,
    creator: null,
    winner: null,
    creatorId: null,
    isPublic: true,
    maxParticipants: 10,
    createdAt: new Date(),
    isTeamRace: false,
    teamSize: null,
    tournamentId: null,
    participants: [
      { id: `${id}-p1`, userId: "viewer", status: "ACCEPTED", totalSteps: 100, placement: null, finishedAt: null, joinedAt: new Date(), buyInStatus: "NONE", buyInAmount: 0, payoutCoins: 0, resultsSeenAt: null, team: null, forfeitedAt: null },
      { id: `${id}-p2`, userId: "rival", status: "ACCEPTED", totalSteps: 200, placement: null, finishedAt: null, joinedAt: new Date(), buyInStatus: "NONE", buyInAmount: 0, payoutCoins: 0, resultsSeenAt: null, team: null, forfeitedAt: null },
    ],
  };
}

function withMockedModels(races, counters, fn) {
  const raceModule = require("../../src/modules/races/models/race");
  const powerupModule = require("../../src/modules/powerups/models/racePowerup");
  const effectModule = require("../../src/modules/powerups/models/raceActiveEffect");
  const originals = {
    Race: raceModule.Race,
    RacePowerup: powerupModule.RacePowerup,
    RaceActiveEffect: effectModule.RaceActiveEffect,
  };

  Object.assign(raceModule, {
    Race: { async findSummariesForUser() { return races; } },
  });
  Object.assign(powerupModule, {
    RacePowerup: {
      async findInventoryForParticipants(participantIds, statuses) {
        counters.findInventoryForParticipants += 1;
        // one HELD + one MYSTERY_BOX + one QUEUED per participant
        const rows = [];
        for (const pid of participantIds) {
          rows.push({ id: `${pid}-held`, participantId: pid, type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" });
          rows.push({ id: `${pid}-box`, participantId: pid, type: null, rarity: null, status: "MYSTERY_BOX" });
          rows.push({ id: `${pid}-q`, participantId: pid, type: null, rarity: null, status: "QUEUED" });
        }
        return rows.filter((r) => statuses.includes(r.status));
      },
      async findSlotPowerups() { counters.perRace += 1; return []; },
      async countQueuedByParticipant() { counters.perRace += 1; return 0; },
    },
  });
  Object.assign(effectModule, {
    RaceActiveEffect: {
      async findActiveByTypeForParticipants() {
        counters.findActiveByTypeForParticipants += 1;
        return [];
      },
      async findActiveByTypeForParticipant() { counters.perRace += 1; return null; },
    },
  });

  try {
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
    return fn(require("../../src/modules/races/queries/getRaces"));
  } finally {
    Object.assign(raceModule, { Race: originals.Race });
    Object.assign(powerupModule, { RacePowerup: originals.RacePowerup });
    Object.assign(effectModule, { RaceActiveEffect: originals.RaceActiveEffect });
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
  }
}

async function runWith(count) {
  const races = Array.from({ length: count }, (_, i) => activePowerupRace(`r${i}`));
  const counters = {
    findInventoryForParticipants: 0,
    findActiveByTypeForParticipants: 0,
    perRace: 0,
  };
  const result = await withMockedModels(races, counters, ({ getRaces }) => getRaces("viewer", false));
  return { counters, result };
}

test("bulk effect/inventory query count is constant for 1 vs 50 active powerup races", async () => {
  const one = await runWith(1);
  const fifty = await runWith(50);

  // Exactly one bulk Detour query and one bulk inventory query, regardless of N.
  assert.equal(one.counters.findInventoryForParticipants, 1);
  assert.equal(one.counters.findActiveByTypeForParticipants, 1);
  assert.equal(fifty.counters.findInventoryForParticipants, 1);
  assert.equal(fifty.counters.findActiveByTypeForParticipants, 1);

  // No per-race Detour/queue/slot query ran on the production (bulk) path.
  assert.equal(one.counters.perRace, 0);
  assert.equal(fifty.counters.perRace, 0);

  // Sanity: all 50 races serialized into the active bucket with derived inventory.
  assert.equal(fifty.result.active.length, 50);
  const sample = fifty.result.active[0];
  assert.equal(sample.queuedBoxCount, 1);
  assert.equal(sample.mysteryBoxCount, 1);
  assert.equal(sample.slotItems.length, 2); // HELD + MYSTERY_BOX
});

test("legacy mixed lists keep projected active races out of the SQL ranker", async () => {
  const raceModule = require("../../src/modules/races/models/race");
  const participantModule = require("../../src/modules/races/models/raceParticipant");
  const originals = { Race: raceModule.Race, RaceParticipant: participantModule.RaceParticipant };
  const active = {
    ...activePowerupRace("active-large"),
    powerupsEnabled: false,
    _viewerParticipant: activePowerupRace("active-large").participants[0],
  };
  active._viewerParticipant.raceId = active.id;
  const completed = {
    ...activePowerupRace("completed-small"),
    status: "COMPLETED",
    powerupsEnabled: false,
    completedAt: new Date(),
  };
  const rankedRaceIds = [];
  Object.assign(raceModule, { Race: {
    async findBoundedRaceListForUser() { return [active, completed]; },
    async findRaceListStableForUser() { throw new Error("bounded list should be used"); },
    async findSqlSummariesForUser(_userId, _extraIds, { stableRaces }) {
      rankedRaceIds.push(stableRaces.map((race) => race.id));
      return { ambiguousFinisherOrder: false, races: stableRaces };
    },
  } });
  Object.assign(participantModule, { RaceParticipant: {
    async findViewerRowsForRaces() { throw new Error("embedded viewer should be used"); },
  } });
  try {
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
    const { getRaces } = require("../../src/modules/races/queries/getRaces");
    const result = await getRaces("viewer", false, {
      raceListCacheEnabled: true,
      compactRaceList: false,
      raceListCache: {
        isEnabled: () => true,
        async getStableMembership() {
          return { races: [active, completed], source: "redis" };
        },
      },
      raceProgressPageProjection: {
        async readRaceProgressPageProjection({ raceId }) {
          assert.equal(raceId, active.id);
          return {
            total: 2, asOf: new Date().toISOString(), requesterRow: { placement: 2 },
            rows: [{ participantId: `${active.id}-p2`, userId: "rival", placement: 1, totalSteps: 200 }],
          };
        },
      },
    });

    assert.deepEqual(rankedRaceIds, [[completed.id]]);
    assert.equal(result.active[0].id, active.id);
    assert.equal(result.completed[0].id, completed.id);
  } finally {
    Object.assign(raceModule, { Race: originals.Race });
    Object.assign(participantModule, { RaceParticipant: originals.RaceParticipant });
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
  }
});

test("compact bounded lists reuse the stable membership cache", async () => {
  const raceModule = require("../../src/modules/races/models/race");
  const participantModule = require("../../src/modules/races/models/raceParticipant");
  const { projectStableRaces } = require("../../src/modules/races/services/raceListCache");
  const originals = { Race: raceModule.Race, RaceParticipant: participantModule.RaceParticipant };
  const active = {
    ...activePowerupRace("active-large"),
    powerupsEnabled: false,
    _viewerParticipant: activePowerupRace("active-large").participants[0],
  };
  active._viewerParticipant.raceId = active.id;
  const completed = {
    ...activePowerupRace("completed-small"),
    status: "COMPLETED",
    powerupsEnabled: false,
    completedAt: new Date(),
  };
  let boundedLoads = 0;
  let cachedRaces = null;
  Object.assign(raceModule, { Race: {
    async findBoundedRaceListForUser() {
      boundedLoads += 1;
      return [active, completed];
    },
    async findRaceListStableForUser() { throw new Error("bounded list should be used"); },
    async findSqlSummariesForUser(_userId, _extraIds, { stableRaces }) {
      return {
        ambiguousFinisherOrder: false,
        races: stableRaces.map((race) => race.id === completed.id ? completed : race),
      };
    },
  } });
  Object.assign(participantModule, { RaceParticipant: {
    async findViewerRowsForRaces() { return [active._viewerParticipant]; },
  } });
  try {
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
    const { getRaces } = require("../../src/modules/races/queries/getRaces");
    const options = {
      raceListCacheEnabled: true,
      compactRaceList: true,
      raceListCache: {
        isEnabled: () => true,
        async getStableMembership({ load }) {
          if (cachedRaces) return { races: cachedRaces, source: "redis" };
          cachedRaces = projectStableRaces(await load());
          return { races: cachedRaces, source: "postgres" };
        },
      },
      raceProgressPageProjection: {
        async readRaceProgressPageProjection({ raceId }) {
          return {
            total: 2, asOf: new Date().toISOString(), requesterRow: { placement: 2 },
            rows: [{ participantId: `${raceId}-p2`, userId: "rival", placement: 1,
              totalSteps: 200 }],
          };
        },
      },
    };
    const cold = await getRaces("viewer", false, options);
    const hit = await getRaces("viewer", false, options);

    assert.equal(boundedLoads, 1);
    assert.deepEqual(hit, cold);
  } finally {
    Object.assign(raceModule, { Race: originals.Race });
    Object.assign(participantModule, { RaceParticipant: originals.RaceParticipant });
    delete require.cache[require.resolve("../../src/modules/races/queries/getRaces")];
  }
});
