const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ===========================================================================
// 7-day multi-user race with all powerup types
// Race: Mar 25–31, 2026 | 7 users | 100k target | powerupsEnabled
// ===========================================================================

const RACE_START = new Date("2026-03-25T13:00:00.000Z"); // 9 AM ET
const NOW        = new Date("2026-03-31T17:00:00.000Z"); // 1 PM ET, Day 7
const TZ         = "America/New_York";

// --- User / participant IDs ------------------------------------------------
const ALICE = "user-alice", RP_ALICE = "rp-alice";
const BOB   = "user-bob",   RP_BOB   = "rp-bob";
const CAROL = "user-carol", RP_CAROL = "rp-carol";
const DAVE  = "user-dave",  RP_DAVE  = "rp-dave";
const EVE   = "user-eve",   RP_EVE   = "rp-eve";
const FRANK = "user-frank", RP_FRANK = "rp-frank";
const GRACE = "user-grace", RP_GRACE = "rp-grace";

// --- Sample generation helper ----------------------------------------------
function hourly(userId, date, startHour, stepsArr) {
  return stepsArr.map((steps, i) => ({
    userId,
    periodStart: `${date}T${String(startHour + i).padStart(2, "0")}:00:00.000Z`,
    periodEnd:   `${date}T${String(startHour + i + 1).padStart(2, "0")}:00:00.000Z`,
    steps,
  }));
}

