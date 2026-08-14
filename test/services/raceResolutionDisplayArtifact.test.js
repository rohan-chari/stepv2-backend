const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionDisplayArtifactStore,
  computeArtifactReuseDeadline,
  artifactMatchesClaim,
  ARTIFACT_SCHEMA,
  ARTIFACT_TTL_SECONDS,
} = require("../../src/modules/races/services/raceResolutionDisplayArtifact");

function fakeRedis() {
  const values = new Map();
  return {
    values,
    async setJSON(key, value, ttl) {
      values.set(key, { value: JSON.parse(JSON.stringify(value)), ttl });
      return true;
    },
    async getJSON(key) {
      return values.get(key)?.value || null;
    },
    async del(key) {
      values.delete(key);
      return true;
    },
  };
}

test("display artifact stores a bounded digest/schema envelope for 120 seconds", async () => {
  const redis = fakeRedis();
  const store = buildRaceResolutionDisplayArtifactStore({
    redisCache: redis,
    randomId: () => "artifact_1",
  });
  const ref = await store.put({
    raceId: "r1",
    timeZone: "UTC",
    triggeringUserIds: ["u1"],
    participants: [{ id: "p1", totalSteps: 10 }],
    reuseDeadline: "2026-08-13T12:00:05.000Z",
  });
  assert.equal(ref.id, "artifact_1");
  assert.equal(ref.schema, ARTIFACT_SCHEMA);
  assert.match(ref.digest, /^[a-f0-9]{64}$/);
  const stored = redis.values.get("v1:race:resolution-artifact:artifact_1");
  assert.equal(stored.ttl, ARTIFACT_TTL_SECONDS);
});

test("worker accepts only a pure display claim with the exact trigger set and replay-safe writes", () => {
  const payload = {
    raceId: "r1",
    timeZone: "UTC",
    triggeringUserIds: ["u1", "u2"],
    inputFingerprint: "f".repeat(64),
    writes: [{ kind: "participantTotal", participantId: "p1", totalSteps: 5 }],
    result: { raceId: "r1", race: { participants: [] } },
  };
  const job = {
    raceId: "r1",
    processingTimeZone: "UTC",
    processingDirtyReasons: ["DISPLAY_REFRESH"],
    processingTriggeredByUserIds: ["u2", "u1"],
  };
  assert.equal(artifactMatchesClaim(payload, job), true);
  assert.equal(artifactMatchesClaim(payload, {
    ...job,
    processingDirtyReasons: ["DISPLAY_REFRESH", "STEP_SYNC"],
  }), false);
  assert.equal(artifactMatchesClaim(payload, {
    ...job,
    processingTriggeredByUserIds: ["u1"],
  }), false);
  assert.equal(artifactMatchesClaim({
    ...payload,
    writes: [{ kind: "eventCreate", data: { description: "stale copy" } }],
  }, job), false);
  assert.equal(artifactMatchesClaim({
    ...payload,
    writes: [{
      kind: "eventCreate",
      data: {
        raceId: "r1", powerupType: "TRAIL_MINE", targetUserId: "u1",
        metadata: { penalty: 10, blocked: false },
      },
    }],
  }, job), true, "known captured copy is accepted only because the fence rebinds it");
});

test("artifact validation fails closed and successful consumption is single-use", async () => {
  const redis = fakeRedis();
  const store = buildRaceResolutionDisplayArtifactStore({
    redisCache: redis,
    randomId: () => "artifact_2",
  });
  const ref = await store.put({
    raceId: "r1",
    timeZone: "UTC",
    triggeringUserIds: ["u1"],
    participants: [],
    result: { race: { startedAt: new Date("2026-08-13T00:00:00.000Z") } },
    reuseDeadline: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(
    await store.load({ ...ref, raceId: "wrong", timeZone: "UTC" }),
    null
  );
  const loaded = await store.load({ ...ref, raceId: "r1", timeZone: "UTC" });
  assert.equal(loaded.raceId, "r1");
  assert.equal(await store.consume(ref.id), true);
  assert.equal(await store.load({ ...ref, raceId: "r1", timeZone: "UTC" }), null);
});

test("oversized or uncertain artifacts are not emitted", async () => {
  const store = buildRaceResolutionDisplayArtifactStore({ redisCache: fakeRedis() });
  assert.equal(
    await store.put({ raceId: "r", participants: Array.from({ length: 1001 }, () => ({})) }),
    null
  );
  assert.equal(await store.put({ raceId: "r", unknownBoundary: true }), null);
});

test("reuse deadline is exclusive and chooses the earliest registered boundary", () => {
  const asOf = new Date("2026-08-13T12:59:58.000Z");
  assert.equal(
    computeArtifactReuseDeadline({
      asOf,
      timeZone: "UTC",
      raceEndsAt: new Date("2026-08-13T13:00:04.000Z"),
      nextSampleBoundary: new Date("2026-08-13T13:00:01.000Z"),
      activeEffects: [],
      globalEvents: [],
    }).toISOString(),
    "2026-08-13T13:00:00.000Z",
    "Hitchhike's top-of-hour boundary beats sample and five-second limits"
  );
  assert.equal(
    computeArtifactReuseDeadline({
      asOf: new Date("2026-08-13T12:00:00.000Z"),
      timeZone: "UTC",
      activeEffects: [{
        id: "e", type: "RUNNERS_HIGH",
        expiresAt: "2026-08-13T12:00:02.000Z",
      }],
      globalEvents: [],
    }).toISOString(),
    "2026-08-13T12:00:02.000Z",
    "known effects register their exact expiry boundary"
  );
  assert.equal(
    computeArtifactReuseDeadline({
      asOf: new Date("2026-08-13T12:00:00.000Z"),
      timeZone: "UTC",
      activeEffects: [{ id: "e", type: "FUTURE_UNKNOWN" }],
      globalEvents: [],
    }),
    null,
    "an unregistered effect type still fails closed"
  );
});
