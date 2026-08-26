const VERIFIED_STATUSES = new Set(["QUALIFIED", "REWARDED"]);

function classifyReferralFact(fact, review = null) {
  if (review?.decision === "REJECT") return "REJECTED";
  if (VERIFIED_STATUSES.has(fact?.status) ||
      (fact?.status === "FLAGGED" && review?.decision === "APPROVE")) {
    return "VERIFIED";
  }
  if (fact?.status === "FLAGGED" && !review) return "REVIEWABLE";
  return "UNCOUNTED";
}

module.exports = { classifyReferralFact };
