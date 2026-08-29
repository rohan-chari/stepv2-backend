const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  canonicalRollAvailabilityForClient,
} = require("../../src/modules/powerups/powerupOdds");
const {
  defaultConfig,
} = require("../../src/modules/economy/balanceConfig.defaults");

test("canonical roll availability unions every legal rarity/position/mode with positive weight", () => {
  const config = defaultConfig();
  config.dropPool.COMMON.push("GHOST_PEPPER");
  config.typeWeights.GHOST_PEPPER = 1;
  config.typeWeights.PROTEIN_SHAKE = 0;

  const legacy = canonicalRollAvailabilityForClient({
    config,
    clientCapabilities: { supportsPowerups5: false },
  });
  const current = canonicalRollAvailabilityForClient({
    config,
    clientCapabilities: { supportsPowerups5: true },
  });

  assert.ok(!legacy.has("GHOST_PEPPER"), "capability hard gate is preserved");
  assert.ok(current.has("GHOST_PEPPER"));
  assert.ok(!current.has("PROTEIN_SHAKE"), "zero effective weight is unavailable");
  assert.ok(current.has("RALLY_FLAG"), "team-only roll contexts are included");
  assert.ok(current.has("RED_CARD"), "a type surviving at any legal position is included");
});

test("catalog availability imports the canonical roller helper and carries no second drop list", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../../src/modules/powerups/queries/getPowerupCopyCatalog.js",
    ),
    "utf8",
  );
  assert.match(source, /canonicalRollAvailabilityForClient/);
  assert.doesNotMatch(source, /dropPool\s*[:=]/);
  assert.doesNotMatch(source, /ROLL_AVAILABLE_TYPES|ROLL_POWERUP_TYPES/);
});
