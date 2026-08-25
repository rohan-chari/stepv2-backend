const assert = require("node:assert/strict");
const test = require("node:test");

const { isAllowedBannerMessage } = require("../../src/modules/giveaways/services/validation");
const {
  generateStandardRules,
  standardRulesAreCurrent,
} = require("../../src/modules/giveaways/services/standardRules");

function facts(overrides = {}) {
  return {
    slug: "september-trail",
    title: "September Trail",
    startsAt: new Date("2026-09-01T04:00:00.000Z"),
    endsAt: new Date("2026-10-01T04:00:00.000Z"),
    coinPrize: 5000,
    eligibilityMode: "BARA_ACCOUNT",
    ...overrides,
  };
}

test("global standard rules hash is deterministic and every material field changes its version", () => {
  const first = generateStandardRules(facts());
  assert.deepEqual(first, generateStandardRules(facts()));
  assert.match(first.version, /^bara-account-v1-[0-9a-f]{24}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  for (const changed of [
    { slug: "october-trail" },
    { title: "October Trail" },
    { startsAt: new Date("2026-09-02T04:00:00.000Z") },
    { endsAt: new Date("2026-10-02T04:00:00.000Z") },
    { coinPrize: 5001 },
  ]) {
    assert.notEqual(generateStandardRules(facts(changed)).version, first.version);
  }
  assert.equal(standardRulesAreCurrent({
    ...facts(), rulesVersion: first.version, rulesHash: first.hash, rulesSections: first.sections,
  }), true);
});

test("global banner validation normalizes Unicode and rejects currency, redemption, controls, and bounds", () => {
  const contest = { eligibilityMode: "BARA_ACCOUNT" };
  assert.equal(isAllowedBannerMessage("Bring your crew. The trail is open.", contest), true);
  assert.equal(isAllowedBannerMessage("Ｂｒｉｎｇ your crew to the trail.", contest), true);
  for (const value of [
    "short",
    "x".repeat(97),
    "Win $50 on the trail",
    "Redeem your prize today",
    "Get money through PayPal",
    "Bring your crew\nThe trail is open",
  ]) assert.equal(isAllowedBannerMessage(value, contest), false, value);
});
