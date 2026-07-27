const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Structural guard for docs/team-only-drop-pool-requirements.md §5.4/§5.6.
//
// The two hard gates in eligiblePoolFor are keyed off the roll context. A
// WHOLLY absent ctx deliberately means "no filtering at all" — that is this
// module's long-standing contract and the seeded Monte Carlo guard in
// balanceConfigService.test.js depends on it. The gates are therefore only as
// safe as the promise that every production roll and disclosure site actually
// BUILDS a ctx.
//
// That promise cannot be expressed as a behavioural test (it is a statement
// about the shape of the codebase, not about any one response), so it is
// asserted over source here. If this fails you have added a roll site that
// silently bypasses the wave-5 compatibility gate.

const SRC = path.join(__dirname, "..", "..", "src");

function read(...parts) {
  return fs.readFileSync(path.join(SRC, ...parts), "utf8");
}

test("both production roll/disclosure sites build a roll context with BOTH gate fields", () => {
  const sites = [
    {
      file: ["modules", "powerups", "commands", "openMysteryBox.js"],
      label: "the in-race roll",
    },
    {
      file: ["modules", "races", "queries", "getRaceProgress.js"],
      label: "the odds disclosure",
    },
  ];

  for (const site of sites) {
    const source = read(...site.file);
    assert.match(
      source,
      /buildRollContext\(\{/,
      `${site.label} must derive its context from the shared buildRollContext`
    );
    const block = source.slice(source.indexOf("buildRollContext({"));
    const call = block.slice(0, block.indexOf("});") + 3);
    assert.match(call, /isTeamRace:/, `${site.label} must pass isTeamRace`);
    assert.match(call, /supportsPowerups5/, `${site.label} must pass supportsPowerups5`);
  }
});

test("both mystery-box open routes forward the powerups5 client feature", () => {
  const routes = read("modules", "races", "routes.js");

  for (const [label, marker] of [
    ["POST /:raceId/powerups/:powerupId/open", "openMysteryBox({"],
    ["POST /:raceId/powerups/open-batch", "openMysteryBoxBatch({"],
  ]) {
    const start = routes.indexOf(marker);
    assert.ok(start !== -1, `${label} call site not found`);
    const call = routes.slice(start, routes.indexOf("});", start) + 3);
    assert.match(
      call,
      /supportsPowerups5:\s*req\.clientFeatures\?\.has\("powerups5"\)/,
      `${label} must forward the powerups5 token — gating one open path and not the other is the whole failure mode this guards`
    );
  }
});

test("the hard gates are applied AFTER the empty-pool fallback in eligiblePoolFor", () => {
  // §5.4's single most important ordering constraint. The fallback restores the
  // UNFILTERED pool; a compatibility gate applied before it would be silently
  // undone, handing a frozen client the exact item the gate exists to prevent.
  const source = read("modules", "powerups", "powerupOdds.js");
  const fallback = source.indexOf("if (pool.length === 0) pool = basePool.slice();");
  const teamGate = source.indexOf("cfg.teamOnlyTypes");
  const p5Gate = source.indexOf("POWERUPS5_GATED_TYPES.includes(type)");

  assert.ok(fallback !== -1, "the empty-pool fallback should still exist");
  assert.ok(teamGate !== -1 && p5Gate !== -1, "both hard gates should exist");
  assert.ok(teamGate > fallback, "the teamOnly gate must come AFTER the empty-pool fallback");
  assert.ok(p5Gate > fallback, "the powerups5 gate must come AFTER the empty-pool fallback");
});
