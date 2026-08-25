const crypto = require("node:crypto");

const GLOBAL_ELIGIBILITY_MODE = "BARA_ACCOUNT";
const LEGACY_ELIGIBILITY_MODE = "US_18";
const STANDARD_TEMPLATE_VERSION = "bara-account-v1";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function generateStandardRules(contest) {
  const startsAt = new Date(contest.startsAt).toISOString();
  const endsAt = new Date(contest.endsAt).toISOString();
  const material = {
    slug: contest.slug,
    title: contest.title,
    startsAt,
    endsAt,
    coinPrize: contest.coinPrize,
    eligibilityMode: GLOBAL_ELIGIBILITY_MODE,
    standardTemplateVersion: STANDARD_TEMPLATE_VERSION,
  };
  const version = `${STANDARD_TEMPLATE_VERSION}-${sha256(material).slice(0, 24)}`;
  const sections = [
    {
      heading: "Who can join",
      body: "Any signed-in Bara user permitted under Bara's Terms may join. One entry is allowed per Bara account/provider identity. No purchase necessary. Duplicate accounts controlled by one person are subject to fraud review.",
    },
    {
      heading: "Contest window",
      body: `The contest runs from ${startsAt} through ${endsAt} UTC. Referrals count only when they qualify after you join and during the half-open contest window [startsAt, endsAt).`,
    },
    {
      heading: "How to win",
      body: "Join and accept these rules; share your unique Bara invite; your friend signs up with it; your friend completes a qualifying race with another real player during the contest window; the eligible entrant with the most verified completed referrals wins.",
    },
    {
      heading: "Prize",
      body: `The fixed prize is ${contest.coinPrize.toLocaleString("en-US")} Bara coins. Bara coins have no monetary value and cannot be sold, transferred, withdrawn, or used outside Bara.`,
    },
    {
      heading: "Ranking and review",
      body: "The leaderboard is provisional until final review. Ties go first to the entrant who earliest reached the final verified referral count, then to the entrant with the lexicographically smallest stable entrant ID. If nobody has a verified completed referral, there is no winner. Bots, self-referrals, duplicate accounts, and dummy-account coordination are prohibited.",
    },
    {
      heading: "Platforms and sponsor",
      body: "Sponsored by Bara. Apple and Google are not sponsors, administrators, endorsers, or involved in this contest. Optional social follows or posts do not affect the contest.",
    },
  ];
  const payload = { version, sections };
  return { version, sections, hash: sha256(payload) };
}

function standardRulesAreCurrent(contest) {
  if (contest?.eligibilityMode !== GLOBAL_ELIGIBILITY_MODE) return false;
  try {
    const generated = generateStandardRules(contest);
    return contest.rulesVersion === generated.version &&
      contest.rulesHash === generated.hash &&
      canonicalJson(contest.rulesSections) === canonicalJson(generated.sections);
  } catch {
    return false;
  }
}

module.exports = {
  GLOBAL_ELIGIBILITY_MODE,
  LEGACY_ELIGIBILITY_MODE,
  STANDARD_TEMPLATE_VERSION,
  canonicalJson,
  generateStandardRules,
  sha256,
  standardRulesAreCurrent,
};