// --- Step samples: 7 users × 7 days ---------------------------------------
// Day 1 starts at race start (13:00 UTC).  Days 2–7 have samples 10:00–19:00.
// Day 7 ends at NOW (17:00 UTC), so samples cover 10:00–16:00 (7 hours).
//
// Raw totals (sum of all samples, no effects):
//   Alice: 16,600 | Bob: 14,500 | Carol: 16,200 | Dave: 14,600
//   Eve:   16,200 | Frank: 15,500 | Grace: 14,000
const SAMPLES = [
  // ---- Alice (16,600) ----
  ...hourly(ALICE, "2026-03-25", 13, [300, 300, 250, 300, 250, 300, 300]),          // D1: 2000
  ...hourly(ALICE, "2026-03-26", 10, [200, 250, 250, 300, 250, 250, 250, 250, 250, 250]), // D2: 2500
  ...hourly(ALICE, "2026-03-27", 10, [300, 300, 300, 300, 300, 300, 300, 300, 300, 300]), // D3: 3000
  ...hourly(ALICE, "2026-03-28", 10, [280, 280, 280, 280, 280, 280, 280, 280, 280, 280]), // D4: 2800
  ...hourly(ALICE, "2026-03-29", 10, [220, 220, 220, 220, 220, 220, 220, 220, 220, 220]), // D5: 2200
  //                                  h10  h11  h12*  h13  h14  h15  h16  h17  h18  h19
  ...hourly(ALICE, "2026-03-30", 10, [250, 250, 300, 270, 260, 260, 260, 260, 230, 260]), // D6: 2600  *WT 12–13: 300
  ...hourly(ALICE, "2026-03-31", 10, [200, 200, 200, 200, 250, 200, 250]),          // D7: 1500

  // ---- Bob (14,500) ----
  ...hourly(BOB, "2026-03-25", 13, [250, 260, 260, 260, 260, 250, 260]),            // D1: 1800
  ...hourly(BOB, "2026-03-26", 10, [220, 220, 220, 220, 220, 220, 220, 220, 220, 220]),   // D2: 2200
  ...hourly(BOB, "2026-03-27", 10, [260, 260, 260, 260, 260, 260, 260, 260, 260, 260]),   // D3: 2600
  ...hourly(BOB, "2026-03-28", 10, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240]),   // D4: 2400
  ...hourly(BOB, "2026-03-29", 10, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]),   // D5: 2000
  //                                 h10  h11  h12  h13* h14* h15  h16  h17  h18  h19
  ...hourly(BOB, "2026-03-30", 10, [180, 180, 180, 200, 200, 190, 190, 190, 190, 200]),   // D6: 1900  *LC 13–15: 400
  ...hourly(BOB, "2026-03-31", 10, [230, 230, 230, 230, 230, 230, 220]),            // D7: 1600

  // ---- Carol (16,200) ----
  ...hourly(CAROL, "2026-03-25", 13, [300, 300, 300, 300, 300, 300, 300]),           // D1: 2100
  //                                   h10  h11  h12* h13* h14  h15  h16  h17  h18  h19
  ...hourly(CAROL, "2026-03-26", 10, [200, 200, 250, 250, 230, 230, 230, 240, 240, 230]), // D2: 2300  *LC 12–14: 500
  //                                   h10  h11  h12  h13  h14* h15* h16* h17  h18  h19
  ...hourly(CAROL, "2026-03-27", 10, [250, 250, 250, 250, 300, 300, 300, 300, 300, 300]), // D3: 2800  *RH 14–17: 900
  ...hourly(CAROL, "2026-03-28", 10, [260, 260, 260, 260, 260, 260, 260, 260, 260, 260]), // D4: 2600
  ...hourly(CAROL, "2026-03-29", 10, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240]), // D5: 2400
  ...hourly(CAROL, "2026-03-30", 10, [220, 220, 220, 220, 220, 220, 220, 220, 220, 220]), // D6: 2200
  //                                   h10  h11  h12  h13  h14  h15* h16* (Day 7 ends at 17:00)
  ...hourly(CAROL, "2026-03-31", 10, [250, 250, 250, 200, 250, 300, 300]),          // D7: 1800  *LC 15–17: 600 (ACTIVE)

  // ---- Dave (14,600) ----
  ...hourly(DAVE, "2026-03-25", 13, [270, 270, 270, 270, 280, 270, 270]),           // D1: 1900
  ...hourly(DAVE, "2026-03-26", 10, [210, 210, 210, 210, 210, 210, 210, 210, 210, 210]),  // D2: 2100
  ...hourly(DAVE, "2026-03-27", 10, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240]),  // D3: 2400
  ...hourly(DAVE, "2026-03-28", 10, [220, 220, 220, 220, 220, 220, 220, 220, 220, 220]),  // D4: 2200
  //                                  h10* h11* h12  h13  h14  h15  h16  h17  h18  h19
  ...hourly(DAVE, "2026-03-29", 10, [300, 300, 250, 250, 250, 250, 250, 250, 250, 250]),  // D5: 2600  *LC 10–12: 600, (test10 RH 11–14: 800, overlap 11–12: 300)
  ...hourly(DAVE, "2026-03-30", 10, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]),  // D6: 2000
  ...hourly(DAVE, "2026-03-31", 10, [200, 200, 200, 200, 200, 200, 200]),           // D7: 1400

  // ---- Eve (16,200) ----
  ...hourly(EVE, "2026-03-25", 13, [300, 300, 350, 300, 300, 350, 300]),             // D1: 2200
  ...hourly(EVE, "2026-03-26", 10, [260, 260, 260, 260, 260, 260, 260, 260, 260, 260]),   // D2: 2600
  //                                 h10  h11  h12  h13* h14  h15  h16  h17  h18  h19
  ...hourly(EVE, "2026-03-27", 10, [220, 220, 220, 400, 260, 260, 260, 260, 200, 200]),   // D3: 2500  *WT 13–14: 400
  ...hourly(EVE, "2026-03-28", 10, [230, 230, 230, 230, 230, 230, 230, 230, 230, 230]),   // D4: 2300
  ...hourly(EVE, "2026-03-29", 10, [210, 210, 210, 210, 210, 210, 210, 210, 210, 210]),   // D5: 2100
  //                                 h10  h11* h12* h13* h14  h15  h16  h17  h18  h19
  ...hourly(EVE, "2026-03-30", 10, [250, 350, 350, 350, 250, 250, 250, 250, 250, 250]),   // D6: 2800  *RH 11–14: 1050
  ...hourly(EVE, "2026-03-31", 10, [240, 240, 240, 250, 240, 250, 240]),            // D7: 1700

  // ---- Frank (15,500) ----
  ...hourly(FRANK, "2026-03-25", 13, [280, 280, 290, 290, 290, 290, 280]),          // D1: 2000
  ...hourly(FRANK, "2026-03-26", 10, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240]), // D2: 2400
  ...hourly(FRANK, "2026-03-27", 10, [270, 270, 270, 270, 270, 270, 270, 270, 270, 270]), // D3: 2700
  ...hourly(FRANK, "2026-03-28", 10, [250, 250, 250, 250, 250, 250, 250, 250, 250, 250]), // D4: 2500
  ...hourly(FRANK, "2026-03-29", 10, [230, 230, 230, 230, 230, 230, 230, 230, 230, 230]), // D5: 2300
  ...hourly(FRANK, "2026-03-30", 10, [210, 210, 210, 210, 210, 210, 210, 210, 210, 210]), // D6: 2100
  ...hourly(FRANK, "2026-03-31", 10, [210, 210, 220, 210, 220, 220, 210]),          // D7: 1500

  // ---- Grace (14,000) ----
  ...hourly(GRACE, "2026-03-25", 13, [240, 250, 240, 240, 250, 240, 240]),          // D1: 1700
  ...hourly(GRACE, "2026-03-26", 10, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]), // D2: 2000
  ...hourly(GRACE, "2026-03-27", 10, [230, 230, 230, 230, 230, 230, 230, 230, 230, 230]), // D3: 2300
  ...hourly(GRACE, "2026-03-28", 10, [210, 210, 210, 210, 210, 210, 210, 210, 210, 210]), // D4: 2100
  ...hourly(GRACE, "2026-03-29", 10, [190, 190, 190, 190, 190, 190, 190, 190, 190, 190]), // D5: 1900
  ...hourly(GRACE, "2026-03-30", 10, [240, 240, 240, 240, 240, 240, 240, 240, 240, 240]), // D6: 2400
  ...hourly(GRACE, "2026-03-31", 10, [230, 230, 230, 230, 220, 230, 230]),          // D7: 1600
];

