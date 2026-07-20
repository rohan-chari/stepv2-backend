const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// LEECH scoring math (§5, 2:1 UNCAPPED transfer). A LEECH effect on victim V,
// sourced by leecher S, TRANSFERS steps from V to S: floor(S's in-window steps /
// ratio) — ratio defaults to 2 — is drained from V (floored at 0) and CREDITED to
// S. There is NO per-use cap; the victim's balance is the only ceiling. The
// in-progress hour bucket is excluded so the transfer is monotonic. The SAME
// computeEffectModifiers + applyLeechTransfers drive display AND settlement, so a
// settlement re-check (calculateCurrentTotal) must agree with the display math.
//
// This suite was REWRITTEN from the retired 3:1/cap-1000/cap-3000 debuff (see the
// backend agent's report for the enumerated assertion changes) per an explicit,
// authorized product decision.
// ---------------------------------------------------------------------------

const { computeEffectModifiers } = require("../../src/queries/getRaceProgress");
const { applyLeechTransfers } = require("../../src/utils/leechTransfers");
const { calculateCurrentTotal } = require("../../src/services/raceStateResolution");

const T0 = new Date("2026-07-17T12:00:00Z");
const T1 = new Date("2026-07-17T12:30:00Z"); // 30-min window end
// `now` sits in a LATER hour so the [12:00,12:30] window is a CLOSED bucket (the
// in-progress-hour exclusion only drops the hour containing `now`).
const NOW = new Date("2026-07-17T14:00:00Z");

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
    async findByUserIdAndTimeRange() { return []; },
  };
}

function leech(sourceUserId, overrides = {}) {
  return {
    id: `leech-${sourceUserId}`,
    type: "LEECH",
    startsAt: T0,
    expiresAt: T1,
    status: "ACTIVE",
    sourceUserId,
    targetUserId: "victim",
    metadata: { ratio: 2, scoringVersion: 2 },
    ...overrides,
  };
}

// Resolve a victim + a set of leechers through the real scorer. Returns the
// victim's final total and a per-leecher credit lookup. Attacker participants
// start at preLeechTotal 0 so their final total IS their leech credit.
async function resolve(effects, victimSteps, stepsByUser, now = NOW) {
  const model = makeStepModel({ victim: victimSteps, ...stepsByUser });
  const vm = await computeEffectModifiers(effects, victimSteps, "victim", model, true, null, now);
  const victimPre = Math.max(
    0,
    victimSteps - vm.frozenSteps + vm.buffedSteps - 2 * vm.reversedSteps
  );
  const entries = [
    { participantId: "pv", userId: "victim", preLeechTotal: victimPre, leechTransfers: vm.leechTransfers },
  ];
  for (const uid of Object.keys(stepsByUser)) {
    entries.push({ participantId: `p_${uid}`, userId: uid, preLeechTotal: 0, leechTransfers: [] });
  }
  const finals = applyLeechTransfers(entries);
  return {
    victim: finals.get("pv"),
    credit: (uid) => finals.get(`p_${uid}`) || 0,
  };
}

test("0 and 1 attacker steps transfer 0", async () => {
  const zero = await resolve([leech("a")], 10000, { a: 0 });
  assert.equal(zero.victim, 10000);
  assert.equal(zero.credit("a"), 0);
  const one = await resolve([leech("a")], 10000, { a: 1 });
  assert.equal(one.victim, 10000, "floor(1/2) = 0 transferred");
  assert.equal(one.credit("a"), 0);
});

test("2 attacker steps transfer 1 (2:1)", async () => {
  const r = await resolve([leech("a")], 10000, { a: 2 });
  assert.equal(r.victim, 9999);
  assert.equal(r.credit("a"), 1);
});

test("10,000 walked transfers 5,000 with NO ceiling (old 1,000/3,000 cap is gone)", async () => {
  const r = await resolve([leech("a")], 20000, { a: 10000 });
  assert.equal(r.victim, 15000, "20000 - floor(10000/2) = 15000; no cap clamps it to 17000/19000");
  assert.equal(r.credit("a"), 5000);
});

test("the transfer is zero-sum: victim -N, attacker +N", async () => {
  const r = await resolve([leech("a")], 10000, { a: 4000 });
  assert.equal(r.victim, 8000); // -2000
  assert.equal(r.credit("a"), 2000); // +2000
});

