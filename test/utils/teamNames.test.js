const assert = require("node:assert/strict");
const test = require("node:test");

const {
  TEAM_NAME_POOL,
  generateTeamNamePair,
} = require("../../src/constants/teamNames");
const { censor } = require("../../src/lib/profanity");
const { TEAM_NAME_MAX_LENGTH } = require("../../src/services/validateRaceConfig");

// TR-103 REGRESSION GUARD — the highest-value test in this file. Team names are
// auto-assigned to every team race, so a single cheeky pool entry would ship
// straight to users with nobody typing it. This pins the whole pool against the
// SAME profanity filter that gates creator overrides, plus the length cap and
// the >=50 floor, so adding a bad name to the pool fails CI immediately.
test("TR-103 every pooled team name passes the profanity filter", () => {
  const dirty = TEAM_NAME_POOL.filter((n) => censor(n) !== n);
  assert.deepEqual(dirty, [], `pool names rejected by censor: ${dirty.join(", ")}`);
});

test("TR-103 every pooled name is within the 24-char cap and the pool is >= 50", () => {
  const tooLong = TEAM_NAME_POOL.filter((n) => n.length > TEAM_NAME_MAX_LENGTH);
  assert.deepEqual(tooLong, [], `pool names over ${TEAM_NAME_MAX_LENGTH} chars: ${tooLong.join(", ")}`);
  assert.ok(
    TEAM_NAME_POOL.length >= 50,
    `TR-103 requires >= 50 names, pool has ${TEAM_NAME_POOL.length}`
  );
});

test("TR-103 generated pairs are always clean (pool + generator agree)", () => {
  for (let i = 0; i < 100; i++) {
    const [a, b] = generateTeamNamePair();
    assert.equal(censor(a), a, `generated teamAName was censored: ${a}`);
    assert.equal(censor(b), b, `generated teamBName was censored: ${b}`);
  }
});

// TR-103: backend pool of >= 50 playful adjective+animal team names.
test("TR-103 team name pool has at least 50 distinct playful names", () => {
  assert.ok(Array.isArray(TEAM_NAME_POOL), "pool is an array");
  assert.ok(
    TEAM_NAME_POOL.length >= 50,
    `pool must have >= 50 names, got ${TEAM_NAME_POOL.length}`
  );
  const unique = new Set(TEAM_NAME_POOL.map((n) => n.toLowerCase()));
  assert.equal(unique.size, TEAM_NAME_POOL.length, "no duplicate names");
});

// TR-103: every name obeys the 24-char cap so a generated name is always a
// legal creator override too.
test("TR-103 every pool name is non-empty and <= 24 chars", () => {
  for (const name of TEAM_NAME_POOL) {
    assert.equal(typeof name, "string");
    assert.ok(name.trim().length > 0, `"${name}" non-empty`);
    assert.ok(name.length <= 24, `"${name}" within 24 chars`);
  }
});

// TR-103: server auto-generates TWO DISTINCT names at creation.
test("TR-103 generateTeamNamePair returns two case-insensitively distinct names", () => {
  for (let i = 0; i < 200; i++) {
    const [a, b] = generateTeamNamePair();
    assert.equal(typeof a, "string");
    assert.equal(typeof b, "string");
    assert.notEqual(
      a.toLowerCase(),
      b.toLowerCase(),
      `pair #${i} must differ (got ${a} / ${b})`
    );
    assert.ok(TEAM_NAME_POOL.includes(a));
    assert.ok(TEAM_NAME_POOL.includes(b));
  }
});

// Deterministic injection point so callers/tests can control the pick.
test("TR-103 generateTeamNamePair accepts an injected rng", () => {
  const seq = [0, 0]; // both index 0 first -> second must be nudged to differ
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  const [a, b] = generateTeamNamePair(rng);
  assert.notEqual(a.toLowerCase(), b.toLowerCase());
});
