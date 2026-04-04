const assert = require("node:assert/strict");
const test = require("node:test");

const { rollPowerup, interpolateOdds, RARITY_TIERS } = require("../../src/utils/powerupOdds");

test("rollPowerup returns a valid type and rarity", () => {
  const result = rollPowerup(1, 4);
  assert.ok(["COMMON", "UNCOMMON", "RARE"].includes(result.rarity));
  const allTypes = [...RARITY_TIERS.COMMON, ...RARITY_TIERS.UNCOMMON, ...RARITY_TIERS.RARE];
  assert.ok(allTypes.includes(result.type));
});

test("rollPowerup returns COMMON type when rng favors common", () => {
  // rng returns 0 => first bucket (COMMON), then 0 => first powerup in tier
  const result = rollPowerup(1, 4, () => 0);
  assert.equal(result.rarity, "COMMON");
  assert.equal(result.type, "PROTEIN_SHAKE");
});

test("rollPowerup returns RARE type when rng favors rare", () => {
  // rng returns 0.99 => last bucket (RARE), then 0.99 => last powerup in tier
  const result = rollPowerup(1, 4, () => 0.99);
  assert.equal(result.rarity, "RARE");
  assert.equal(result.type, "SWITCHEROO");
});

test("leader gets more commons than last place over many rolls", () => {
  let leaderCommons = 0;
  let lastCommons = 0;
  const iterations = 1000;

  for (let i = 0; i < iterations; i++) {
    const leaderResult = rollPowerup(1, 4);
    const lastResult = rollPowerup(4, 4);
    if (leaderResult.rarity === "COMMON") leaderCommons++;
    if (lastResult.rarity === "COMMON") lastCommons++;
  }

  assert.ok(leaderCommons > lastCommons, `Leader commons (${leaderCommons}) should exceed last place commons (${lastCommons})`);
});

test("last place gets more rares than leader over many rolls", () => {
  let leaderRares = 0;
  let lastRares = 0;
  const iterations = 1000;

  for (let i = 0; i < iterations; i++) {
    const leaderResult = rollPowerup(1, 4);
    const lastResult = rollPowerup(4, 4);
    if (leaderResult.rarity === "RARE") leaderRares++;
    if (lastResult.rarity === "RARE") lastRares++;
  }

  assert.ok(lastRares > leaderRares, `Last rares (${lastRares}) should exceed leader rares (${leaderRares})`);
});

test("interpolateOdds for leader position", () => {
  const odds = interpolateOdds(0);
  assert.equal(odds[0], 0.70);
  assert.equal(odds[1], 0.25);
  assert.equal(odds[2], 0.05);
});

test("interpolateOdds for last position", () => {
  const odds = interpolateOdds(1);
  assert.ok(Math.abs(odds[0] - 0.20) < 0.001);
  assert.ok(Math.abs(odds[1] - 0.35) < 0.001);
  assert.ok(Math.abs(odds[2] - 0.45) < 0.001);
});

test("2-player race: leader gets first-place odds, trailing gets last-place odds", () => {
  // With deterministic rng at threshold boundaries
  const leaderOdds = interpolateOdds((1 - 1) / (2 - 1)); // position 1 => 0
  const trailingOdds = interpolateOdds((2 - 1) / (2 - 1)); // position 2 => 1

  assert.equal(leaderOdds[0], 0.70);
  assert.ok(Math.abs(trailingOdds[0] - 0.20) < 0.001);
});

test("single participant gets middle odds", () => {
  const result = rollPowerup(1, 1);
  assert.ok(result.type);
  assert.ok(result.rarity);
});
