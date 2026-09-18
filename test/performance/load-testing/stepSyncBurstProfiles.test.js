const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PROFILES,
  parseLoadParameters,
  validateProfileRegistry,
} = require("../../../src/modules/loadTesting/contract");
const {
  assertBurstCapacityGates,
  assertChangedUploadSettlement,
  assertFixtureParity,
  oneRequest,
} = require("../../../src/modules/loadTesting/runner");

function validParityFixture() {
  const startedAt = new Date("2026-08-24T12:00:00.000Z");
  return {
    races: [{ id: "race-1", startedAt, powerupStepInterval: 5000 }],
    sourceRows: {
      daily: [],
      samples: [
        { userId: "user-1", periodStart: new Date("2026-08-24T12:10:00.000Z"), periodEnd: new Date("2026-08-24T12:20:00.000Z"), steps: 6000 },
        { userId: "user-2", periodStart: new Date("2026-08-24T12:10:00.000Z"), periodEnd: new Date("2026-08-24T12:20:00.000Z"), steps: 7000 },
      ],
    },
    participants: [
      { id: "participant-1", raceId: "race-1", userId: "user-1", joinedAt: startedAt, rawSteps: 6000, totalSteps: 6000, bonusSteps: 0, powerupSlots: 3, nextBoxAtSteps: 10000 },
      { id: "participant-2", raceId: "race-1", userId: "user-2", joinedAt: startedAt, rawSteps: 7000, totalSteps: 7000, bonusSteps: 0, powerupSlots: 3, nextBoxAtSteps: 10000 },
    ],
    publicProgress: [{
      raceId: "race-1",
      participants: [
        { userId: "user-2", totalSteps: 7000, placement: 1 },
        { userId: "user-1", totalSteps: 6000, placement: 2 },
      ],
    }],
    boxRows: [
      { participantId: "participant-1", raceId: "race-1", userId: "user-1", earnedAtSteps: 5000 },
      { participantId: "participant-2", raceId: "race-1", userId: "user-2", earnedAtSteps: 5000 },
    ],
    scoringNow: new Date("2026-08-24T13:00:00.000Z"),
  };
}

test("frozen-client burst models 456 legacy pairs in one minute across multi-race users", () => {
  assert.equal(validateProfileRegistry(), true);
  const profile = PROFILES["frozen-step-sync-burst"];
  assert.equal(profile.fixtureRaces, 3);
  assert.deepEqual(
    profile.entries.filter((entry) => entry.weight > 0).map((entry) => entry.path),
    ["/steps", "/steps/samples"]
  );
  const params = parseLoadParameters({ profile: profile.name });
  assert.equal(params.durationSeconds, 60);
  assert.equal(params.arrivalRatePerSecond, 15.2);
  assert.equal(
    params.durationSeconds * params.arrivalRatePerSecond,
    912,
    "456 logical frozen cycles produce 912 legacy writes"
  );
  for (const item of profile.entries) {
    assert.equal(item.allowedStatuses.includes(500), false);
  }
});

test("current-client burst models one sync-v2 write plus a controlled 5% ambiguous replay", async () => {
  const profile = PROFILES["current-step-sync-burst"];
  assert.equal(profile.fixtureRaces, 3);
  assert.equal(profile.ambiguousRetryEvery, 20);
  assert.deepEqual(
    profile.entries.filter((entry) => entry.weight > 0).map((entry) => entry.path),
    ["/steps/sync-v2"]
  );
  const params = parseLoadParameters({ profile: profile.name });
  assert.equal(params.durationSeconds, 60);
  assert.equal(params.arrivalRatePerSecond, 8);

  const requests = [];
  const context = {
    runId: "burst-contract",
    userIndex: 0,
    token: "synthetic-token",
    today: "2026-08-24",
    requestBodies: new Map(),
  };
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    return { status: 202, async json() { return {}; } };
  };
  const entry = profile.entries.find((item) => item.path === "/steps/sync-v2");
  await oneRequest({
    fetchImpl,
    baseUrl: "http://127.0.0.1:3000",
    entry,
    context,
    sequence: 20,
    requestIdentitySequence: 7,
    timeoutMs: 1000,
  });
  await oneRequest({
    fetchImpl,
    baseUrl: "http://127.0.0.1:3000",
    entry,
    context,
    sequence: 21,
    requestIdentitySequence: 7,
    timeoutMs: 1000,
  });
  assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
  assert.equal(requests[0].body, requests[1].body, "ambiguous retry replays the exact body");
});

