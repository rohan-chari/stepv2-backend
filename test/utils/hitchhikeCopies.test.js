const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// HITCHHIKE copy math (§7.3). A HITCHHIKE effect on target T, sourced by caster
// C, COPIES T's recorded raw steps in the scoring window into C's race score at
// `copyRatio` (default 1). It is NOT zero-sum — T loses nothing, C gains a
// copy — so unlike Leech there is no victim-availability resolution.
//
// Window (identical rule to Leech, but measured against the TARGET's steps):
//   windowStart = effect.startsAt
//   rawEnd      = min(expiresAt ?? now, raceEndsAt, targetFinishedAt/ForfeitedAt)
//   windowEnd   = min(rawEnd, topOfCurrentHour)   // in-progress bucket excluded
//   copied      = floor(sumStepsInWindow(targetUserId, start, end) * copyRatio)
// ---------------------------------------------------------------------------

const {
  HITCHHIKE_DEFAULT_COPY_RATIO,
  hitchhikeCopyRatio,
  computeHitchhikeCopiedSteps,
  collectRaceHitchhikeCopies,
  hitchhikeCreditBySourceUser,
  applyHitchhikeCopies,
} = require("../../src/modules/powerups/hitchhikeCopies");

const T0 = new Date("2026-07-20T12:00:00Z");
const T1 = new Date("2026-07-20T13:00:00Z"); // 60-min window end
const NOW = new Date("2026-07-20T15:00:00Z"); // later hour => [T0,T1] is closed

// Per-user uniform-rate step model over [T0, T1].
function makeStepModel(stepsByUser) {
  return {
    async sumStepsInWindow(userId, start, end) {
      const steps = stepsByUser[userId] || 0;
      const ss = T0.getTime();
      const se = T1.getTime();
      const os = Math.max(ss, new Date(start).getTime());
      const oe = Math.min(se, new Date(end).getTime());
      if (oe <= os) return 0;
      return Math.round(steps * ((oe - os) / (se - ss)));
    },
  };
}

function hitch(overrides = {}) {
  return {
    id: "hh-1",
    type: "HITCHHIKE",
    startsAt: T0,
    expiresAt: T1,
    status: "ACTIVE",
    sourceUserId: "caster",
    targetUserId: "target",
    targetParticipantId: "rp-target",
    metadata: { copyRatio: 1, scoringVersion: 1 },
    ...overrides,
  };
}

test("copyRatio defaults to 1 when metadata is missing or malformed", () => {
  assert.equal(HITCHHIKE_DEFAULT_COPY_RATIO, 1);
  assert.equal(hitchhikeCopyRatio(hitch({ metadata: undefined })), 1);
  assert.equal(hitchhikeCopyRatio(hitch({ metadata: {} })), 1);
  assert.equal(hitchhikeCopyRatio(hitch({ metadata: { copyRatio: "x" } })), 1);
  assert.equal(hitchhikeCopyRatio(hitch({ metadata: { copyRatio: 0 } })), 1);
  assert.equal(hitchhikeCopyRatio(hitch({ metadata: { copyRatio: 0.5 } })), 0.5);
});

test("copies the TARGET's in-window steps 1:1 (not the caster's)", async () => {
  const model = makeStepModel({ target: 4000, caster: 99999 });
  const copied = await computeHitchhikeCopiedSteps(hitch(), model, NOW);
  assert.equal(copied, 4000);
});

test("copyRatio scales the copy and floors it", async () => {
  const model = makeStepModel({ target: 4001 });
  const copied = await computeHitchhikeCopiedSteps(
    hitch({ metadata: { copyRatio: 0.5 } }),
    model,
    NOW
  );
  assert.equal(copied, 2000, "floor(4001 * 0.5)");
});

test("the in-progress hour bucket is EXCLUDED and the copy is monotonic across recomputes", async () => {
  const live = hitch({ expiresAt: null });
  const model = makeStepModel({ target: 4000 });
  const midHour = new Date("2026-07-20T12:20:00Z");
  const early = await computeHitchhikeCopiedSteps(live, model, midHour);
  assert.equal(early, 0, "the current hour's bucket contributes nothing until it closes");
  const later = await computeHitchhikeCopiedSteps(live, model, NOW);
  assert.ok(later >= early, "copy is monotonic");
  assert.equal(later, 4000);
  // A re-upsert of the in-progress bucket (simulated by advancing `now` inside
  // the same later hour) must never DECREASE the copied total.
  const evenLater = await computeHitchhikeCopiedSteps(
    live,
    model,
    new Date("2026-07-20T15:59:00Z")
  );
  assert.ok(evenLater >= later, "monotonic across repeated computes");
});

