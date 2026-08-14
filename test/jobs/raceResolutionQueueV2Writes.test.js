const assert = require("node:assert/strict");
const test = require("node:test");

const {
  participantTotalWriteChangesRow,
  retainTeamAsOfHeartbeat,
  normalizeParticipantWrites,
  supersededRunMayDiscard,
  resolutionPlanForDirtyReasons,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

test("unchanged total/raw writes are suppressed", () => {
  const current = { totalSteps: 1000, rawSteps: 900 };
  assert.equal(
    participantTotalWriteChangesRow(
      {
        kind: "participantTotal",
        totalSteps: 1000,
        rawSteps: 900,
      },
      current
    ),
    false
  );
});

test("superseded discard is allowed only for recent all-COALESCE work", () => {
  const now = new Date("2026-08-13T12:00:20.000Z");
  const base = {
    generation: 3,
    processingGeneration: 2,
    dirtyPriority: "COALESCE",
    processingDirtyPriority: "COALESCE",
    lastCompletedAt: new Date("2026-08-13T12:00:10.000Z"),
  };
  assert.equal(supersededRunMayDiscard(base, now), true);
  assert.equal(supersededRunMayDiscard({ ...base, dirtyPriority: "IMMEDIATE" }, now), false);
  assert.equal(
    supersededRunMayDiscard({ ...base, lastCompletedAt: new Date("2026-08-13T12:00:04.999Z") }, now),
    false
  );
  assert.equal(supersededRunMayDiscard({ ...base, generation: 2 }, now), false);
});

test("only a pure BOX_OPEN generation may skip canonical scoring", () => {
  assert.equal(resolutionPlanForDirtyReasons(["BOX_OPEN"]), "NO_SCORE");
  for (const reasons of [
    [],
    ["FULL"],
    ["STEP_SYNC"],
    ["BOX_OPEN", "STEP_SYNC"],
    ["UNKNOWN"],
  ]) {
    assert.equal(resolutionPlanForDirtyReasons(reasons), "FULL");
  }
});

test("bulk normalization coalesces bonus deltas and preserves one total/raw write", () => {
  assert.deepEqual(
    normalizeParticipantWrites([
      { kind: "participantBonus", participantId: "p1", amount: 2 },
      { kind: "participantTotal", participantId: "p1", totalSteps: 100, rawSteps: 90 },
      { kind: "participantBonus", participantId: "p1", amount: 3 },
      { kind: "participantBonus", participantId: "p2", amount: 4 },
    ]),
    [
      {
        participantId: "p1",
        totalSteps: 100,
        hasTotal: true,
        rawSteps: 90,
        hasRaw: true,
        bonusDecrement: 5,
      },
      {
        participantId: "p2",
        totalSteps: null,
        hasTotal: false,
        rawSteps: null,
        hasRaw: false,
        bonusDecrement: 4,
      },
    ]
  );
});

test("bulk normalization rejects conflicting duplicate totals instead of last-write-wins", () => {
  assert.throws(
    () =>
      normalizeParticipantWrites([
        { kind: "participantTotal", participantId: "p1", totalSteps: 100 },
        { kind: "participantTotal", participantId: "p1", totalSteps: 101 },
      ]),
    /conflicting participant total capture/
  );
});

test("changed totals, changed raw steps, and bonus writes are retained", () => {
  const current = { totalSteps: 1000, rawSteps: 900 };
  assert.equal(
    participantTotalWriteChangesRow(
      { kind: "participantTotal", totalSteps: 1001, rawSteps: 900 },
      current
    ),
    true
  );
  assert.equal(
    participantTotalWriteChangesRow(
      { kind: "participantTotal", totalSteps: 1000, rawSteps: 901 },
      current
    ),
    true
  );
  assert.equal(
    participantTotalWriteChangesRow(
      { kind: "participantBonus", amount: 50 },
      current
    ),
    true
  );
});

test("an unchanged team race retains one timestamp heartbeat, not one write per racer", () => {
  const candidates = [
    { kind: "participantTotal", participantId: "participant-1" },
    { kind: "participantTotal", participantId: "participant-2" },
  ];
  assert.deepEqual(
    retainTeamAsOfHeartbeat(candidates, [], true),
    [candidates[0]]
  );
  assert.deepEqual(retainTeamAsOfHeartbeat(candidates, [], false), []);
});
