const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildOpenMysteryBox,
} = require("../../src/modules/powerups/commands/openMysteryBox");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// docs/team-only-drop-pool-requirements.md §5.5 / §9 test 10.
//
// The two hard gates added in §5.4 sit OUTSIDE the empty-pool fallback, so for
// the first time `pickTypeForRarity` can legitimately return null. No caller
// handled that before this change, and the failure mode is the worst kind: a
// box the player already tapped writing a NULL type onto the row.
//
// Rule: null -> re-roll once at the tier below (RARITY_ORDER order) -> if that
// is also null, award PROTEIN_SHAKE. Never persist null, never throw.
//
// A unit test because it is unreachable through the public path with any
// shippable config (UNCOMMON holds 4 types of which 1 is gated, so the tier can
// never actually empty in production) — and it must be defined anyway, because
// "unreachable today" is exactly how a later drop-pool edit turns into a 500.

function makeDeps({ config, rolled }) {
  const updates = [];
  const powerup = {
    id: "pw-1",
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    type: null,
    rarity: null,
    status: "MYSTERY_BOX",
  };

  return {
    updates,
    deps: {
      RacePowerup: {
        async findById(id) {
          return id === powerup.id ? powerup : null;
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { ...powerup, ...fields };
        },
        async countOccupiedSlots() {
          return 0;
        },
      },
      RaceParticipant: {
        async findByRaceAndUser() {
          return { id: "rp-1", userId: "user-1", totalSteps: 5000, powerupSlots: 3, team: "TEAM_A" };
        },
        async findAcceptedByRace() {
          return [
            { id: "rp-1", userId: "user-1", totalSteps: 5000, team: "TEAM_A" },
            { id: "rp-2", userId: "user-2", totalSteps: 3000, team: "TEAM_B" },
          ];
        },
        async update() {},
      },
      Race: {
        async findById() {
          return { id: "race-1", status: "ACTIVE", isTeamRace: false };
        },
      },
      RacePowerupEvent: {
        async create(data) {
          return { id: "fe-1", ...data };
        },
      },
      eventBus: { emit() {} },
      balanceConfig: {
        async getSnapshot() {
          return { version: 42, config };
        },
      },
      // Force the tier the cascade starts from; the type is null because the
      // hard gates emptied that tier.
      rollPowerupOdds: () => ({ ...rolled }),
    },
  };
}

function gatedConfig({ common, uncommon, rare }) {
  const config = defaultConfig();
  config.teamOnlyTypes = ["RALLY_FLAG"];
  config.storeOnlyTypes = config.storeOnlyTypes.filter((t) => t !== "RALLY_FLAG");
  config.typeWeights = {};
  config.positionRules = {
    leaderExcluded: [],
    lastPlaceExcluded: [],
    leadingDownweight: {},
    trailingDownweight: {},
    leadingDownweightFrom: 0.4,
    trailingDownweightFrom: 0.6,
  };
  config.dropPool = { COMMON: common, UNCOMMON: uncommon, RARE: rare };
  return config;
}

test("a null roll cascades one tier DOWN rather than persisting null", async () => {
  // RARE is entirely hard-gated (solo race, so RALLY_FLAG is removed) -> null.
  // UNCOMMON below it is reachable, so that is what the player gets.
  const config = gatedConfig({
    common: ["PROTEIN_SHAKE"],
    uncommon: ["STEALTH_MODE"],
    rare: ["RALLY_FLAG"],
  });
  const { deps, updates } = makeDeps({ config, rolled: { type: null, rarity: "RARE" } });
  const openMysteryBox = buildOpenMysteryBox(deps);

  const result = await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Tester",
  });

  assert.equal(result.type, "STEALTH_MODE");
  assert.equal(result.rarity, "UNCOMMON");
  const write = updates.find((u) => u.fields.status === "HELD");
  assert.ok(write, "the box must be persisted as HELD");
  assert.equal(write.fields.type, "STEALTH_MODE");
  assert.notEqual(write.fields.type, null);
});

test("a null roll with the tier below also empty awards PROTEIN_SHAKE", async () => {
  const config = gatedConfig({
    common: [],
    uncommon: ["RALLY_FLAG"],
    rare: ["RALLY_FLAG"],
  });
  const { deps, updates } = makeDeps({ config, rolled: { type: null, rarity: "UNCOMMON" } });
  const openMysteryBox = buildOpenMysteryBox(deps);

  const result = await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Tester",
  });

  assert.equal(result.type, "PROTEIN_SHAKE");
  assert.equal(result.rarity, "COMMON");
  const write = updates.find((u) => u.fields.status === "HELD");
  assert.equal(write.fields.type, "PROTEIN_SHAKE");
});

test("a null roll at the BOTTOM tier awards PROTEIN_SHAKE without throwing", async () => {
  // COMMON has no tier below it — the cascade must terminate, not index -1.
  const config = gatedConfig({ common: ["RALLY_FLAG"], uncommon: [], rare: [] });
  const { deps, updates } = makeDeps({ config, rolled: { type: null, rarity: "COMMON" } });
  const openMysteryBox = buildOpenMysteryBox(deps);

  const result = await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Tester",
  });

  assert.equal(result.type, "PROTEIN_SHAKE");
  const write = updates.find((u) => u.fields.status === "HELD");
  assert.equal(write.fields.type, "PROTEIN_SHAKE");
});

test("a normal roll is untouched by the cascade", async () => {
  const config = gatedConfig({
    common: ["PROTEIN_SHAKE"],
    uncommon: ["STEALTH_MODE"],
    rare: ["COMPRESSION_SOCKS"],
  });
  const { deps } = makeDeps({
    config,
    rolled: { type: "COMPRESSION_SOCKS", rarity: "RARE" },
  });
  const openMysteryBox = buildOpenMysteryBox(deps);

  const result = await openMysteryBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Tester",
  });
  assert.equal(result.type, "COMPRESSION_SOCKS");
  assert.equal(result.rarity, "RARE");
});
