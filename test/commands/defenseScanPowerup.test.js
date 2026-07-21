const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup } = require("../../src/modules/powerups/commands/usePowerup");

// ---------------------------------------------------------------------------
// DEFENSE_SCAN — shipped as "X-Ray" (Item 2). An instantaneous intel read: it
// creates NO effect and writes NO feed event (silent recon), consumes one
// scanner, and returns a snapshot of every opponent's active defenses
// (Compression Socks / Mirror) in the use RESULT (surfaced at the top level by
// the route). In team races it reveals only the enemy team.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-17T12:00:00Z");

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 10000,
    bonusSteps: 0,
    finishedAt: null,
    powerupSlots: 3,
    team: null,
    user: { displayName },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const feedEvents = [];
  const effectsCreated = [];
  let updatedPowerup = null;

  const user1 = makeParticipant("rp-1", "user-1", "Alice", overrides.user1);
  const user2 = makeParticipant("rp-2", "user-2", "Bob", overrides.user2);
  const user3 = makeParticipant("rp-3", "user-3", "Carol", overrides.user3);
  const participants = [user1, user2, user3];
  const existingEffects = overrides.existingEffects || {};

  return {
    feedEvents,
    effectsCreated,
    get updatedPowerup() { return updatedPowerup; },
    deps: {
      RacePowerup: {
        async findById(id) {
          return { id, userId: "user-1", raceId: "race-1", type: "DEFENSE_SCAN", status: "HELD", rarity: null };
        },
        async update(id, fields) { updatedPowerup = { id, ...fields }; return updatedPowerup; },
        async findHeldByParticipant() { return []; },
        async findUsedTypesByParticipant() { return []; },
      },
      RaceParticipant: {
        async addBonusSteps() {},
        async subtractBonusSteps() {},
        async updatePowerupSlots() {},
        async updateNextBoxAtSteps() {},
        async findById(id) { return participants.find((p) => p.id === id); },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipant() { return null; },
        async findActiveForParticipant(participantId) { return existingEffects[participantId] || []; },
        async findActiveForRace() { return []; },
        async create(data) { const e = { id: `eff-${effectsCreated.length + 1}`, ...data }; effectsCreated.push(e); return e; },
        async update() {},
      },
      RacePowerupEvent: {
        async create(data) { feedEvents.push(data); return { id: "fe-1", ...data }; },
      },
      Race: {
        async findById() {
          return { id: "race-1", status: "ACTIVE", isTeamRace: overrides.isTeamRace || false, targetSteps: 50000, participants };
        },
      },
      eventBus: { emit() {} },
      now: () => NOW,
    },
  };
}

test("X-Ray returns each opponent's active defenses, consumes the scanner, creates no effect + no feed event", async () => {
  const socksExpiry = new Date(NOW.getTime() + 60 * 60 * 1000);
  const ctx = makeDeps({
    existingEffects: {
      "rp-2": [{ type: "COMPRESSION_SOCKS", expiresAt: socksExpiry }, { type: "LEG_CRAMP", expiresAt: socksExpiry }],
      "rp-3": [{ type: "MIRROR", expiresAt: socksExpiry }],
    },
  });
  const use = buildUsePowerup(ctx.deps);

  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });

  assert.ok(result.scan, "scan present on the result");
  assert.ok(Array.isArray(result.scan.opponents));
  const byUser = Object.fromEntries(result.scan.opponents.map((o) => [o.userId, o]));

  // user-2 (Bob): only defenses surface — the LEG_CRAMP is not a defense.
  assert.deepEqual(byUser["user-2"].defenses.map((d) => d.type), ["COMPRESSION_SOCKS"]);
  assert.equal(byUser["user-2"].displayName, "Bob");
  // user-3 (Carol): a Mirror is up.
  assert.deepEqual(byUser["user-3"].defenses.map((d) => d.type), ["MIRROR"]);
  // Self is never in the scan.
  assert.equal(byUser["user-1"], undefined);

  // Consumes the scanner; silent recon => no effect, no feed event.
  assert.equal(ctx.updatedPowerup.status, "USED");
  assert.equal(ctx.effectsCreated.length, 0);
  assert.equal(ctx.feedEvents.length, 0, "silent recon writes no feed event");
});

test("X-Ray shows an empty defenses list for an opponent with no defenses", async () => {
  const ctx = makeDeps(); // no effects anywhere
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  for (const opp of result.scan.opponents) {
    assert.deepEqual(opp.defenses, []);
  }
});

test("X-Ray reveals only the ENEMY team in a team race", async () => {
  const ctx = makeDeps({
    isTeamRace: true,
    user1: { team: "TEAM_A" },
    user2: { team: "TEAM_A" }, // teammate — must NOT appear
    user3: { team: "TEAM_B" }, // enemy — appears
  });
  const use = buildUsePowerup(ctx.deps);
  const result = await use({ userId: "user-1", raceId: "race-1", powerupId: "pw-1" });
  const ids = result.scan.opponents.map((o) => o.userId).sort();
  assert.deepEqual(ids, ["user-3"], "only the enemy-team opponent is revealed");
});