// --- Step sample store (reused from raceProgressSubsequentDays pattern) -----
function createStepSampleStore(samples) {
  return {
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const ws = new Date(windowStart).getTime();
      const we = new Date(windowEnd).getTime();
      return samples
        .filter(
          (s) =>
            s.userId === userId &&
            new Date(s.periodEnd).getTime() > ws &&
            new Date(s.periodStart).getTime() < we
        )
        .reduce((sum, s) => sum + s.steps, 0);
    },
  };
}

// --- Effects ---------------------------------------------------------------
// Leg Cramps: steps during the freeze window are NOT counted
const ALL_LEG_CRAMPS = [
  // Day 2: Bob → Carol, freeze 12:00–14:00 UTC (expired)
  {
    id: "lc-1", type: "LEG_CRAMP", status: "EXPIRED",
    targetParticipantId: RP_CAROL, targetUserId: CAROL, sourceUserId: BOB,
    startsAt: new Date("2026-03-26T12:00:00.000Z"),
    expiresAt: new Date("2026-03-26T14:00:00.000Z"),
    metadata: {},
  },
  // Day 5: Alice → Dave, freeze 10:00–12:00 UTC (expired)
  {
    id: "lc-2", type: "LEG_CRAMP", status: "EXPIRED",
    targetParticipantId: RP_DAVE, targetUserId: DAVE, sourceUserId: ALICE,
    startsAt: new Date("2026-03-29T10:00:00.000Z"),
    expiresAt: new Date("2026-03-29T12:00:00.000Z"),
    metadata: {},
  },
  // Day 6: Frank → Bob, freeze 13:00–15:00 UTC (expired)
  {
    id: "lc-3", type: "LEG_CRAMP", status: "EXPIRED",
    targetParticipantId: RP_BOB, targetUserId: BOB, sourceUserId: FRANK,
    startsAt: new Date("2026-03-30T13:00:00.000Z"),
    expiresAt: new Date("2026-03-30T15:00:00.000Z"),
    metadata: {},
  },
  // Day 7: Dave → Carol, freeze 15:00–17:00 UTC (ACTIVE — still running at NOW)
  {
    id: "lc-4", type: "LEG_CRAMP", status: "ACTIVE",
    targetParticipantId: RP_CAROL, targetUserId: CAROL, sourceUserId: DAVE,
    startsAt: new Date("2026-03-31T15:00:00.000Z"),
    expiresAt: new Date("2026-03-31T17:00:00.000Z"),
    metadata: {},
  },
];

