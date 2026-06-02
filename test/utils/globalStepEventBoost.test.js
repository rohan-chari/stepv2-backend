const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Global step-multiplier event — PURE step math.
//
// `computeGlobalEventBoost` returns the EXTRA steps a participant earns because
// one or more active GlobalStepEvent windows overlapped their step samples.
// It stacks MULTIPLICATIVELY with the per-participant timed multipliers
// (RUNNERS_HIGH 2x, CAMPFIRE_REST boost, LEG_CRAMP freeze 0x) that the existing
// resolution already understands.
//
// Accounting model (matches getRaceProgress's additive total):
//   total = base - frozen + buffed - 2*reversed + globalBoost + bonus
// where per step at effective per-participant multiplier m_p, the existing
// (base + buffed) terms already contribute m_p. A global event multiplier g
// makes the desired contribution m_p * g, so the EXTRA the global boost adds is
//   m_p * (g - 1)
// applied only to the fraction of each sample that falls inside [startsAt,endsAt].
//
// Written from the spec + the raceStateResolution mock pattern (a sumStepsInWindow
// that slices samples by overlap), NOT by mirroring implementation.
// ---------------------------------------------------------------------------

const {
  computeGlobalEventBoost,
} = require("../../src/utils/globalStepEvent");

// A sliced-sum step model identical in behavior to the real StepSample +
// raceStateResolution test doubles: prorate each sample's steps by the fraction
// of its duration that overlaps [start, end].
function makeStepModel(samplesByUser) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const samples = samplesByUser.get(userId) || [];
      let total = 0;
      for (const sample of samples) {
        const sampleStart = new Date(sample.periodStart).getTime();
        const sampleEnd = new Date(sample.periodEnd).getTime();
        const sampleDuration = sampleEnd - sampleStart;
        if (sampleDuration <= 0) continue;
        const overlapStart = Math.max(sampleStart, new Date(start).getTime());
        const overlapEnd = Math.min(sampleEnd, new Date(end).getTime());
        const overlapDuration = overlapEnd - overlapStart;
        if (overlapDuration <= 0) continue;
        total += Math.round(sample.steps * (overlapDuration / sampleDuration));
      }
      return total;
    },
  };
}

const NOW = new Date("2026-06-02T13:00:00Z");

test("no active global events => zero boost", async () => {
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 0);
});

test("steps fully inside a 2x window are boosted by exactly the in-window steps", async () => {
  // 6000 steps across the full hour 12:00-13:00, event covers the whole hour.
  // boost = 6000 * (2 - 1) = 6000  => total becomes base(6000)+6000 = 12000 (2x)
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T13:00:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 6000);
});

test("steps entirely OUTSIDE the window are not boosted", async () => {
  // Sample is 14:00-15:00, event is 12:00-13:00 — no overlap.
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T14:00:00Z",
            periodEnd: "2026-06-02T15:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T13:00:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: makeStepModel(
      new Map([
        [
          "user-1",
          [
            {
              periodStart: "2026-06-02T14:00:00Z",
              periodEnd: "2026-06-02T15:00:00Z",
              steps: 6000,
            },
          ],
        ],
      ])
    ),
    now: new Date("2026-06-02T15:00:00Z"),
  });

  assert.equal(boost, 0);
  void stepModel;
});

test("a sample SPANNING the window boundary is sliced — only the in-window fraction is boosted", async () => {
  // Sample 12:00-13:00 = 6000 steps (100 steps/min). Event covers only the
  // first 30 minutes (12:00-12:30) => 3000 steps inside.
  // boost = 3000 * (2 - 1) = 3000. (NOT 6000 — the outside half is untouched.)
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T12:30:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 3000);
});

