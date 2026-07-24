// Turtle Shell — the pure gate/animal/type/RNG truth table, plus the 1000-roll
// statistical guard (§10.11). Both properties are unreachable through the public
// path at a sane cost: an HTTP test can pin ONE roll (which the integration
// suite does), not the distribution over a thousand of them.
const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const {
  shellBlocksAttack,
  isTurtle,
  isRaceRolledType,
  SHELL_BLOCK_CHANCE,
} = require("../../src/modules/races/services/characterPowers");

function userWith(assetKey) {
  if (!assetKey) return { equippedAccessories: [] };
  return {
    equippedAccessories: [{ shopItem: { slot: "CHARACTER", assetKey } }],
  };
}

const TURTLE = userWith("turtle");

describe("Turtle Shell helpers", () => {
  beforeEach(() => {
    process.env.CHARACTER_POWERS_ENABLED = "true";
    delete process.env.TURTLE_SHELL_DISABLED;
  });
  afterEach(() => {
    delete process.env.CHARACTER_POWERS_ENABLED;
    delete process.env.TURTLE_SHELL_DISABLED;
  });

  it("isTurtle matches only turtle-keyed CHARACTER items", () => {
    assert.equal(isTurtle(userWith("turtle")), true);
    assert.equal(isTurtle(userWith("turtle_shell")), true);
    assert.equal(isTurtle(userWith("corgi_puppy")), false);
    assert.equal(isTurtle(userWith(null)), false);
    assert.equal(isTurtle(null), false);
    assert.equal(isTurtle(undefined), false);
  });

  it("isRaceRolledType reads the drop pool, not a hardcoded list", () => {
    for (const type of ["LEG_CRAMP", "WRONG_TURN", "DETOUR_SIGN", "PINECONE_TOSS", "RED_CARD", "SNEAKY_SWAP", "SHORTCUT"]) {
      assert.equal(isRaceRolledType(type), true, type);
    }
    for (const type of ["IMPOSTER", "RAINSTORM", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE", "DRILL_SERGEANT", "BOUNTY", "POWER_OUTAGE", "QUICKSAND", "UPRISING", "GHOST_PEPPER"]) {
      assert.equal(isRaceRolledType(type), false, type);
    }
    assert.equal(isRaceRolledType(null), false);
    // An injected config overrides the live one.
    assert.equal(
      isRaceRolledType("RAINSTORM", { dropPool: { COMMON: ["RAINSTORM"] } }),
      true
    );
  });

  it("truth table: gate × kill switch × animal × type × RNG", () => {
    const low = () => 0.01;
    const high = () => 0.99;
    const base = { targetUser: TURTLE, powerupType: "LEG_CRAMP" };

    assert.equal(shellBlocksAttack({ ...base, random: low }), true);
    assert.equal(shellBlocksAttack({ ...base, random: high }), false);

    // Boundary: strictly less than the chance.
    assert.equal(shellBlocksAttack({ ...base, random: () => SHELL_BLOCK_CHANCE }), false);
    assert.equal(
      shellBlocksAttack({ ...base, random: () => SHELL_BLOCK_CHANCE - 1e-9 }),
      true
    );

    // Store-exclusive type — never blockable.
    assert.equal(
      shellBlocksAttack({ ...base, powerupType: "RAINSTORM", random: low }),
      false
    );

    // Wrong animal.
    assert.equal(
      shellBlocksAttack({ ...base, targetUser: userWith("corgi_puppy"), random: low }),
      false
    );
    assert.equal(
      shellBlocksAttack({ ...base, targetUser: userWith(null), random: low }),
      false
    );
    assert.equal(shellBlocksAttack({ ...base, targetUser: null, random: low }), false);

    // Feature gate off.
    process.env.CHARACTER_POWERS_ENABLED = "false";
    assert.equal(shellBlocksAttack({ ...base, random: low }), false);

    // Gate on, kill switch on.
    process.env.CHARACTER_POWERS_ENABLED = "true";
    process.env.TURTLE_SHELL_DISABLED = "true";
    assert.equal(shellBlocksAttack({ ...base, random: low }), false);
  });

  // §10.11 statistical guard.
  it("blocks ~30% of the time over 1000 real rolls", () => {
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      if (shellBlocksAttack({ targetUser: TURTLE, powerupType: "LEG_CRAMP" })) blocked += 1;
    }
    const rate = blocked / 1000;
    assert.ok(rate >= 0.25 && rate <= 0.35, `block rate ${rate} outside [0.25, 0.35]`);
  });
});
