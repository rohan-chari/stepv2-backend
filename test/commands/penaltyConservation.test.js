const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyPotionEnemyAttack,
} = require("../../src/modules/powerups/commands/usePowerup");
const {
  evaluateDrillSergeant,
} = require("../../src/modules/powerups/commands/expireEffects");

test("Mystery Potion Shortcut transfers and reports only the atomic actual penalty", async () => {
  const caster = { id: "caster-p", userId: "caster", totalSteps: 0, user: { displayName: "Caster" } };
  const victim = { id: "victim-p", userId: "victim", totalSteps: 1000, user: { displayName: "Victim" } };
  const impactCalls = [];
  const credits = [];
  const result = { blocked: false, outcome: "APPLIED" };

  const handled = await applyPotionEnemyAttack({
    rolled: "SHORTCUT",
    aliveEnemies: [victim],
    acceptedParticipants: [caster, victim],
    isAliveTarget: () => true,
    isTeamRace: false,
    userId: caster.userId,
    myParticipant: caster,
    myDisplayName: "Caster",
    effectModel: {
      async findActiveByTypeForParticipant() { return null; },
    },
    participantModel: {
      async applyPenaltyAtomic(id, nominalPenalty) {
        assert.equal(id, victim.id);
        assert.equal(nominalPenalty, 1000);
        return { actualPenalty: 250 };
      },
      async addBonusSteps(id, amount) { credits.push({ id, amount }); },
    },
    eventModel: { async create() {} },
    async createDirectImpactEvent(event, impact) {
      impactCalls.push({ event, impact });
      return {};
    },
    resolveTimedEffectBoundary: async () => {},
    events: { async emit() {} },
    random: () => 0,
    now: () => new Date("2026-08-26T12:00:00.000Z"),
    currentTime: new Date("2026-08-26T12:00:00.000Z"),
    raceId: "race",
    powerupId: "potion",
    result,
    casterStealthed: false,
  });

  assert.equal(handled, true);
  assert.equal(result.stolen, 250);
  assert.deepEqual(credits, [{ id: caster.id, amount: 250 }]);
  assert.equal(impactCalls[0].event.metadata.stolen, 250);
  assert.deepEqual(impactCalls[0].impact.deltas, [
    { userId: victim.userId, deltaSteps: -250 },
    { userId: caster.userId, deltaSteps: 250 },
  ]);
});

test("Drill Sergeant expiry metadata and delta use the atomic actual penalty", async () => {
  const events = [];
  const outcome = await evaluateDrillSergeant({
    effect: {
      id: "drill",
      raceId: "race",
      targetParticipantId: "victim-p",
      targetUserId: "victim",
      sourceUserId: "caster",
      startsAt: new Date("2026-08-26T10:00:00.000Z"),
      expiresAt: new Date("2026-08-26T11:00:00.000Z"),
      metadata: { goalSteps: 3000, penaltySteps: 1500 },
    },
    participantModel: {
      async subtractBonusSteps() { return { actualPenalty: 175 }; },
    },
    eventModel: { async create(event) { events.push(event); } },
    raceModel: {
      async findById() {
        return { status: "ACTIVE", endsAt: new Date("2026-08-27T00:00:00.000Z") };
      },
    },
    stepSampleModel: {
      async sumStepsInWindow() { return 0; },
    },
  });

  assert.deepEqual(outcome, { outcome: "FAILED", deltaSteps: -175 });
  assert.equal(events[0].metadata.penalty, 175);
  assert.match(events[0].description, /175/);
});