test("the window clamps to race end", async () => {
  const model = makeStepModel({ target: 4000 });
  const copied = await computeHitchhikeCopiedSteps(hitch(), model, NOW, {
    raceEndsAt: new Date("2026-07-20T12:30:00Z"),
  });
  assert.equal(copied, 2000, "only the half of the window before race end counts");
});

test("the window clamps to the target's finish and forfeit times", async () => {
  const model = makeStepModel({ target: 4000 });
  const finished = await computeHitchhikeCopiedSteps(hitch(), model, NOW, {
    targetFinishedAt: new Date("2026-07-20T12:15:00Z"),
  });
  assert.equal(finished, 1000, "steps walked after the target finished are never copied");
  const forfeited = await computeHitchhikeCopiedSteps(hitch(), model, NOW, {
    targetForfeitedAt: new Date("2026-07-20T12:45:00Z"),
  });
  assert.equal(forfeited, 3000, "steps walked after the target forfeited are never copied");
});

test("a zero/negative-length window copies nothing", async () => {
  const model = makeStepModel({ target: 4000 });
  const copied = await computeHitchhikeCopiedSteps(
    hitch({ expiresAt: T0 }),
    model,
    NOW
  );
  assert.equal(copied, 0);
});

test("missing sample evidence contributes zero (never estimated from a daily total)", async () => {
  const empty = { async sumStepsInWindow() { return 0; } };
  assert.equal(await computeHitchhikeCopiedSteps(hitch(), empty, NOW), 0);
});

test("v3 includes an exact sparse current-hour sample and CAS-persists its signed capture", async () => {
  const now = new Date("2026-07-20T12:56:00Z");
  const effect = hitch({
    raceId: "race-1",
    metadata: { copyRatio: 1, scoringVersion: 3 },
  });
  let persisted;
  const copied = await computeHitchhikeCopiedSteps(
    effect,
    { async sumStepsInWindow(_userId, start, end) {
      assert.equal(new Date(start).getTime(), T0.getTime());
      assert.equal(new Date(end).getTime(), now.getTime());
      return 4_129;
    } },
    now,
    {
      raceId: "race-1",
      targetParticipantId: "rp-target",
      raceActiveEffectModel: {
        async findEffectsForRaceByTypes() { return {}; },
      },
      attributionCaptureModel: {
        async findFrozen() { return null; },
        async findByEffect() { return null; },
        async readDailySteps() { return 9_000; },
        async readScoringInput() {
          return { generation: 7n, fingerprint: "a".repeat(64) };
        },
        async replaceV3(input) {
          persisted = input;
          return { effectiveContribution: input.effectiveContribution };
        },
      },
    },
  );
  assert.equal(copied, 4_129);
  assert.equal(persisted.rawSourceKind, "EXACT_SAMPLES");
  assert.equal(persisted.rawSourceHighWater, 4_129);
  assert.equal(persisted.effectiveContribution, 4_129);
  assert.equal(persisted.scoringInputGeneration, 7n);
  assert.equal(persisted.captureThrough.getTime(), now.getTime());
  assert.equal(persisted.frozenAt, null);
});

test("v3 uses one checkpointed coarse daily delta as an alternative to absent samples", async () => {
  const now = new Date("2026-07-20T12:56:00Z");
  let persisted;
  const copied = await computeHitchhikeCopiedSteps(
    hitch({
      raceId: "race-1",
      metadata: { copyRatio: 1, scoringVersion: 3 },
    }),
    { async sumStepsInWindow() { return 0; } },
    now,
    {
      raceId: "race-1",
      targetParticipantId: "rp-target",
      raceActiveEffectModel: {
        async findEffectsForRaceByTypes() { return {}; },
      },
      attributionCaptureModel: {
        async findFrozen() { return null; },
        async findByEffect() {
          return {
            castDailySteps: 1_000,
            coarseRawAttributed: 0,
            coarseEffectiveContribution: 0,
          };
        },
        async readDailySteps() { return 5_129; },
        async readScoringInput() { return { generation: 8n, fingerprint: null }; },
        async claimAndCreditCoarseDelta({ effectiveContributionAtRaw }) {
          return {
            claimedRaw: 4_129,
            row: {
              coarseRawAttributed: 4_129,
              coarseEffectiveContribution:
                effectiveContributionAtRaw(5_129) -
                effectiveContributionAtRaw(1_000),
            },
          };
        },
        async replaceV3(input) {
          persisted = input;
          return { effectiveContribution: input.effectiveContribution };
        },
      },
    },
  );
  assert.equal(copied, 4_129);
  assert.equal(persisted.rawSourceKind, "COARSE_DAILY_DELTA");
  assert.equal(persisted.rawSourceHighWater, 4_129);
  assert.equal(persisted.castDailySteps, 1_000);
});

