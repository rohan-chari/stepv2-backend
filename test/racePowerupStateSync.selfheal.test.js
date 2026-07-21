// Spec: the box gate must self-heal an UN-ARMED participant (nextBoxAtSteps <= 0)
// — the state every public/featured (seeded daily/weekly challenge) joiner was
// stranded in, because joinPublicRace never initialized nextBoxAtSteps. Arming
// anchors to the next interval boundary STRICTLY ABOVE current box-effective
// steps, so it mints ZERO boxes immediately; boxes are earned only by walking
// forward. An already-armed participant must be untouched and roll normally.
const test = require("node:test");
const assert = require("node:assert");
const {
  buildSyncRacePowerupState,
} = require("../src/modules/races/services/racePowerupStateSync");

function makeParticipant(overrides = {}) {
  return {
    id: "p1",
    userId: "u1",
    status: "ACCEPTED",
    nextBoxAtSteps: 0,
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    powerupSlots: 3,
    user: { displayName: "Sugaroro" },
    ...overrides,
  };
}

function makeRace(participant, overrides = {}) {
  return {
    id: "r1",
    status: "ACTIVE",
    powerupsEnabled: true,
    powerupStepInterval: 2500,
    participants: [participant],
    ...overrides,
  };
}

function makeDeps({ participant, rollResults = [] } = {}) {
  const calls = { updateNextBoxAtSteps: [], rollPowerup: [] };
  const RaceParticipant = {
    updateNextBoxAtSteps: async (id, val) => {
      calls.updateNextBoxAtSteps.push({ id, val });
    },
    updateMaxBonusSteps: async () => {},
  };
  const RacePowerup = {
    countOccupiedSlots: async () => 0,
    findQueuedByParticipant: async () => [],
    countQueuedByParticipant: async () => 0,
    update: async () => {},
  };
  const rollPowerup = async (args) => {
    calls.rollPowerup.push(args);
    return rollResults;
  };
  // Refreshed race re-read after a roll.
  const Race = { findById: async () => makeRace(participant) };
  return { deps: { RaceParticipant, RacePowerup, rollPowerup, Race }, calls };
}

test("self-heals an un-armed (next_box=0) joiner to the next boundary ABOVE box-effective, minting nothing", async () => {
  const participant = makeParticipant({ nextBoxAtSteps: 0, totalSteps: 60029 });
  const { deps, calls } = makeDeps({ participant });
  const sync = buildSyncRacePowerupState(deps);

  const res = await sync({
    raceId: "r1",
    userId: "u1",
    race: makeRace(participant),
    boxEffectiveSteps: 60029,
  });

  assert.equal(calls.updateNextBoxAtSteps.length, 1, "should arm once");
  // (floor(60029/2500)+1)*2500 = 25*2500 = 62500 > 60029  => 0 immediate mint
  assert.equal(calls.updateNextBoxAtSteps[0].val, 62500);
  assert.equal(calls.rollPowerup.length, 0, "arming must not roll a box");
  assert.equal(res.enabled, true);
  assert.deepEqual(res.newMysteryBoxes, []);
});

test("0-mint even when box-effective sits exactly on an interval boundary", async () => {
  const participant = makeParticipant({ nextBoxAtSteps: 0, totalSteps: 10000 });
  const { deps, calls } = makeDeps({ participant });
  const sync = buildSyncRacePowerupState(deps);

  await sync({
    raceId: "r1",
    userId: "u1",
    race: makeRace(participant),
    boxEffectiveSteps: 10000,
  });

  // (floor(10000/2500)+1)*2500 = 5*2500 = 12500, strictly above 10000.
  assert.equal(calls.updateNextBoxAtSteps[0].val, 12500);
  assert.equal(calls.rollPowerup.length, 0);
});

test("an already-armed participant is NOT re-armed and rolls normally", async () => {
  const participant = makeParticipant({ nextBoxAtSteps: 2500, totalSteps: 5000 });
  const { deps, calls } = makeDeps({ participant });
  const sync = buildSyncRacePowerupState(deps);

  await sync({
    raceId: "r1",
    userId: "u1",
    race: makeRace(participant),
    boxEffectiveSteps: 5000,
  });

  assert.equal(
    calls.updateNextBoxAtSteps.length,
    0,
    "self-heal must never touch an armed participant"
  );
  assert.equal(calls.rollPowerup.length, 1, "armed gate should roll");
});

test("inventory-action sync (no boxEffectiveSteps) neither arms nor rolls", async () => {
  const participant = makeParticipant({ nextBoxAtSteps: 0, totalSteps: 60029 });
  const { deps, calls } = makeDeps({ participant });
  const sync = buildSyncRacePowerupState(deps);

  await sync({ raceId: "r1", userId: "u1", race: makeRace(participant) });

  assert.equal(calls.updateNextBoxAtSteps.length, 0);
  assert.equal(calls.rollPowerup.length, 0);
});
