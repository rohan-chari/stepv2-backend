function iso(value) {
  return value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null;
}

function deriveContestStatus(contest, now = new Date()) {
  if (!contest) return null;
  if (["DRAFT", "FINAL", "CANCELLED", "ARCHIVED"].includes(contest.lifecycleStatus)) {
    return contest.lifecycleStatus;
  }
  if (now < new Date(contest.startsAt)) return "SCHEDULED";
  if (now < new Date(contest.endsAt)) return "ACTIVE";
  return "VERIFYING";
}

function publicContest(contest, now = new Date(), { includeRulesUrl = false } = {}) {
  const rules = {
    version: contest.rulesVersion,
    sha256: contest.rulesHash,
    sections: Array.isArray(contest.rulesSections) ? contest.rulesSections : [],
    ...(includeRulesUrl
      ? { url: `https://barastep.com/giveaways/${encodeURIComponent(contest.slug)}/rules` }
      : {}),
  };
  return {
    slug: contest.slug,
    title: contest.title,
    status: deriveContestStatus(contest, now),
    startsAt: iso(contest.startsAt),
    endsAt: iso(contest.endsAt),
    governingTimeZone: contest.governingTimeZone,
    prize: {
      ...(contest.cashMinor > 0 ? { cashCurrency: contest.cashCurrency, cashMinor: contest.cashMinor } : {}),
      ...(contest.coinPrize > 0 ? { coins: contest.coinPrize } : {}),
    },
    minimumAge: contest.minimumAge,
    eligibleCountries: Array.isArray(contest.eligibleCountries) ? contest.eligibleCountries : ["US"],
    eligibleRegions: Array.isArray(contest.eligibleRegions) ? contest.eligibleRegions : [],
    sponsor: contest.sponsor && typeof contest.sponsor === "object" ? contest.sponsor : null,
    rules,
    socialLinks: Array.isArray(contest.socialLinks) ? contest.socialLinks : [],
    ...(contest.publicReason ? { publicReason: contest.publicReason } : {}),
  };
}

function adminContest(contest, now = new Date(), counts = {}) {
  return {
    id: contest.id,
    revision: contest.revision,
    slug: contest.slug,
    title: contest.title,
    status: deriveContestStatus(contest, now),
    lifecycleStatus: contest.lifecycleStatus,
    governingTimeZone: contest.governingTimeZone,
    startsAt: iso(contest.startsAt),
    endsAt: iso(contest.endsAt),
    cashCurrency: contest.cashCurrency,
    cashMinor: contest.cashMinor,
    coinPrize: contest.coinPrize,
    minimumAge: contest.minimumAge,
    eligibleCountries: Array.isArray(contest.eligibleCountries) ? contest.eligibleCountries : ["US"],
    eligibleRegions: Array.isArray(contest.eligibleRegions) ? contest.eligibleRegions : [],
    sponsor: contest.sponsor,
    rules: {
      version: contest.rulesVersion,
      sha256: contest.rulesHash,
      sections: Array.isArray(contest.rulesSections) ? contest.rulesSections : [],
    },
    socialLinks: Array.isArray(contest.socialLinks) ? contest.socialLinks : [],
    bannerMessage: contest.bannerMessage,
    publicReason: contest.publicReason || null,
    amendedRulesVersion: contest.amendedRulesVersion || null,
    counts: {
      entrants: Number(counts.entrants || 0),
      reviewableFacts: Number(counts.reviewableFacts || 0),
      rankedResults: Number(counts.rankedResults || 0),
    },
    publishedAt: iso(contest.publishedAt),
    frozenAt: iso(contest.frozenAt),
    finalizedAt: iso(contest.finalizedAt),
    cancelledAt: iso(contest.cancelledAt),
    archivedAt: iso(contest.archivedAt),
    createdAt: iso(contest.createdAt),
    updatedAt: iso(contest.updatedAt),
  };
}

module.exports = { adminContest, deriveContestStatus, iso, publicContest };
