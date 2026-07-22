const assert = require("node:assert/strict");
const test = require("node:test");
const { computeHitchhikeCopiedSteps, applyHitchhikeCopies } = require("../../src/modules/powerups/hitchhikeCopies");

const HOUR = 3600000;
const now = new Date("2026-07-22T12:30:00.000Z");
const start = new Date("2026-07-22T10:00:00.000Z");
const end = new Date("2026-07-22T12:00:00.000Z");
const samples = { async sumStepsInWindow(_userId, a, b) { return Math.round((new Date(b) - new Date(a)) / HOUR * 100); } };
function effect(scoringVersion = 2, copyRatio = 1) { return { id: "hh", targetParticipantId: "tp", targetUserId: "target", sourceUserId: "caster", startsAt: start, expiresAt: end, metadata: { copyRatio, scoringVersion } }; }
function effects(targetEffect) { return { async findEffectsForRaceByTypes(_race, _participant, types) { return Object.fromEntries(types.map((t) => [t, t === targetEffect.type ? [targetEffect] : []])); } }; }

test("Hitchhike v2 copies Runner's High effective contribution while v1 stays raw", async () => {
  const runnersHigh = { type: "RUNNERS_HIGH", startsAt: start, expiresAt: end };
  const options = { raceId: "r", targetParticipantId: "tp", raceActiveEffectModel: effects(runnersHigh) };
  assert.equal(await computeHitchhikeCopiedSteps(effect(1), samples, now, options), 200);
  assert.equal(await computeHitchhikeCopiedSteps(effect(2), samples, now, options), 400);
});

test("Hitchhike v2 carries Wrong Turn as a signed delta and floors the caster at zero", async () => {
  const wrongTurn = { type: "WRONG_TURN", startsAt: start, expiresAt: end };
  const copied = await computeHitchhikeCopiedSteps(effect(2), samples, now, { raceId: "r", targetParticipantId: "tp", raceActiveEffectModel: effects(wrongTurn) });
  assert.equal(copied, -200);
  assert.equal(await computeHitchhikeCopiedSteps(effect(2, 0.5025), samples, now, { raceId: "r", targetParticipantId: "tp", raceActiveEffectModel: effects(wrongTurn) }), -101);
  assert.equal(applyHitchhikeCopies([{ userId: "caster", preLeechTotal: 50 }], [{ sourceUserId: "caster", copiedSteps: copied }])[0].preLeechTotal, 0);
});