test("v3 settlement reads a frozen signed capture without reopening source data", async () => {
  let sampleReads = 0;
  const copied = await computeHitchhikeCopiedSteps(
    hitch({ metadata: { copyRatio: 1, scoringVersion: 3 } }),
    { async sumStepsInWindow() { sampleReads += 1; return 99_999; } },
    NOW,
    {
      attributionCaptureModel: {
        async findFrozen() {
          return { effectiveContribution: -750, frozenAt: T1 };
        },
      },
    },
  );
  assert.equal(copied, -750);
  assert.equal(sampleReads, 0);
});

test("collectRaceHitchhikeCopies bulk-reads the race's links and clamps per target", async () => {
  const effects = [
    hitch({ id: "hh-a", sourceUserId: "c1", targetUserId: "t1", targetParticipantId: "rp-1" }),
    hitch({ id: "hh-b", sourceUserId: "c2", targetUserId: "t2", targetParticipantId: "rp-2" }),
  ];
  let calls = 0;
  const model = {
    async findRaceEffectsByType(raceId, type) {
      calls += 1;
      assert.equal(type, "HITCHHIKE");
      return effects;
    },
  };
  const copies = await collectRaceHitchhikeCopies({
    raceId: "race-1",
    raceEndsAt: null,
    participants: [
      { id: "rp-1", userId: "t1", finishedAt: null, forfeitedAt: null },
      // t2 forfeited a quarter of the way in — their link is clamped.
      { id: "rp-2", userId: "t2", finishedAt: null, forfeitedAt: new Date("2026-07-20T12:15:00Z") },
    ],
    raceActiveEffectModel: model,
    stepSampleModel: makeStepModel({ t1: 4000, t2: 4000 }),
    now: NOW,
  });
  assert.equal(calls, 1, "exactly ONE bulk query for the whole race");
  const byEffect = Object.fromEntries(copies.map((c) => [c.effectId, c]));
  assert.equal(byEffect["hh-a"].copiedSteps, 4000);
  assert.equal(byEffect["hh-a"].sourceUserId, "c1");
  assert.equal(byEffect["hh-b"].copiedSteps, 1000, "clamped at the target's forfeit");
});

test("collectRaceHitchhikeCopies degrades to [] when the model lacks the bulk method", async () => {
  const copies = await collectRaceHitchhikeCopies({
    raceId: "race-1",
    participants: [],
    raceActiveEffectModel: {},
    stepSampleModel: makeStepModel({}),
    now: NOW,
  });
  assert.deepEqual(copies, []);
});

test("credit is summed per CASTER and added to their pre-leech total", () => {
  const copies = [
    { effectId: "e1", startsAt: T0, sourceUserId: "caster", copiedSteps: 1000 },
    { effectId: "e2", startsAt: T0, sourceUserId: "caster", copiedSteps: 500 },
    { effectId: "e3", startsAt: T0, sourceUserId: "other", copiedSteps: 700 },
  ];
  const credit = hitchhikeCreditBySourceUser(copies);
  assert.equal(credit.get("caster"), 1500);
  assert.equal(credit.get("other"), 700);

  const entries = [
    { participantId: "p1", userId: "caster", preLeechTotal: 10000, leechTransfers: [] },
    { participantId: "p2", userId: "target", preLeechTotal: 8000, leechTransfers: [] },
  ];
  const withCopies = applyHitchhikeCopies(entries, copies);
  assert.equal(withCopies[0].preLeechTotal, 11500, "caster gains the copy");
  assert.equal(withCopies[1].preLeechTotal, 8000, "the target loses NOTHING");
  assert.equal(entries[0].preLeechTotal, 10000, "input entries are not mutated");
});

test("a caster who is no longer an active participant simply drops their credit", () => {
  const copies = [{ effectId: "e1", startsAt: T0, sourceUserId: "ghost", copiedSteps: 1000 }];
  const entries = [
    { participantId: "p2", userId: "target", preLeechTotal: 8000, leechTransfers: [] },
  ];
  assert.equal(applyHitchhikeCopies(entries, copies)[0].preLeechTotal, 8000);
});
