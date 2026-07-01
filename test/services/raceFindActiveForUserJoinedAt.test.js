const assert = require("node:assert/strict");
const test = require("node:test");

const {
  calculateBaseAdjusted,
} = require("../../src/services/raceStateResolution");

// ---------------------------------------------------------------------------
// T4 regression: mystery-box over-grant on public mid-race join.
//
// resolveRaceState reads participants via Race.findActiveForUser (a LEAN
// `select`). getEffectiveStart(participant, raceStartedAt) clamps the
// box/step window to participant.joinedAt when it is after race start. If the
// lean select OMITS joinedAt, getEffectiveStart falls back to raceStartedAt and
// the window opens at RACE START — summing pre-join steps and minting a burst
// of milestone boxes for a user who only just joined.
//
// (1) is the primary FAILING-FIRST guard: assert the lean select actually asks
//     Prisma for joinedAt. (2) documents the clamp mechanism end-to-end.
// ---------------------------------------------------------------------------

// Race.findActiveForUser uses prisma directly. Mock the db module's prisma and
// re-require the model (same pattern as markRaceResultsSeen.test.js) to capture
// the exact `select` it sends — no DB needed.
function withMockPrisma(mockPrisma, fn) {
  const dbModule = require("../../src/db");
  const originalPrisma = dbModule.prisma;
  Object.assign(dbModule, { prisma: mockPrisma });
  try {
    delete require.cache[require.resolve("../../src/models/race")];
    const mod = require("../../src/models/race");
    return fn(mod);
  } finally {
    Object.assign(dbModule, { prisma: originalPrisma });
    delete require.cache[require.resolve("../../src/models/race")];
  }
}

test("Race.findActiveForUser participant select includes joinedAt (box-window join clamp)", async () => {
  let capturedArgs = null;
  const mockPrisma = {
    race: {
      async findMany(args) {
        capturedArgs = args;
        return [];
      },
    },
  };

  await withMockPrisma(mockPrisma, async ({ Race }) => {
    await Race.findActiveForUser("user-1");
  });

  assert.ok(capturedArgs, "findMany should be called");
  const participantSelect = capturedArgs.select.participants.select;
  assert.equal(
    participantSelect.joinedAt,
    true,
    "joinedAt must be selected so getEffectiveStart clamps the box window to the real join, not race start"
  );
});

// ── Behavioral lock: join-clamp prevents the pre-join over-count ─────────────
// ET-midnight daily race shape (mirrors calculateBaseAdjustedStartDay.test.js).
const TZ = "America/New_York";
const RACE_STARTED_AT = new Date("2026-06-25T04:00:00Z"); // 06-25 00:00 ET

function stepSampleMock(windowStartToSteps = {}) {
  return {
    async sumStepsInWindow(_userId, start) {
      return windowStartToSteps[new Date(start).toISOString()] ?? 0;
    },
  };
}

function stepsMock(byDate = {}) {
  return {
    async findByUserIdAndDate(_userId, date) {
      return byDate[date] != null ? { steps: byDate[date] } : null;
    },
    async findByUserIdAndDateRange() {
      return [];
    },
  };
}

test("mid-race joiner with joinedAt is clamped to post-join steps (no instant box burst)", async () => {
  // Joined mid-day with 708 post-join steps; ~8000 walked that day BEFORE joining.
  const clamped = await calculateBaseAdjusted({
    participant: { userId: "u", joinedAt: new Date("2026-06-25T15:00:00Z") },
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({ "2026-06-25": 8000 }), // full-day total must NOT leak
    stepSampleModel: stepSampleMock({ "2026-06-25T15:00:00.000Z": 708 }),
    now: new Date("2026-06-25T18:00:00Z"),
  });
  assert.equal(clamped.baseAdjusted, 708);

  // The bug: when joinedAt is missing from the participant (lean select dropped
  // it), getEffectiveStart falls back to race start (local midnight) and counts
  // the full 8000-step day — enough to mint boxes at 2000/4000/6000/8000.
  const overGranted = await calculateBaseAdjusted({
    participant: { userId: "u" }, // joinedAt OMITTED — reproduces the lean-select bug
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({ "2026-06-25": 8000 }),
    stepSampleModel: stepSampleMock({ "2026-06-25T04:00:00.000Z": 0 }),
    now: new Date("2026-06-25T18:00:00Z"),
  });
  assert.equal(overGranted.baseAdjusted, 8000);
});
