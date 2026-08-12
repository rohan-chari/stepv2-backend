const crypto = require("node:crypto");
const { hashAppleSub } = require("../../users/appleSubHash");

const ROLLOUT_SETTING = "racePayoutDoubleRolloutPercent";
const CAPABILITY = "race_payout_double";
const MAX_ROLLOUT = 100;

function providerSubHash(user) {
  return hashAppleSub(user?.appleId || user?.googleSub || null);
}

function cohortBucket(hash) {
  if (typeof hash !== "string" || hash.length === 0) return null;
  const digest = crypto
    .createHash("sha256")
    .update(`race_payout_double:v1:${hash}`, "utf8")
    .digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) + BigInt(digest[index]);
  }
  return Number(value % 100n);
}

function boundedRolloutPercent(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ROLLOUT
    ? value
    : 0;
}

function canonicalUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function safeStructuredEvent(logger, event) {
  try {
    const fn = logger?.info || logger?.log;
    if (typeof fn !== "function") return;
    const result = fn.call(logger, JSON.stringify(event));
    // Observability is deliberately fire-and-forget. Attach a rejection
    // handler without awaiting so async transports cannot create an unhandled
    // rejection or alter the economic request's status/latency.
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {}
}

module.exports = {
  ROLLOUT_SETTING,
  CAPABILITY,
  providerSubHash,
  cohortBucket,
  boundedRolloutPercent,
  canonicalUuid,
  safeStructuredEvent,
};
