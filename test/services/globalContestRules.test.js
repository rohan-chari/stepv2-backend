const assert = require("node:assert/strict");
const test = require("node:test");

const { isAllowedBannerMessage } = require("../../src/modules/giveaways/services/validation");
const {
  generateStandardRules,
  generateStandardRulesForVersion,
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

function frozenFormatEasternIsoInstants(value) {
  let replacementIndex = 0;
  const eastern = [
    "Sep 1, 2026 at 12:00 AM EDT",
    "Oct 1, 2026 at 12:00 AM EDT",
  ];
  const formatted = value.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    () => eastern[replacementIndex++],
  );
  // Exact parity with the frozen Dart `replaceAll(RegExp, r'$1')`: Dart uses
  // the replacement literally rather than expanding capture groups.
  return formatted.replace(/\b(EDT|EST) UTC\b/g, () => "$1");
}

test("global standard rules hash is deterministic and every material field changes its version", () => {
  const first = generateStandardRules(facts());
  assert.deepEqual(first, generateStandardRules(facts()));
  assert.match(first.version, /^bara-account-v1-[0-9a-f]{24}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  const contestWindow = first.sections.find((section) => section.heading === "Contest window");
  assert.equal(
    contestWindow.body,
    "The contest runs from 2026-09-01T04:00:00.000Z through 2026-10-01T04:00:00.000Z. These server timestamps are stored in UTC. A referral counts only if it qualifies at or after you join, at or after the contest start, and before the contest end.",
  );
  assert.doesNotMatch(JSON.stringify(first.sections), /\[startsAt, endsAt\)/);
  const predecessor = generateStandardRulesForVersion(facts(), "bara-account-v1");
  assert.match(predecessor.version, /^bara-account-v1-[0-9a-f]{24}$/);
  assert.notEqual(predecessor.version, first.version);
  assert.notEqual(predecessor.hash, first.hash);
  const frozenRendered = frozenFormatEasternIsoInstants(contestWindow.body);
  assert.doesNotMatch(frozenRendered, /\$1/);
  assert.match(frozenRendered, /These server timestamps are stored in UTC\./);
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