// Runner's High: steps during the buff window are DOUBLED (added again)
const ALL_RUNNERS_HIGHS = [
  // Day 3: Carol self-buff 14:00–17:00 UTC (expired)
  {
    id: "rh-1", type: "RUNNERS_HIGH", status: "EXPIRED",
    targetParticipantId: RP_CAROL, targetUserId: CAROL, sourceUserId: CAROL,
    startsAt: new Date("2026-03-27T14:00:00.000Z"),
    expiresAt: new Date("2026-03-27T17:00:00.000Z"),
    metadata: {},
  },
  // Day 6: Eve self-buff 11:00–14:00 UTC (expired)
  {
    id: "rh-2", type: "RUNNERS_HIGH", status: "EXPIRED",
    targetParticipantId: RP_EVE, targetUserId: EVE, sourceUserId: EVE,
    startsAt: new Date("2026-03-30T11:00:00.000Z"),
    expiresAt: new Date("2026-03-30T14:00:00.000Z"),
    metadata: {},
  },
];

// Wrong Turn: steps during the reverse window are subtracted 2×
const ALL_WRONG_TURNS = [
  // Day 3: Dave → Eve, reverse 13:00–14:00 UTC (expired)
  {
    id: "wt-1", type: "WRONG_TURN", status: "EXPIRED",
    targetParticipantId: RP_EVE, targetUserId: EVE, sourceUserId: DAVE,
    startsAt: new Date("2026-03-27T13:00:00.000Z"),
    expiresAt: new Date("2026-03-27T14:00:00.000Z"),
    metadata: {},
  },
  // Day 6: Grace → Alice, reverse 12:00–13:00 UTC (expired)
  {
    id: "wt-2", type: "WRONG_TURN", status: "EXPIRED",
    targetParticipantId: RP_ALICE, targetUserId: ALICE, sourceUserId: GRACE,
    startsAt: new Date("2026-03-30T12:00:00.000Z"),
    expiresAt: new Date("2026-03-30T13:00:00.000Z"),
    metadata: {},
  },
];

// --- Participant factory ----------------------------------------------------
function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: overrides.bonusSteps || 0,
    nextBoxAtSteps: 0,
    powerupSlots: 3,
    user: { displayName },
  };
}

// Default participants with bonusSteps reflecting all Protein Shake / Red Card /
// Shortcut / Second Wind effects applied across the 7-day race.
//
//   Alice:  +1500 (Protein Shake D2) − 1000 (Red Card D4) = +500
//   Bob:    +1000 (Shortcut D7 stealing from Frank)
//   Carol:  +1500 (Protein Shake D5)
//   Dave:   +2000 (Second Wind D5)
//   Eve:    0
//   Frank:  +1000 (Shortcut D3 from Grace) − 1000 (stolen by Bob D7) = 0
//   Grace:  −1000 (Shortcut D3 stolen by Frank)
const DEFAULT_PARTICIPANTS = [
  makeParticipant(RP_ALICE, ALICE, "Alice", { bonusSteps: 500 }),
  makeParticipant(RP_BOB,   BOB,   "Bob",   { bonusSteps: 1000 }),
  makeParticipant(RP_CAROL, CAROL, "Carol", { bonusSteps: 1500 }),
  makeParticipant(RP_DAVE,  DAVE,  "Dave",  { bonusSteps: 2000 }),
  makeParticipant(RP_EVE,   EVE,   "Eve",   { bonusSteps: 0 }),
  makeParticipant(RP_FRANK, FRANK, "Frank", { bonusSteps: 0 }),
  makeParticipant(RP_GRACE, GRACE, "Grace", { bonusSteps: -1000 }),
];

