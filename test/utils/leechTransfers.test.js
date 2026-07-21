const assert = require("node:assert/strict");
const test = require("node:test");

const {
  leechRatio,
  computeLeechEarnedTransfer,
  applyLeechTransfers,
} = require("../../src/modules/powerups/leechTransfers");

// A uniform-rate step model over [winStart, winEnd] for one user.
function uniformModel(stepsByUser, winStart, winEnd) {
  const ws = winStart.getTime();
  const we = winEnd.getTime();
  return {
    async sumStepsInWindow(userId, start, end) {
      const steps = stepsByUser[userId] || 0;
      const os = Math.max(ws, new Date(start).getTime());
      const oe = Math.min(we, new Date(end).getTime());
      if (oe <= os) return 0;
      return Math.round(steps * ((oe - os) / (we - ws)));
    },
  };
}

test("leechRatio defaults absent/malformed metadata to 2", () => {
  assert.equal(leechRatio({}), 2);
  assert.equal(leechRatio({ metadata: {} }), 2);
  assert.equal(leechRatio({ metadata: { ratio: 0 } }), 2);
  assert.equal(leechRatio({ metadata: { ratio: -1 } }), 2);
  assert.equal(leechRatio({ metadata: { ratio: 3 } }), 3);
  assert.equal(leechRatio({ metadata: { ratio: 2, scoringVersion: 2 } }), 2);
});

test("earnedTransfer is floor(attackerSteps / 2), no cap", async () => {
  // Effect spanned a full past hour (13:00-13:30); measure at 15:00 so the whole
  // window is closed (not the in-progress hour). Leecher walked 10000 -> 5000.
  const winStart = new Date("2026-07-17T13:00:00Z");
  const winEnd = new Date("2026-07-17T13:30:00Z");
  const now = new Date("2026-07-17T15:00:00Z");
  const effect = { sourceUserId: "S", startsAt: winStart, expiresAt: winEnd, metadata: { ratio: 2 } };
  const model = uniformModel({ S: 10000 }, winStart, winEnd);
  assert.equal(await computeLeechEarnedTransfer(effect, model, now), 5000);
});

test("remainders carry: odd step counts floor down (1 -> 0, 3 -> 1)", async () => {
  const winStart = new Date("2026-07-17T13:00:00Z");
  const winEnd = new Date("2026-07-17T13:30:00Z");
  const now = new Date("2026-07-17T15:00:00Z");
  const effect = { sourceUserId: "S", startsAt: winStart, expiresAt: winEnd };
  assert.equal(
    await computeLeechEarnedTransfer(effect, uniformModel({ S: 1 }, winStart, winEnd), now),
    0
  );
  assert.equal(
    await computeLeechEarnedTransfer(effect, uniformModel({ S: 3 }, winStart, winEnd), now),
    1
  );
});

test("the in-progress hour bucket is excluded from the window", async () => {
  // Effect started 30 min ago and is still active; now is mid-hour, so the whole
  // window falls inside the current (still-accumulating) hour -> nothing counts yet.
  const now = new Date("2026-07-17T13:45:00Z");
  const winStart = new Date("2026-07-17T13:15:00Z");
  const effect = { sourceUserId: "S", startsAt: winStart, expiresAt: null };
  // Model returns steps for any sub-window, but computeLeechEarnedTransfer should
  // clamp windowEnd to 13:00 (top of current hour) < winStart -> 0.
  const model = {
    async sumStepsInWindow() {
      return 9999;
    },
  };
  assert.equal(await computeLeechEarnedTransfer(effect, model, now), 0);
});

test("a leecher with no source user or no steps drains nothing", async () => {
  const now = new Date("2026-07-17T15:00:00Z");
  const winStart = new Date("2026-07-17T13:00:00Z");
  const winEnd = new Date("2026-07-17T13:30:00Z");
  assert.equal(
    await computeLeechEarnedTransfer({ startsAt: winStart, expiresAt: winEnd }, uniformModel({}, winStart, winEnd), now),
    0
  );
  assert.equal(
    await computeLeechEarnedTransfer({ sourceUserId: "S", startsAt: winStart, expiresAt: winEnd }, uniformModel({ S: 0 }, winStart, winEnd), now),
    0
  );
});

test("applyLeechTransfers is zero-sum: victim -N, attacker +N", () => {
  const finals = applyLeechTransfers([
    { participantId: "v", userId: "V", preLeechTotal: 10000, leechTransfers: [{ effectId: "e1", startsAt: new Date(0), sourceUserId: "A", earnedTransfer: 2000 }] },
    { participantId: "a", userId: "A", preLeechTotal: 5000, leechTransfers: [] },
  ]);
  assert.equal(finals.get("v"), 8000);
  assert.equal(finals.get("a"), 7000);
});

test("target floor: victim at 40 funds at most 40 even if earnedTransfer is huge", () => {
  const finals = applyLeechTransfers([
    { participantId: "v", userId: "V", preLeechTotal: 40, leechTransfers: [{ effectId: "e1", startsAt: new Date(0), sourceUserId: "A", earnedTransfer: 100000 }] },
    { participantId: "a", userId: "A", preLeechTotal: 0, leechTransfers: [] },
  ]);
  assert.equal(finals.get("v"), 0);
  assert.equal(finals.get("a"), 40);
});

test("two leechers resolve by (startsAt, effectId) without minting or going negative", () => {
  // Victim has 5000; leecher A (earlier) wants 4000, leecher B wants 4000.
  // A takes 4000 (victim -> 1000), B takes min(4000, 1000) = 1000 (victim -> 0).
  // Total drained 5000 == total credited 5000.
  const finals = applyLeechTransfers([
    {
      participantId: "v", userId: "V", preLeechTotal: 5000,
      leechTransfers: [
        { effectId: "eB", startsAt: new Date("2026-07-17T12:10:00Z"), sourceUserId: "B", earnedTransfer: 4000 },
        { effectId: "eA", startsAt: new Date("2026-07-17T12:00:00Z"), sourceUserId: "A", earnedTransfer: 4000 },
      ],
    },
    { participantId: "a", userId: "A", preLeechTotal: 0, leechTransfers: [] },
    { participantId: "b", userId: "B", preLeechTotal: 0, leechTransfers: [] },
  ]);
  assert.equal(finals.get("v"), 0);
  assert.equal(finals.get("a"), 4000);
  assert.equal(finals.get("b"), 1000);
  // Zero-sum
  assert.equal(finals.get("a") + finals.get("b"), 5000 - finals.get("v"));
});

test("a leech whose attacker is not an active participant still drains the victim (credit dropped)", () => {
  const finals = applyLeechTransfers([
    { participantId: "v", userId: "V", preLeechTotal: 1000, leechTransfers: [{ effectId: "e1", startsAt: new Date(0), sourceUserId: "GHOST", earnedTransfer: 300 }] },
  ]);
  assert.equal(finals.get("v"), 700);
});