test("event window clipped at `now` (event still in progress) only boosts steps up to now", async () => {
  // Event 12:00-12:30 but `now` is 12:15. Steps after now shouldn't exist yet,
  // and the boost window must not extend past now. Sample is 12:00-12:15 = 1500.
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T12:15:00Z",
            steps: 1500,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T12:30:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: new Date("2026-06-02T12:15:00Z"),
  });

  assert.equal(boost, 1500);
});

test("multiplicative stacking: RUNNERS_HIGH 2x inside a 2x event => 4x for the overlap", async () => {
  // 6000 steps in 12:00-13:00. RUNNERS_HIGH (2x) active the whole hour, event
  // (2x) active the whole hour. The base+buffed terms already give 2x (12000).
  // The global boost must add m_p*(g-1) = 2*(2-1) = +2 per step over the overlap:
  //   boost = 6000 * 2 * (2 - 1) = 12000
  // so the full total base(6000) + buffed(6000) + boost(12000) = 24000 = 4x. ✓
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const runnersHigh = {
    startsAt: new Date("2026-06-02T12:00:00Z"),
    expiresAt: new Date("2026-06-02T13:00:00Z"),
  };

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T13:00:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: {
      legCramps: [],
      runnersHighs: [runnersHigh],
      wrongTurns: [],
      campfires: [],
    },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 12000);
});

test("stacking only over the OVERLAP: RH covers full hour, event only first half", async () => {
  // 6000 steps 12:00-13:00. RH (2x) full hour. Event (2x) only 12:00-12:30.
  // In the overlap (first 30 min, 3000 steps) m_p=2 => boost += 3000*2*1 = 6000.
  // Second half has the event off => no global boost there.
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const runnersHigh = {
    startsAt: new Date("2026-06-02T12:00:00Z"),
    expiresAt: new Date("2026-06-02T13:00:00Z"),
  };

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T12:30:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: {
      legCramps: [],
      runnersHighs: [runnersHigh],
      wrongTurns: [],
      campfires: [],
    },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 6000);
});

test("frozen steps (LEG_CRAMP) get NO global boost in the frozen overlap", async () => {
  // 6000 steps 12:00-13:00. LEG_CRAMP (freeze, m_p=0) the whole hour, event 2x
  // the whole hour. Frozen steps stay frozen; m_p=0 => 0*(g-1) = 0 boost.
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T13:00:00Z",
            steps: 6000,
          },
        ],
      ],
    ])
  );

  const legCramp = {
    startsAt: new Date("2026-06-02T12:00:00Z"),
    expiresAt: new Date("2026-06-02T13:00:00Z"),
  };

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T13:00:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: {
      legCramps: [legCramp],
      runnersHighs: [],
      wrongTurns: [],
      campfires: [],
    },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: NOW,
  });

  assert.equal(boost, 0);
});

test("two non-overlapping event windows both contribute", async () => {
  // Sample 12:00-14:00 = 12000 steps (100/min). Event A 12:00-12:30 (3000 in),
  // Event B 13:00-13:30 (3000 in). boost = (3000 + 3000) * (2-1) = 6000.
  const stepModel = makeStepModel(
    new Map([
      [
        "user-1",
        [
          {
            periodStart: "2026-06-02T12:00:00Z",
            periodEnd: "2026-06-02T14:00:00Z",
            steps: 12000,
          },
        ],
      ],
    ])
  );

  const boost = await computeGlobalEventBoost({
    globalEvents: [
      {
        startsAt: new Date("2026-06-02T12:00:00Z"),
        endsAt: new Date("2026-06-02T12:30:00Z"),
        multiplier: 2,
      },
      {
        startsAt: new Date("2026-06-02T13:00:00Z"),
        endsAt: new Date("2026-06-02T13:30:00Z"),
        multiplier: 2,
      },
    ],
    effectGroups: { legCramps: [], runnersHighs: [], wrongTurns: [], campfires: [] },
    userId: "user-1",
    stepSampleModel: stepModel,
    now: new Date("2026-06-02T14:00:00Z"),
  });

  assert.equal(boost, 6000);
});
