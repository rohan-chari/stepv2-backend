const assert = require("node:assert/strict");
const test = require("node:test");
const {
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
  StepSyncValidationError,
  MAX_SAMPLES,
} = require("../../src/modules/steps/stepSyncCanonical");

const baseSample = (over = {}) => ({
  periodStart: "2026-07-17T13:00:00.000Z",
  periodEnd: "2026-07-17T14:00:00.000Z",
  steps: 731,
  ...over,
});

test("canonical hash is stable for identical input", () => {
  const body = { date: "2026-07-17", steps: 12345, samples: [baseSample()] };
  const a = canonicalizeStepSyncRequest(body);
  const b = canonicalizeStepSyncRequest({ ...body });
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash.length, 64);
});

test("sample order does not change the hash (samples sorted by periodStart/periodEnd)", () => {
  const s1 = baseSample({ periodStart: "2026-07-17T13:00:00.000Z", periodEnd: "2026-07-17T14:00:00.000Z", steps: 100 });
  const s2 = baseSample({ periodStart: "2026-07-17T15:00:00.000Z", periodEnd: "2026-07-17T16:00:00.000Z", steps: 200 });
  const forward = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 1, samples: [s1, s2] });
  const reversed = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 1, samples: [s2, s1] });
  assert.equal(forward.hash, reversed.hash);
  assert.equal(forward.canonical.samples[0].steps, 100);
  assert.equal(forward.canonical.samples[1].steps, 200);
});

test("timestamps are normalized to UTC ISO-8601 ms (equivalent zones hash equal)", () => {
  const utc = canonicalizeStepSyncRequest({
    date: "2026-07-17",
    steps: 5,
    samples: [baseSample({ periodStart: "2026-07-17T13:00:00.000Z" })],
  });
  const offset = canonicalizeStepSyncRequest({
    date: "2026-07-17",
    steps: 5,
    samples: [baseSample({ periodStart: "2026-07-17T09:00:00.000-04:00" })],
  });
  assert.equal(utc.hash, offset.hash);
  assert.equal(utc.canonical.samples[0].periodStart, "2026-07-17T13:00:00.000Z");
});

test("metadata key order does not change the hash", () => {
  const a = canonicalizeStepSyncRequest({
    date: "2026-07-17",
    steps: 5,
    samples: [baseSample({ metadata: { b: 2, a: 1, nested: { y: 1, x: 2 } } })],
  });
  const b = canonicalizeStepSyncRequest({
    date: "2026-07-17",
    steps: 5,
    samples: [baseSample({ metadata: { nested: { x: 2, y: 1 }, a: 1, b: 2 } })],
  });
  assert.equal(a.hash, b.hash);
});

test("unknown top-level fields are dropped and do not affect the hash", () => {
  const a = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 5, samples: [] });
  const b = canonicalizeStepSyncRequest({
    date: "2026-07-17",
    steps: 5,
    samples: [],
    somethingNew: "ignore me",
    skipRaceResolution: true,
  });
  assert.equal(a.hash, b.hash);
});

test("different steps produce a different hash", () => {
  const a = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 5, samples: [] });
  const b = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 6, samples: [] });
  assert.notEqual(a.hash, b.hash);
});

test("empty samples array is allowed", () => {
  const result = canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 5, samples: [] });
  assert.deepEqual(result.canonical.samples, []);
});

test("rejects invalid date / negative steps / non-array samples / oversized", () => {
  assert.throws(() => canonicalizeStepSyncRequest({ date: "07-17-2026", steps: 1, samples: [] }), StepSyncValidationError);
  assert.throws(() => canonicalizeStepSyncRequest({ date: "2026-07-17", steps: -1, samples: [] }), StepSyncValidationError);
  assert.throws(() => canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 1.5, samples: [] }), StepSyncValidationError);
  assert.throws(() => canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 1, samples: {} }), StepSyncValidationError);
  const tooMany = Array.from({ length: MAX_SAMPLES + 1 }, () => baseSample());
  assert.throws(() => canonicalizeStepSyncRequest({ date: "2026-07-17", steps: 1, samples: tooMany }), StepSyncValidationError);
});

test("validateIdempotencyKey accepts a canonical UUID and rejects others", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(validateIdempotencyKey(uuid), uuid);
  assert.throws(() => validateIdempotencyKey(""), StepSyncValidationError);
  assert.throws(() => validateIdempotencyKey("not-a-uuid"), StepSyncValidationError);
  assert.throws(() => validateIdempotencyKey("x".repeat(40)), StepSyncValidationError);
});
