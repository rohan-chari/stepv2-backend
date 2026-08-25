const crypto = require("node:crypto");
const { ValidationError } = require("../../../shared/errors/AppError");
const {
  formatCoins,
  formatUsd,
  hasEnabledPrize,
  isCashMinor,
  isCoinPrize,
} = require("./prize");

const US_REGIONS = new Set([
  "US-AL", "US-AK", "US-AZ", "US-AR", "US-CA", "US-CO", "US-CT", "US-DE", "US-DC",
  "US-FL", "US-GA", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY",
  "US-LA", "US-ME", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT",
  "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NY", "US-NC", "US-ND", "US-OH",
  "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT",
  "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "US-WY",
]);
const SOCIAL_HOSTS = {
  instagram: new Set(["instagram.com", "www.instagram.com"]),
  tiktok: new Set(["tiktok.com", "www.tiktok.com"]),
  x: new Set(["x.com", "www.x.com"]),
  facebook: new Set(["facebook.com", "www.facebook.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com"]),
};
const BANNER_PREFIX = "Bara(?: Referral)? (?:Contest|Giveaway): win ";
const BANNER_SUFFIX = "\\.(?: Ends [A-Za-z0-9 ,.-]{1,80}\\.)?";
const GENERIC_BANNER_TEMPLATE = new RegExp(
  `^${BANNER_PREFIX}(?:US\\$[0-9][0-9,]*(?:\\.[0-9]{2})?|[1-9][0-9,]* (?:Bara )?coins|US\\$[0-9][0-9,]*(?:\\.[0-9]{2})? (?:\\+|and) [1-9][0-9,]* (?:Bara )?coins)${BANNER_SUFFIX}$`,
  "i",
);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedBannerMessage(value, contest = null) {
  if (typeof value !== "string" || value.length > 240) return false;
  const message = value.trim();
  if (!contest) return GENERIC_BANNER_TEMPLATE.test(message);
  if (!hasEnabledPrize(contest) || contest.cashCurrency !== "USD") return false;
  const cash = contest.cashMinor > 0 ? escapeRegex(formatUsd(contest.cashMinor)) : null;
  const coins = contest.coinPrize > 0 ? escapeRegex(formatCoins(contest.coinPrize, { bara: false })) : null;
  let prize;
  if (cash && coins) prize = `${cash} (?:\\+|and) ${coins.replace(" coins", " (?:Bara )?coins")}`;
  else if (cash) prize = cash;
  else prize = coins.replace(" coins", " (?:Bara )?coins");
  return new RegExp(`^${BANNER_PREFIX}${prize}${BANNER_SUFFIX}$`, "i").test(message);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rulesHash(rules) {
  return crypto.createHash("sha256").update(canonicalJson(rules)).digest("hex");
}

function invalid(message, code = "INVALID_CONTEST", meta) {
  throw new ValidationError(message, code, meta);
}

function exactKeys(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function normalizeContestInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Invalid contest body", "INVALID_BODY");
  const contestKeys = new Set([
    "slug", "title", "governingTimeZone", "startsAt", "endsAt",
    "cashCurrency", "cashMinor", "coinPrize", "minimumAge",
    "eligibleRegions", "sponsor", "rules", "socialLinks", "bannerMessage",
  ]);
  if (!exactKeys(input, contestKeys)) invalid("Invalid contest body", "INVALID_BODY");
  const out = {};
  const required = (key) => {
    if (!partial && input[key] === undefined) invalid(`${key} is required`, "INVALID_CONTEST");
    return input[key];
  };
  const slug = required("slug");
  if (slug !== undefined) {
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) invalid("Invalid slug", "INVALID_SLUG");
    out.slug = slug;
  }
  const title = required("title");
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length < 1 || title.trim().length > 120) invalid("Invalid title", "INVALID_TITLE");
    out.title = title.trim();
  }
  const zone = required("governingTimeZone");
  if (zone !== undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date()); } catch { invalid("Invalid governing timezone", "INVALID_TIMEZONE"); }
    out.governingTimeZone = zone;
  }
  for (const key of ["startsAt", "endsAt"]) {
    const value = required(key);
    if (value !== undefined) {
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) invalid(`Invalid ${key}`, "INVALID_DATE");
      out[key] = date;
    }
  }
  const cashCurrency = required("cashCurrency");
  if (cashCurrency !== undefined) { if (cashCurrency !== "USD") invalid("V1 prize currency must be USD", "INVALID_PRIZE"); out.cashCurrency = cashCurrency; }
  const cashMinor = required("cashMinor");
  if (cashMinor !== undefined) { if (!isCashMinor(cashMinor)) invalid("cashMinor must be an integer from 0 through 2147483647", "INVALID_PRIZE"); out.cashMinor = cashMinor; }
  const coinPrize = required("coinPrize");
  if (coinPrize !== undefined) { if (!isCoinPrize(coinPrize)) invalid("coinPrize must be an integer from 0 through 1000000", "INVALID_PRIZE"); out.coinPrize = coinPrize; }
  if (cashMinor === 0 && coinPrize === 0) invalid("At least one prize must be enabled", "INVALID_PRIZE");
  const minimumAge = required("minimumAge");
  if (minimumAge !== undefined) { if (minimumAge !== 18) invalid("V1 minimum age must be 18", "INVALID_MINIMUM_AGE"); out.minimumAge = minimumAge; }
  const eligibleRegions = required("eligibleRegions");
  if (eligibleRegions !== undefined) {
    const unique = new Set(Array.isArray(eligibleRegions) ? eligibleRegions : []);
    if (!Array.isArray(eligibleRegions) || unique.size !== US_REGIONS.size ||
        [...US_REGIONS].some((region) => !unique.has(region)) ||
        eligibleRegions.some((region) => !US_REGIONS.has(region))) {
      invalid("Eligibility must include exactly the 50 states and D.C.", "INVALID_REGION");
    }
    out.eligibleRegions = [...US_REGIONS].sort();
    out.eligibleCountries = ["US"];
  }
  const sponsor = required("sponsor");
  if (sponsor !== undefined) {
    if (!exactKeys(sponsor, new Set(["legalName", "mailingAddress"]))) invalid("Invalid sponsor body", "INVALID_BODY");
    if (!sponsor || typeof sponsor.legalName !== "string" || typeof sponsor.mailingAddress !== "string" || sponsor.legalName.trim().length > 200 || sponsor.mailingAddress.trim().length > 500) invalid("Invalid sponsor", "INVALID_SPONSOR");
    out.sponsor = { legalName: sponsor.legalName.trim(), mailingAddress: sponsor.mailingAddress.trim() };
  }
  const rules = required("rules");
  if (rules !== undefined) {
    if (!exactKeys(rules, new Set(["version", "sections"]))) invalid("Invalid rules body", "INVALID_BODY");
    if (!rules || typeof rules.version !== "string" || rules.version.trim().length < 1 || rules.version.length > 80 || !Array.isArray(rules.sections) || rules.sections.length < 1 || rules.sections.length > 20) invalid("Invalid rules", "INVALID_RULES");
    let total = 0;
    const sections = rules.sections.map((section) => {
      if (!exactKeys(section, new Set(["heading", "body"]))) invalid("Invalid rules section body", "INVALID_BODY");
      if (!section || typeof section.heading !== "string" || typeof section.body !== "string") invalid("Invalid rules section", "INVALID_RULES");
      const heading = section.heading.trim(); const body = section.body.trim(); total += Buffer.byteLength(heading) + Buffer.byteLength(body);
      if (!heading || heading.length > 120 || !body || body.length > 8000 || total > 24000) invalid("Rules content is too large", "INVALID_RULES");
      return { heading, body };
    });
    out.rulesVersion = rules.version.trim(); out.rulesSections = sections; out.rulesHash = rulesHash({ version: out.rulesVersion, sections });
  }
  const socialLinks = input.socialLinks === undefined && partial ? undefined : (input.socialLinks || []);
  if (socialLinks !== undefined) {
    if (!Array.isArray(socialLinks) || socialLinks.length > 5) invalid("Invalid social links", "INVALID_SOCIAL_LINKS");
    out.socialLinks = socialLinks.map((link) => {
      if (!exactKeys(link, new Set(["platform", "label", "url"]))) invalid("Invalid social link body", "INVALID_BODY");
      if (!link || typeof link.platform !== "string" || typeof link.label !== "string" || typeof link.url !== "string" || !SOCIAL_HOSTS[link.platform]) invalid("Invalid social link", "INVALID_SOCIAL_LINKS");
      let url; try { url = new URL(link.url); } catch { invalid("Invalid social URL", "INVALID_SOCIAL_LINKS"); }
      if (url.protocol !== "https:" || !SOCIAL_HOSTS[link.platform].has(url.hostname) || link.label.trim().length < 1 || link.label.length > 50) invalid("Invalid social URL", "INVALID_SOCIAL_LINKS");
      return { platform: link.platform, label: link.label.trim(), url: url.toString() };
    });
  }
  const banner = required("bannerMessage");
  if (banner !== undefined) { if (typeof banner !== "string" || banner.trim().length < 1 || banner.trim().length > 240) invalid("Invalid banner message", "INVALID_BANNER"); out.bannerMessage = banner.trim(); }
  const mergedStart = out.startsAt || (input.startsAt ? new Date(input.startsAt) : null);
  const mergedEnd = out.endsAt || (input.endsAt ? new Date(input.endsAt) : null);
  if (mergedStart && mergedEnd && mergedStart >= mergedEnd) invalid("Contest start must precede end", "INVALID_DATE_RANGE");
  return out;
}

function publishValidationFields(contest) {
  const fields = [];
  const sponsorText = `${contest.sponsor?.legalName || ""} ${contest.sponsor?.mailingAddress || ""}`;
  if (!contest.sponsor?.legalName || !contest.sponsor?.mailingAddress || /placeholder/i.test(sponsorText)) fields.push("sponsor");
  const copy = (contest.rulesSections || []).map((section) => `${section.heading} ${section.body}`).join(" ").toLowerCase();
  if (!copy.includes("no purchase necessary")) fields.push("rules.noPurchase");
  if (!copy.includes("apple")) fields.push("rules.appleDisclaimer");
  if (!copy.includes("google")) fields.push("rules.googleDisclaimer");
  if (!hasEnabledPrize(contest) || contest.cashCurrency !== "USD") fields.push("prize");
  if (!isAllowedBannerMessage(contest.bannerMessage, contest)) fields.push("bannerMessage");
  return fields.slice(0, 10);
}

module.exports = { US_REGIONS, isAllowedBannerMessage, normalizeContestInput, publishValidationFields, rulesHash };
