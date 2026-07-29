const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetPowerupCopyCatalog } = require("../../src/modules/powerups/queries/getPowerupCopyCatalog");

const rows = [
  { powerupType: "STEALTH_MODE", name: "Stealth Mode", description: "Hide your name, steps, and track position for 4 hours.", shortDescription: null, upgradeTierLabels: ["Hide 4h", "Hide 5h", "Hide 6.5h", "Hide 8h"] },
  { powerupType: "HITCHHIKE", name: "Hitchhike", description: "Copy the target's raw steps.", shortDescription: null, upgradeTierLabels: [] },
  { powerupType: "QUICKSAND", name: "Quicksand", description: "Freeze up to three rivals.", shortDescription: null, upgradeTierLabels: [] },
];
const get = buildGetPowerupCopyCatalog({ PowerupCopy: { async findAll() { return rows; } } });

test("catalog copy and Quicksand visibility are request-capability scoped", async () => {
  const legacy = await get(new Set());
  assert.equal(legacy.powerups.some((p) => p.type === "QUICKSAND"), false);
  assert.match(legacy.powerups.find((p) => p.type === "STEALTH_MODE").description, /4 hours/);
  assert.match(legacy.powerups.find((p) => p.type === "HITCHHIKE").description, /raw steps/);

  const capable = await get(new Set(["powerups4", "stealth_runner_duration", "hitchhike_effective_steps"]));
  // §3.4 standardization (2026-07-25, supersedes the 07-24 nerf): stealth
  // duration is server-computed and uniform, so the DB row is the single source
  // of label truth for EVERY client — `stealth_runner_duration` must no longer
  // swap in the dead 60/75/90/120 ladder (prod bug 2026-07-29: newest builds
  // showed "Hide 90m" for a use that actually ran 3h).
  assert.deepEqual(capable.powerups.find((p) => p.type === "STEALTH_MODE").upgradeTierLabels, ["Hide 4h", "Hide 5h", "Hide 6.5h", "Hide 8h"]);
  assert.match(capable.powerups.find((p) => p.type === "STEALTH_MODE").description, /4 hours/);
  assert.match(capable.powerups.find((p) => p.type === "HITCHHIKE").description, /boosts and reversals/i);
  assert.equal(capable.powerups.some((p) => p.type === "QUICKSAND"), true);
});
