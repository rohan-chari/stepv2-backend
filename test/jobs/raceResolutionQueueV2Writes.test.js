const assert = require("node:assert/strict");
const test = require("node:test");

const {
  participantTotalWriteChangesRow,
  retainTeamAsOfHeartbeat,
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