// --- Dependency builder -----------------------------------------------------
function makeDeps(overrides = {}) {
  const updates = [];

  const participants = overrides.participants || DEFAULT_PARTICIPANTS;

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-01T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: 5000,
    participants,
  };

  const legCramps   = overrides.legCramps   || ALL_LEG_CRAMPS;
  const runnersHighs = overrides.runnersHighs || ALL_RUNNERS_HIGHS;
  const wrongTurns  = overrides.wrongTurns  || ALL_WRONG_TURNS;
  const activeEffects = overrides.activeEffects || [];

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(overrides.samples || SAMPLES),
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async findById(id) { return { id, powerupSlots: 3 }; },
        async updateTotalSteps(id, totalSteps) { updates.push({ id, totalSteps }); },
        async markFinished() {},
        async setPlacement() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType(raceId, participantId, type) {
          if (type === "LEG_CRAMP")    return legCramps.filter((e) => e.targetParticipantId === participantId);
          if (type === "RUNNERS_HIGH") return runnersHighs.filter((e) => e.targetParticipantId === participantId);
          if (type === "WRONG_TURN")   return wrongTurns.filter((e) => e.targetParticipantId === participantId);
          return [];
        },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return activeEffects; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return []; },
        async countMysteryBoxesByParticipant() { return 0; },
        async findMysteryBoxesByParticipant() { return []; },
        async countOccupiedSlots() { return 0; },
        async findSlotPowerups() { return []; },
        async countQueuedByParticipant() { return 0; },
        async findQueuedByParticipant() { return []; },
        async update() {},
      },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: overrides.now || (() => NOW),
    },
  };
}

function stepsFor(result, userId) {
  return result.participants.find((p) => p.userId === userId).totalSteps;
}

// ===========================================================================
// Tests
// ===========================================================================

// 1. Baseline sanity — no-effect user total is sum of all daily samples
test("Baseline sanity — Frank has no effects and 0 bonusSteps, total equals raw sample sum", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(FRANK, "race-1", TZ);

  // Frank raw samples: 2000+2400+2700+2500+2300+2100+1500 = 15,500
  // No effects, bonusSteps = 0
  assert.equal(stepsFor(result, FRANK), 15500);
});

// 2. Protein Shake bonus on subsequent day
test("Protein Shake bonus — Alice bonusSteps (net of Protein Shake and Red Card) adds to total", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(ALICE, "race-1", TZ);

  // Alice raw: 16,600
  // Wrong Turn D6 (12–13 UTC): 300 steps reversed → −2×300 = −600
  // bonusSteps: +500 (Protein Shake +1500, Red Card −1000)
  // Total: 16,600 − 600 + 500 = 16,500
  assert.equal(stepsFor(result, ALICE), 16500);
});

// 3. Leg Cramp freeze on subsequent day (expired)
test("Leg Cramp — Carol's expired freeze on Day 2 subtracts steps walked during the window", async () => {
  // Isolate just the D2 Leg Cramp on Carol (no other effects on Carol)
  const { deps } = makeDeps({
    legCramps: [ALL_LEG_CRAMPS[0]], // only the D2 LC on Carol
    runnersHighs: [],
    wrongTurns: [],
    participants: DEFAULT_PARTICIPANTS.map((p) =>
      p.userId === CAROL ? { ...p, bonusSteps: 0 } : p
    ),
  });
  const result = await buildGetRaceProgress(deps)(CAROL, "race-1", TZ);

  // Carol raw: 16,200
  // Leg Cramp D2 (12–14 UTC): 500 steps frozen → −500
  // Total: 16,200 − 500 = 15,700
  assert.equal(stepsFor(result, CAROL), 15700);
});