test("burst gate fails closed for an injected 500", () => {
  assert.throws(
    () => assertBurstCapacityGates({
      samples: [{ status: 500, latencyMs: 10 }],
      queueRows: [],
      drainCompleted: true,
      parity: { ok: true },
      amplification: { ratio: 1 },
      phaseEvidence: { sourceIntakeMs: [10], workerTransactionMs: [10], queueLagMs: [10], measurementGateEligible: true },
    }),
    /5xx/i
  );
});

test("burst gate fails closed for a deliberately stuck fixture generation", () => {
  assert.throws(
    () => assertBurstCapacityGates({
      samples: [{ status: 202, latencyMs: 10 }],
      queueRows: [{
        state: "RUNNING", generation: 4n, processingGeneration: 3n,
      }],
      drainCompleted: false,
      parity: { ok: true },
      amplification: { ratio: 1 },
      phaseEvidence: { sourceIntakeMs: [10], workerTransactionMs: [10], queueLagMs: [10], measurementGateEligible: true },
    }),
    /unsettled/i
  );
});

test("burst gate fails closed when required phase telemetry is absent", () => {
  assert.throws(
    () => assertBurstCapacityGates({
      samples: [{ status: 202, endpoint: "POST /steps/sync-v2", latencyMs: 10 }],
      queueRows: [{ state: "SUCCEEDED", generation: 1n, processingGeneration: 1n }],
      drainCompleted: true,
      parity: { ok: true },
      amplification: { ratio: 1 },
    }),
    /phase telemetry unavailable/i
  );
});

test("burst gate enforces source and worker phase latency objectives", () => {
  const common = {
    samples: [{ status: 202, endpoint: "POST /steps/sync-v2", latencyMs: 10 }],
    queueRows: [{ state: "SUCCEEDED", generation: 1n, processingGeneration: 1n }],
    drainCompleted: true,
    parity: { ok: true },
    amplification: { ratio: 1 },
  };
  assert.throws(() => assertBurstCapacityGates({
    ...common,
    phaseEvidence: {
      sourceIntakeMs: [3100], workerTransactionMs: [10], queueLagMs: [10],
      measurementGateEligible: true,
    },
  }), /source-intake transaction latency/i);
  assert.throws(() => assertBurstCapacityGates({
    ...common,
    phaseEvidence: {
      sourceIntakeMs: [10], workerTransactionMs: [15000], queueLagMs: [10],
      measurementGateEligible: true,
    },
  }), /worker fenced transaction latency/i);
});

test("fixture parity rejects an injected finite stale participant total", () => {
  const fixture = validParityFixture();
  fixture.participants[0].totalSteps = 5999;
  assert.throws(() => assertFixtureParity(fixture), /derived total/i);
});

test("fixture parity accepts independently matching source, projection, placement, and boxes", () => {
  assert.deepEqual(assertFixtureParity(validParityFixture()), {
    ok: true,
    checkedParticipants: 2,
    checkedBoxes: 2,
  });
});

test("fixture parity rejects an injected missing threshold box", () => {
  const fixture = validParityFixture();
  fixture.boxRows = fixture.boxRows.filter((row) => row.participantId !== "participant-1");
  assert.throws(() => assertFixtureParity(fixture), /missing box/i);
});

test("fixture parity rejects an injected duplicate threshold box", () => {
  const fixture = validParityFixture();
  fixture.boxRows.push({ ...fixture.boxRows[0], id: "duplicate" });
  assert.throws(() => assertFixtureParity(fixture), /duplicate box/i);
});

test("fixture parity rejects an injected source/projection mismatch", () => {
  const fixture = validParityFixture();
  fixture.participants[0].rawSteps = 5999;
  fixture.participants[0].totalSteps = 5999;
  assert.throws(() => assertFixtureParity(fixture), /raw source parity/i);
});

test("changed-upload settlement rejects an injected generation delayed beyond 60 seconds", () => {
  assert.throws(() => assertChangedUploadSettlement({
    changedUploads: [{ completedAtMs: 1_000, raceId: "race-1", generation: 4 }],
    settledGenerations: [{ raceId: "race-1", generation: 4, settledAtMs: 61_001 }],
  }), /100%.*60s/i);
});

test("changed-upload settlement rejects a p99 above 15 seconds even when all settle within 60", () => {
  const changedUploads = Array.from({ length: 100 }, (_, index) => ({
    completedAtMs: 1_000,
    raceId: "race-1",
    generation: index + 1,
  }));
  const settledGenerations = changedUploads.map((upload, index) => ({
    raceId: upload.raceId,
    generation: upload.generation,
    settledAtMs: 1_000 + (index >= 98 ? 16_000 : 10_000),
  }));
  assert.throws(() => assertChangedUploadSettlement({
    changedUploads,
    settledGenerations,
  }), /99%.*15s/i);
});