test("only the leeched portion of the window counts (partial window)", async () => {
  const halfway = new Date("2026-07-17T12:15:00Z");
  // Leecher walks 2000 over the full window -> 1000 over the half -> floor/2 = 500.
  const r = await resolve([leech("a", { expiresAt: halfway })], 10000, { a: 2000 });
  assert.equal(r.victim, 9500);
  assert.equal(r.credit("a"), 500);
});

test("target floor is the ONLY limiter: victim at 40 funds at most 40", async () => {
  // Attacker earns floor(10000/2)=5000, but the victim only has 40 to give.
  const r = await resolve([leech("a")], 40, { a: 10000 });
  assert.equal(r.victim, 0);
  assert.equal(r.credit("a"), 40, "attacker credited actualTransfer (40), not earnedTransfer (5000)");
});

test("two leechers resolve by (startsAt, id) without minting or going negative", async () => {
  // Victim 5000. Leecher A (earlier) earns floor(9000/2)=4500 -> takes 4500 (victim->500).
  // Leecher B earns 4500 but only 500 remains -> takes 500 (victim->0). Total 5000.
  const la = leech("a", { id: "e-a", startsAt: T0 });
  const lb = leech("b", { id: "e-b", startsAt: new Date("2026-07-17T12:05:00Z") });
  const r = await resolve([la, lb], 5000, { a: 9000, b: 9000 });
  assert.equal(r.victim, 0);
  assert.equal(r.credit("a"), 4500);
  assert.equal(r.credit("b"), 500);
  assert.equal(r.credit("a") + r.credit("b"), 5000, "zero-sum: total credited == drained");
});

test("the in-progress hour is excluded, and the transfer never decreases across recomputes", async () => {
  // A live (not-yet-expired) leech measured while `now` is inside its window: the
  // whole window falls in the current hour, so nothing transfers YET (monotonic).
  const live = leech("a", { expiresAt: null });
  const midHour = new Date("2026-07-17T12:20:00Z");
  const early = await resolve([live], 10000, { a: 4000 }, midHour);
  assert.equal(early.victim, 10000, "current-hour steps are excluded until the bucket closes");
  // Once the hour has closed (now advanced past it), the window counts and the
  // transferred amount only grows.
  const later = await resolve([live], 10000, { a: 4000 }, NOW);
  assert.ok(later.credit("a") >= early.credit("a"), "transfer is monotonic");
  assert.equal(later.credit("a"), 2000);
});

test("metadata `ratio` is read: ratio:2 and ABSENT metadata score identically", async () => {
  const withRatio = await resolve([leech("a", { metadata: { ratio: 2 } })], 10000, { a: 4000 });
  const absent = await resolve([leech("a", { metadata: undefined })], 10000, { a: 4000 });
  assert.equal(withRatio.credit("a"), 2000);
  assert.equal(absent.credit("a"), 2000, "absent metadata defaults to ratio 2");
  assert.equal(withRatio.victim, absent.victim);
});

test("settlement (calculateCurrentTotal) matches the display math for leech", async () => {
  const stepsByUser = { victim: 10000, leecher: 4000 };
  const l = leech("leecher");
  const effectModel = {
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      const byType = {};
      for (const t of types) byType[t] = [];
      if (types.includes("LEECH")) byType.LEECH = [l];
      return byType;
    },
  };
  // calculateCurrentTotal returns the PRE-LEECH total + leechTransfers; a single
  // participant caller (like sync-v2 reconcile) then drains via applyLeechTransfers.
  const { total, leechTransfers } = await calculateCurrentTotal({
    raceId: "race-1",
    racePowerupsEnabled: true,
    participant: { id: "rp-v", userId: "victim", bonusSteps: 0 },
    baseAdjusted: stepsByUser.victim,
    hasSampleData: true,
    raceActiveEffectModel: effectModel,
    stepSampleModel: makeStepModel(stepsByUser),
    now: NOW,
  });
  assert.equal(total, 10000, "pre-leech total");
  const finals = applyLeechTransfers([
    { participantId: "rp-v", userId: "victim", preLeechTotal: total, leechTransfers },
  ]);
  assert.equal(finals.get("rp-v"), 8000, "victim drained by floor(4000/2)=2000");
  // ...and equals the display path.
  const display = await resolve([l], 10000, { leecher: 4000 });
  assert.equal(display.victim, 8000);
});