// 4. Runner's High buff on subsequent day (expired)
test("Runner's High — Carol's expired buff on Day 3 doubles steps during the window", async () => {
  // Isolate just the D3 Runner's High on Carol
  const { deps } = makeDeps({
    legCramps: [],
    runnersHighs: [ALL_RUNNERS_HIGHS[0]], // only the D3 RH on Carol
    wrongTurns: [],
    participants: DEFAULT_PARTICIPANTS.map((p) =>
      p.userId === CAROL ? { ...p, bonusSteps: 0 } : p
    ),
  });
  const result = await buildGetRaceProgress(deps)(CAROL, "race-1", TZ);

  // Carol raw: 16,200
  // Runner's High D3 (14–17 UTC): 900 steps buffed → +900
  // Total: 16,200 + 900 = 17,100
  assert.equal(stepsFor(result, CAROL), 17100);
});

// 5. Wrong Turn reverse on subsequent day (expired)
test("Wrong Turn — Eve's reversed steps on Day 3 are subtracted 2×", async () => {
  // Isolate just the D3 Wrong Turn on Eve
  const { deps } = makeDeps({
    legCramps: [],
    runnersHighs: [],
    wrongTurns: [ALL_WRONG_TURNS[0]], // only the D3 WT on Eve
  });
  const result = await buildGetRaceProgress(deps)(EVE, "race-1", TZ);

  // Eve raw: 16,200
  // Wrong Turn D3 (13–14 UTC): 400 steps reversed → −2×400 = −800
  // Total: 16,200 − 800 = 15,400
  assert.equal(stepsFor(result, EVE), 15400);
});

// 6. Shortcut transfer reflected in bonusSteps
test("Shortcut — Frank, Grace, and Bob bonusSteps reflect transfers", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(FRANK, "race-1", TZ);

  // Frank: raw 15,500 + bonusSteps 0 (net of +1000 D3 and −1000 D7) = 15,500
  assert.equal(stepsFor(result, FRANK), 15500);

  // Grace: raw 14,000 + bonusSteps −1000 (stolen by Frank D3) = 13,000
  assert.equal(stepsFor(result, GRACE), 13000);

  // Bob: raw 14,500 − 400 (LC D6) + bonusSteps +1000 (Shortcut D7) = 15,100
  assert.equal(stepsFor(result, BOB), 15100);
});

// 7. Stealth Mode on subsequent day
test("Stealth Mode — stealthed Bob shows ??? to others, normal to self", async () => {
  const stealthEffect = {
    id: "stealth-1", type: "STEALTH_MODE", status: "ACTIVE",
    targetParticipantId: RP_BOB, targetUserId: BOB, sourceUserId: BOB,
    startsAt: new Date("2026-03-28T12:00:00.000Z"),
    expiresAt: new Date("2026-03-28T16:00:00.000Z"),
  };

  // Viewing as Alice — Bob should be stealthed
  const { deps: aliceDeps } = makeDeps({ activeEffects: [stealthEffect] });
  const aliceView = await buildGetRaceProgress(aliceDeps)(ALICE, "race-1", TZ);
  const bobFromAlice = aliceView.participants.find((p) => p.userId === BOB);

  assert.equal(bobFromAlice.displayName, "???");
  assert.equal(bobFromAlice.totalSteps, null);
  assert.equal(bobFromAlice.progress, null);
  assert.equal(bobFromAlice.stealthed, true);

  // Viewing as Bob — sees own steps normally
  const { deps: bobDeps } = makeDeps({ activeEffects: [stealthEffect] });
  const bobView = await buildGetRaceProgress(bobDeps)(BOB, "race-1", TZ);
  const bobFromBob = bobView.participants.find((p) => p.userId === BOB);

  assert.equal(bobFromBob.displayName, "Bob");
  assert.equal(bobFromBob.totalSteps, 15100);
  assert.equal(bobFromBob.stealthed, false);
});

