const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildStepInputDirtyEnvelope,
} = require("../../src/modules/steps/services/stepInputIntake");
const {
  buildRaceResolutionJobV2Model,
} = require("../../src/modules/races/models/raceResolutionJobV2");

test("step intake marks races whose advertised field exceeds scoped capacity as FULL immediately", () => {
  assert.deepEqual(
    buildStepInputDirtyEnvelope({
      userId: "user-1",
      participantId: "participant-1",
      maxParticipants: 10_000,
    }),
    {
      reason: "FULL",
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "COALESCE",
    },
  );
});

test("step intake keeps participant scope for ordinarily bounded races", () => {
  assert.deepEqual(
    buildStepInputDirtyEnvelope({
      userId: "user-1",
      participantId: "participant-1",
      maxParticipants: 100,
    }),
    {
      reason: "STEP_INPUT_CHANGED",
      dirtyUserIds: ["user-1"],
      dirtyParticipantIds: ["participant-1"],
      powerupTypes: [],
      priority: "COALESCE",
    },
  );
});

test("FULL enqueue payloads do not grow a redundant triggering-user array", async () => {
  let payload = null;
  const prisma = {
    async $queryRawUnsafe(_sql, encoded) {
      payload = JSON.parse(encoded);
      return [{
        id: "job-1",
        raceId: "race-1",
        state: "queued",
        generation: 1,
      }];
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  await model.enqueueMany({
    raceIds: ["race-1"],
    userId: "user-1",
    dirtyEnvelopeByRaceId: new Map([["race-1", {
      reason: "FULL",
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "COALESCE",
    }]]),
  });

  assert.deepEqual(payload[0].triggered, []);
  assert.deepEqual(payload[0].dirtyReasons, ["FULL"]);
});

test("a large FULL upload appends a trigger and seeds one ordinary queue generation", async () => {
  const writes = [];
  const queries = [];
  const prisma = {
    async $executeRawUnsafe(sql) {
      writes.push(sql);
      return 1;
    },
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      if (/SELECT .* FROM race_resolution_jobs_v2 WHERE race_id=\$1/s.test(sql)) {
        return [];
      }
      if (/INSERT INTO race_resolution_jobs_v2/.test(sql)) {
        return [{
          id: "job-1",
          raceId: "race-1",
          state: "queued",
          generation: 7,
          processingGeneration: null,
          dirtyReasons: ["FULL"],
        }];
      }
      assert.fail("a freshly seeded FULL generation needs no conflict-row rewrite");
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  const rows = await model.enqueueMany({
    raceIds: ["race-1"],
    userId: "user-2",
    queuedGenerationMerge: true,
    dirtyEnvelopeByRaceId: new Map([["race-1", {
      reason: "FULL",
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "COALESCE",
    }]]),
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0], /INSERT INTO race_resolution_full_triggers/);
  assert.equal(queries.length, 2);
  assert.equal(rows[0].id, "job-1");
  assert.equal(rows[0].generation, 7);
});

test("large-race intake durably carries uploader scope for bounded promotion", async () => {
  const writes = [];
  const queries = [];
  const prisma = {
    async $executeRawUnsafe(...args) { writes.push(args); return 1; },
    async $queryRawUnsafe(sql, ...args) {
      queries.push([sql, ...args]);
      if (/SELECT .* FROM race_resolution_jobs_v2 WHERE race_id=\$1/s.test(sql)) {
        return [];
      }
      if (/INSERT INTO race_resolution_jobs_v2/.test(sql)) {
        return [{ id: "job-1", raceId: "race-large", state: "queued", generation: 1 }];
      }
      assert.fail("unexpected queue query");
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  await model.enqueueMany({
    raceIds: ["race-large"],
    userId: "user-1",
    queuedGenerationMerge: true,
    burstCoalescing: true,
    largeRaceScopeByRaceId: new Map([["race-large", {
      userId: "user-1", participantId: "participant-1",
    }]]),
    dirtyEnvelopeByRaceId: new Map([["race-large", {
      reason: "FULL", dirtyUserIds: [], dirtyParticipantIds: [],
      powerupTypes: [], priority: "COALESCE",
    }]]),
  });

  assert.match(writes[0][0], /user_id,participant_id/);
  assert.equal(writes[0][2], "user-1");
  assert.equal(writes[0][3], "participant-1");
  const seed = queries.find(([sql]) => /INSERT INTO race_resolution_jobs_v2/.test(sql));
  assert.equal(
    seed[4].getTime() - seed[3].getTime(),
    5000,
    "scoped batches coalesce one launch window while staying below the closure cap",
  );
});

test("a hot large-race upload never contends on the shared queue row", async () => {
  const queries = [];
  const prisma = {
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe(sql) {
      queries.push(sql);
      if (/SELECT .* FROM race_resolution_jobs_v2 WHERE race_id=\$1/s.test(sql)) {
        return [{
          id: "job-1", raceId: "race-1", state: "running", generation: 9,
          processingGeneration: 9, dirtyReasons: ["FULL"],
        }];
      }
      assert.fail("an existing active generation must not attempt a conflicting insert or update");
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  const row = await model.enqueueFullScopeTrigger({ raceId: "race-1" }, prisma);

  assert.equal(row.state, "RUNNING");
  assert.equal(queries.length, 1);
});

test("a multi-race upload keeps FULL races off the shared upsert", async () => {
  const writes = [];
  const upsertPayloads = [];
  const prisma = {
    async $executeRawUnsafe(sql, ...args) {
      writes.push([sql, ...args]);
      return 1;
    },
    async $queryRawUnsafe(sql, encoded) {
      if (/SELECT .* FROM race_resolution_jobs_v2 WHERE race_id=\$1/s.test(sql)) {
        return [{ id: "large-job", raceId: "race-large", state: "queued", generation: 3 }];
      }
      if (/jsonb_to_recordset/.test(sql)) {
        const payload = JSON.parse(encoded);
        upsertPayloads.push(payload);
        return payload.map((row) => ({
          id: `job-${row.raceId}`, raceId: row.raceId, state: "queued", generation: 1,
        }));
      }
      assert.fail("unexpected queue query");
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  const rows = await model.enqueueMany({
    raceIds: ["race-small", "race-large"],
    userId: "user-1",
    queuedGenerationMerge: true,
    dirtyEnvelopeByRaceId: new Map([
      ["race-large", { reason: "FULL", priority: "COALESCE" }],
      ["race-small", {
        reason: "STEP_INPUT_CHANGED", dirtyUserIds: ["user-1"],
        dirtyParticipantIds: ["participant-1"], priority: "COALESCE",
      }],
    ]),
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0][0], /race_resolution_full_triggers/);
  assert.deepEqual(upsertPayloads.map((payload) => payload.map((row) => row.raceId)), [["race-small"]]);
  assert.deepEqual(rows.map((row) => row.raceId), ["race-large", "race-small"]);
});

test("FULL trigger promotion extends the large-race debounce from the newest upload", async () => {
  const calls = [];
  const prisma = {
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe(...args) {
          calls.push(args);
          return 1;
        },
        async $queryRawUnsafe(...args) {
          calls.push(args);
          return [{ promotedTriggers: 50, promotedRaces: 1 }];
        },
      });
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);
  const now = new Date("2026-08-31T16:00:00.000Z");

  await model.promoteFullScopeTriggers({ now });

  const promotion = calls.find(([sql]) => /UPDATE race_resolution_jobs_v2 job/.test(sql));
  assert.ok(promotion, "the trigger page is folded into its race job");
  assert.equal(promotion[1], 500, "one promotion cannot overfill a scoped generation");
  assert.match(promotion[0], /jsonb_array_length\(job\.dirty_participant_ids\) < 500/);
  assert.match(promotion[0], /not_before_at=GREATEST\(/);
  assert.match(
    promotion[0],
    /WHEN job\.state='queued'[\s\S]*job\.queue_priority='LIVE'[\s\S]*job\.dirty_reasons \? 'GLOBAL_EVENT_BOUNDARY'[\s\S]*COALESCE\(job\.not_before_at,'-infinity'::timestamp\)/,
    "uploads must not postpone an already queued event-boundary generation",
  );
  assert.match(
    promotion[0],
    /GREATEST\(\s*COALESCE\(job\.not_before_at,\$4::timestamp\),\s*\$4::timestamp\s*\)/,
  );
  assert.match(promotion[0], /BOOL_AND\(user_id IS NOT NULL AND participant_id IS NOT NULL\)/i);
  assert.match(promotion[0], /full_trigger_seed_only/);
  assert.match(promotion[0], /STEP_INPUT_CHANGED/);
  assert.match(
    promotion[0],
    /queue_priority=CASE[\s\S]*job\.state='queued'[\s\S]*job\.queue_priority='LIVE'[\s\S]*THEN 'LIVE'[\s\S]*ELSE 'MAINTENANCE' END/,
  );
  assert.equal(
    promotion[3].toISOString(),
    "2026-08-31T16:00:05.000Z",
    "each newly observed upload pushes the claim floor five seconds forward",
  );
});

test("ordinary coalesced enqueue extends a queued race's debounce floor", async () => {
  let statement = "";
  const prisma = {
    async $queryRawUnsafe(sql) {
      statement = sql;
      return [{ id: "job-1", raceId: "race-1", state: "queued", generation: 1 }];
    },
  };
  const model = buildRaceResolutionJobV2Model(prisma);

  await model.enqueueMany({
    raceIds: ["race-1"],
    now: new Date("2026-08-31T16:00:00.000Z"),
    burstCoalescing: true,
    dirtyEnvelopeByRaceId: new Map([["race-1", {
      reason: "GLOBAL_EVENT_BOUNDARY",
      dirtyUserIds: ["user-1"],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "COALESCE",
    }]]),
  });

  assert.match(statement, /GREATEST\(\s*COALESCE\(race_resolution_jobs_v2\.not_before_at/);
  assert.match(statement, /EXCLUDED\.not_before_at/);
});
