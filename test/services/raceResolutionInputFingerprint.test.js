const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionInputFingerprint,
} = require("../../src/modules/races/services/raceResolutionInputFingerprint");

function fakeClient({ race = {}, inputs = [], effects = [], events = [] } = {}) {
  const results = [[{ race: { id: "r1", ...race }, participants: [] }], inputs, effects, events];
  let index = 0;
  return {
    async $queryRawUnsafe() { return results[index++]; },
  };
}

test("input fingerprint is stable for identical ordered scoring inputs", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const input = [{
    userId: "u1",
    generation: "4",
    hasSteps: true,
    hasSamples: true,
    nextSampleBoundary: new Date("2026-08-13T12:04:00.000Z"),
  }];
  const left = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 9,
    client: fakeClient({ inputs: input }),
  });
  const right = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 9,
    client: fakeClient({ inputs: input }),
  });
  assert.match(left.digest, /^[a-f0-9]{64}$/);
  assert.equal(left.digest, right.digest);
  assert.equal(left.nextSampleBoundary.toISOString(), "2026-08-13T12:04:00.000Z");
});

test("fingerprint changes for a monotonic source token, effect, event, or config version", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const base = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 1,
    client: fakeClient({ inputs: [{ userId: "u1", generation: "1" }] }),
  });
  for (const options of [
    { balanceConfigVersion: 2, inputs: [{ userId: "u1", generation: "1" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "2" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "1" }], effects: [{ id: "e1" }] },
    { balanceConfigVersion: 1, inputs: [{ userId: "u1", generation: "1" }], events: [{ id: "g1" }] },
  ]) {
    const changed = await buildRaceResolutionInputFingerprint({
      raceId: "r1", now,
      client: fakeClient(options),
      ...options,
    });
    assert.notEqual(changed.digest, base.digest);
  }
});

// Schema 2 (dependency-closure spec rule 7). The effect read now returns the
// ACTIVE rows plus the EXPIRED LEECH/HITCHHIKE history the closure graph needs;
// the two populations are split by status.
test("schema 2 digests EXPIRED leech/hitchhike rows and splits them from the active set", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const activeRow = {
    id: "e1", type: "LEECH", status: "ACTIVE", targetParticipantId: "p1",
    sourceUserId: "u2", startsAt: now, expiresAt: null, metadata: {},
  };
  const expiredRow = { ...activeRow, status: "EXPIRED" };
  const base = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 1,
    client: fakeClient({ inputs: [{ userId: "u1", generation: "1" }], effects: [activeRow] }),
  });
  const transitioned = await buildRaceResolutionInputFingerprint({
    raceId: "r1", now, balanceConfigVersion: 1,
    client: fakeClient({ inputs: [{ userId: "u1", generation: "1" }], effects: [expiredRow] }),
  });
  // The ACTIVE -> EXPIRED transition of a scoring row must move the digest;
  // under schema 1 the row simply vanished from the query and a closure could
  // be reused across the transition.
  assert.notEqual(base.digest, transitioned.digest);
  assert.deepEqual(base.activeEffects, [activeRow]);
  assert.deepEqual(base.expiredScoringEffects, []);
  // activeEffects stays ACTIVE-only: computeArtifactReuseDeadline enumerates
  // its startsAt/expiresAt and must not be handed an elapsed boundary.
  assert.deepEqual(transitioned.activeEffects, []);
  assert.deepEqual(transitioned.expiredScoringEffects, [expiredRow]);
});

test("the global-event query looks AHEAD, not only at events already started", async () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const calls = [];
  const results = [[{ race: { id: "r1" }, participants: [] }], [], [], []];
  let index = 0;
  const client = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return results[index++];
    },
  };
  await buildRaceResolutionInputFingerprint({ raceId: "r1", now, client });
  const eventQuery = calls.find((call) => call.sql.includes("global_step_events"));
  const horizon = new Date(eventQuery.params[1]);
  // The old `now + 5s` horizon selected only events that had ALREADY started,
  // so an imminent event was invisible to every deadline built from these rows.
  // It must now cover at least the closure's maximum validity window.
  assert.ok(
    horizon.getTime() - now.getTime() >= 10 * 60 * 1000,
    `horizon only ${horizon.getTime() - now.getTime()}ms ahead`
  );
  // The ended-event exclusion is unchanged.
  assert.match(eventQuery.sql, /ends_at > race\.started_at/);
});

test("the fingerprint exposes the participant rows the trail-mine projection needs", async () => {
  const value = await buildRaceResolutionInputFingerprint({
    raceId: "r1",
    now: new Date("2026-08-13T12:00:00.000Z"),
    balanceConfigVersion: 1,
    client: fakeClient({ inputs: [{ userId: "u1", generation: "1" }] }),
  });
  // Same read, no extra query (spec rule 3's full-field projection).
  assert.deepEqual(value.participants, []);
  assert.equal(value.participantCount, 0);
});

test("the fingerprint uses a current maintained boundary and retains guarded source fallbacks", async () => {
  const calls = [];
  const results = [[{ race: { id: "r1" }, participants: [] }], [], [], []];
  let index = 0;
  const client = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return results[index++];
    },
  };

  await buildRaceResolutionInputFingerprint({
    raceId: "r1",
    now: new Date("2026-09-03T00:00:00.000Z"),
    client,
  });

  const inputQuery = calls.find((call) =>
    call.sql.includes("user_scoring_input_versions"),
  )?.sql;
  assert.match(inputQuery, /THEN version\.next_sample_boundary_at/);
  assert.match(
    inputQuery,
    /version\.scoring_watermark IS NOT NULL[\s\S]+source_queue_semantics_generation=version\.generation[\s\S]+next_sample_boundary_at > \$2[\s\S]+THEN version\.next_sample_boundary_at[\s\S]+ELSE \(SELECT MIN\(source\.period_end\)/,
    "non-authoritative or expired metadata must fall back to scanning sample boundaries",
  );
  assert.match(
    inputQuery,
    /version\.generation IS NULL[\s\S]+EXISTS \(SELECT 1 FROM steps/,
    "source existence probes remain only for the fail-closed missing-token check",
  );
});

test("missing source token with existing steps/samples fails closed", async () => {
  const value = await buildRaceResolutionInputFingerprint({
    raceId: "r1",
    now: new Date("2026-08-13T12:00:00.000Z"),
    balanceConfigVersion: 1,
    client: fakeClient({
      inputs: [{ userId: "u1", generation: null, hasSteps: true, hasSamples: false }],
    }),
  });
  assert.equal(value, null);
});