// 8. Active Leg Cramp on Day 7 (still ACTIVE)
test("Active Leg Cramp — Carol's ongoing freeze on Day 7 excludes steps in the window", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(CAROL, "race-1", TZ);

  // Carol raw: 16,200
  // Leg Cramp D2 (12–14 UTC): 500 frozen → −500
  // Runner's High D3 (14–17 UTC): 900 buffed → +900
  // Leg Cramp D7 (15–17 UTC, ACTIVE): 600 frozen → −600
  // bonusSteps: +1,500
  // Total: 16,200 − 500 + 900 − 600 + 1,500 = 17,500
  assert.equal(stepsFor(result, CAROL), 17500);
});

// 9. Multiple effects on same user across days
test("Multiple effects on Alice — Protein Shake bonus + Red Card penalty + Wrong Turn combine correctly", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(ALICE, "race-1", TZ);

  // Alice raw: 16,600
  // Wrong Turn D6 (12–13 UTC): 300 reversed → −600
  // bonusSteps: +500 (Protein Shake +1,500 minus Red Card −1,000)
  // Total: 16,600 − 600 + 500 = 16,500
  assert.equal(stepsFor(result, ALICE), 16500);
});

// 10. Leg Cramp + Runner's High overlap
test("Leg Cramp + Runner's High overlap — freeze cancels buff during overlap window", async () => {
  // Add a Runner's High on Dave Day 5 (11:00–14:00) overlapping his Leg Cramp (10:00–12:00)
  const daveRunnersHigh = {
    id: "rh-dave-overlap", type: "RUNNERS_HIGH", status: "EXPIRED",
    targetParticipantId: RP_DAVE, targetUserId: DAVE, sourceUserId: DAVE,
    startsAt: new Date("2026-03-29T11:00:00.000Z"),
    expiresAt: new Date("2026-03-29T14:00:00.000Z"),
    metadata: {},
  };

  const { deps } = makeDeps({
    runnersHighs: [...ALL_RUNNERS_HIGHS, daveRunnersHigh],
  });
  const result = await buildGetRaceProgress(deps)(DAVE, "race-1", TZ);

  // Dave raw: 14,600
  // Leg Cramp D5 (10–12 UTC): 600 frozen → −600
  // Runner's High D5 (11–14 UTC): 800 buffed
  //   Overlap (11–12 UTC): 300 steps — freeze cancels buff → buffed reduced by 300
  //   Net buff: 800 − 300 = 500
  // bonusSteps: +2,000
  // Total: 14,600 − 600 + 500 + 2,000 = 16,500
  assert.equal(stepsFor(result, DAVE), 16500);
});

// 11. Leader changes after powerup effects applied
test("Leaderboard ordering accounts for all powerup effects", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(ALICE, "race-1", TZ);

  // Expected order (by effective steps, descending):
  //   Carol: 17,500 | Alice: 16,500 | Eve: 16,450 | Dave: 16,000
  //   Frank: 15,500 | Bob: 15,100   | Grace: 13,000
  const order = result.participants.map((p) => p.userId);
  assert.deepEqual(order, [CAROL, ALICE, EVE, DAVE, FRANK, BOB, GRACE]);

  assert.equal(stepsFor(result, CAROL), 17500);
  assert.equal(stepsFor(result, ALICE), 16500);
  assert.equal(stepsFor(result, EVE), 16450);
  assert.equal(stepsFor(result, DAVE), 16000);
  assert.equal(stepsFor(result, FRANK), 15500);
  assert.equal(stepsFor(result, BOB), 15100);
  assert.equal(stepsFor(result, GRACE), 13000);
});

// 12. Compression Socks don't affect step totals
test("Compression Socks — Grace's shield has no effect on her step total", async () => {
  const { deps } = makeDeps();
  const result = await buildGetRaceProgress(deps)(GRACE, "race-1", TZ);

  // Grace raw: 14,000
  // Compression Socks (Day 4 shield) — no step modification
  // bonusSteps: −1,000 (Shortcut stolen by Frank)
  // Total: 14,000 + (−1,000) = 13,000
  assert.equal(stepsFor(result, GRACE), 13000);
});
