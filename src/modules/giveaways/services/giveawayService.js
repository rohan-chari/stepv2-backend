const crypto = require("node:crypto");
const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { AppError, ConflictError, NotFoundError, ValidationError } = require("../../../shared/errors/AppError");
const { getOrCreateReferralCode } = require("../../social");
const { hasPendingReferralQualificationIntents } = require("../../social");
const { acquireReferralQualificationFence, approveFlaggedReferralReward } = require("../../social");
const { adminContest, deriveContestStatus, iso, publicContest } = require("../models/contest");
const { getContestStandings, getFinalStandings } = require("../queries/getContestStandings");
const { getCurrentContest } = require("../queries/getCurrentContest");
const { isAllowedBannerMessage, normalizeContestInput, publishValidationFields } = require("./validation");
const { hasEnabledPrize } = require("./prize");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { invalidateActiveContestBannerCache } = require("../queries/activeContestBanner");
const { validateDisplayName } = require("../../../shared/lib/displayNameValidator");
const { buildDeleteDraftContest } = require("../commands/deleteDraftContest");
const { createGiveawayIdempotency, UUID_V4 } = require("./idempotency");
const { GLOBAL_ELIGIBILITY_MODE, generateStandardRules } = require("./standardRules");
const { implicatedFactsForEntrant, unresolvedGlobalOutcomeFacts } = require("./globalOutcomeReview");

function supportsGlobalContest(clientFeatures) {
  return clientFeatures?.has?.("referral_contest_global_v1") === true;
}

function identityHash(user, env = process.env) {
  const provider = user?.appleId ? "apple" : user?.googleSub ? "google" : null;
  const subject = user?.appleId || user?.googleSub;
  const version = Number(env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION || 1);
  const secret = env[`GIVEAWAY_ENTRANT_HMAC_SECRET_V${version}`];
  if (!provider || !subject || !secret) throw new AppError("Contest identity verification unavailable", "INTERNAL_ERROR", 500);
  return {
    version,
    hash: `v${version}:${crypto.createHmac("sha256", secret).update(`${provider}:${subject}`).digest("hex")}`,
  };
}

function identityHashes(user, env = process.env) {
  const provider = user?.appleId ? "apple" : user?.googleSub ? "google" : null;
  const subject = user?.appleId || user?.googleSub;
  if (!provider || !subject) throw new AppError("Contest identity verification unavailable", "INTERNAL_ERROR", 500);
  const active = Number(env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION || 1);
  const retained = Object.keys(env)
    .map((key) => /^GIVEAWAY_ENTRANT_HMAC_SECRET_V(\d+)$/.exec(key)?.[1])
    .filter(Boolean)
    .map(Number);
  const versions = [...new Set([active, ...retained])].sort((a, b) => b - a);
  const hashes = versions.flatMap((version) => {
    const secret = env[`GIVEAWAY_ENTRANT_HMAC_SECRET_V${version}`];
    return secret ? [{
      version,
      hash: `v${version}:${crypto.createHmac("sha256", secret).update(`${provider}:${subject}`).digest("hex")}`,
    }] : [];
  });
  const activeHash = hashes.find((entry) => entry.version === active);
  if (!activeHash) throw new AppError("Contest identity verification unavailable", "INTERNAL_ERROR", 500);
  return { active: activeHash, all: hashes };
}

function parseLimit(value, { fallback, max }) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) throw new ValidationError("Invalid limit", "INVALID_LIMIT");
  const limit = Number(value);
  if (limit < 1 || limit > max) throw new ValidationError("Invalid limit", "INVALID_LIMIT");
  return limit;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")); } catch { throw new ValidationError("Invalid cursor", "INVALID_CURSOR"); }
}

function exactBody(body, allowed, code = "INVALID_BODY") {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ValidationError("Invalid request body", code);
  }
}

function normalizedAuditBody(action, body) {
  if (!body || typeof body !== "object") return null;
  const safe = { ...body };
  delete safe.privateNote;
  if (safe.providerReference !== undefined) safe.providerReference = "[REDACTED]";
  return safe;
}

function visibleLifecycle(contest) {
  return contest && ["PUBLISHED", "FINAL", "CANCELLED", "ARCHIVED"].includes(contest.lifecycleStatus);
}

function publicWinner(results) {
  const winner = results.find((row) => row.resultStatus === "VERIFIED");
  return winner ? { displayName: winner.displayName, originalRank: winner.finalRank } : null;
}

function leaderboardRows(rows, limit) {
  return rows.filter((row) => row.verifiedCount > 0).slice(0, limit).map((row) => ({
    rank: row.finalRank || row.provisionalRank,
    displayName: row.displayName,
    completedCount: row.verifiedCount,
  }));
}

function fulfillmentPayload(row) {
  if (!row) return null;
  return {
    status: row.cashStatus,
    provider: row.cashProvider || null,
    providerReference: row.providerReference ? "••••" : null,
    cashSentMinor: row.cashSentMinor,
    cashSentCurrency: row.cashSentCurrency,
    claimedAt: iso(row.claimedAt),
    cashSentAt: iso(row.cashSentAt),
    cashDeliveredAt: iso(row.cashDeliveredAt),
    coinsAwardedAt: iso(row.coinsAwardedAt),
    coinTransactionId: row.coinTransactionId || null,
    fulfilledAt: iso(row.fulfilledAt),
  };
}

async function countsFor(db, contest, standings = null) {
  const [entrants, rankedResults] = await Promise.all([
    db.giveawayEntrant.count({ where: { contestId: contest.id } }),
    db.giveawayResult.count({ where: { entrant: { contestId: contest.id } } }),
  ]);
  const rows = standings || (contest.lifecycleStatus === "DRAFT" ? [] : await getContestStandings(contest, { db }));
  return { entrants, rankedResults, reviewableFacts: rows.reduce((sum, row) => sum + row.reviewableCount, 0) };
}

async function fullAdminContest(db, contest, now) {
  return adminContest(contest, now, await countsFor(db, contest));
}

async function adminResult(db, contest) {
  const results = await db.giveawayResult.findMany({ where: { entrant: { contestId: contest.id } }, include: { entrant: true }, orderBy: { finalRank: "asc" } });
  const potential = results.find((row) => row.status === "POTENTIAL");
  const verified = results.find((row) => row.status === "VERIFIED");
  return {
    rankedCount: results.length,
    noWinner: contest.lifecycleStatus === "FINAL" && !verified,
    potentialWinner: potential ? { entrantId: potential.entrantId, displayName: potential.entrant.displayNameSnapshot, originalRank: potential.finalRank } : null,
    verifiedWinner: verified ? { entrantId: verified.entrantId, displayName: verified.entrant.displayNameSnapshot, originalRank: verified.finalRank } : null,
  };
}

function buildGiveawayService(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const nowFn = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;
  const award = dependencies.awardCoins || awardCoins;
  const appSettings = dependencies.appSettings || defaultAppSettings;
  const { withIdempotency } = createGiveawayIdempotency({ db, env });
  const deleteDraftContest = buildDeleteDraftContest({ db, withIdempotency });

  async function contestById(id, clientFeatures = null) {
    const contest = await db.giveawayContest.findUnique({ where: { id } });
    if (!contest || (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE && !supportsGlobalContest(clientFeatures))) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
    return contest;
  }
  async function publicBySlug(slug) {
    const contest = await db.giveawayContest.findUnique({ where: { slug } });
    if (!visibleLifecycle(contest)) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
    return contest;
  }
  async function current() { return getCurrentContest({ db, now: nowFn() }); }

  async function publicData(slug, limitValue) {
    const limit = parseLimit(limitValue, { fallback: 25, max: 50 });
    const contest = await publicBySlug(slug);
    const final = Boolean(contest.finalizedAt) &&
      ["PUBLISHED", "FINAL", "ARCHIVED"].includes(contest.lifecycleStatus);
    const cancelled = Boolean(contest.cancelledAt) && !contest.finalizedAt;
    const rows = cancelled ? [] : final ? await getFinalStandings(contest, { db }) : await getContestStandings(contest, { db });
    return {
      contest: publicContest(contest, nowFn(), { includeRulesUrl: true }),
      leaderboard: leaderboardRows(rows, limit),
      winner: final ? publicWinner(rows) : null,
      updatedAt: iso(contest.updatedAt),
    };
  }

  async function memberCurrent(user, limitValue = 25, clientFeatures = null) {
    const contest = await current();
    if (!contest) return { contest: null, leaderboard: [], entry: null, standing: null, share: null };
    if (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE && !supportsGlobalContest(clientFeatures)) {
      return { contest: null, leaderboard: [], entry: null, standing: null, share: null };
    }
    const rows = contest.lifecycleStatus === "FINAL" ? await getFinalStandings(contest, { db }) : await getContestStandings(contest, { db });
    const identities = identityHashes(user, env);
    let entry = await db.giveawayEntrant.findUnique({ where: { contestId_userId: { contestId: contest.id, userId: user.id } } });
    if (!entry) entry = await db.giveawayEntrant.findFirst({ where: { contestId: contest.id, entrantIdentityHash: { in: identities.all.map((identity) => identity.hash) } } });
    const row = entry ? rows.find((candidate) => candidate.entrantId === entry.id) : null;
    let share = null;
    if (!entry || entry.status !== "WITHDRAWN") {
      const code = await getOrCreateReferralCode({ userId: user.id });
      share = { code, url: `https://barastep.com/r/${encodeURIComponent(code)}` };
    }
    return {
      contest: publicContest(contest, nowFn()),
      leaderboard: leaderboardRows(rows, parseLimit(limitValue, { fallback: 25, max: 50 })),
      winner: contest.lifecycleStatus === "FINAL" ? publicWinner(rows) : null,
      entry: entry ? {
        status: entry.status,
        acceptedAt: iso(entry.rulesAcceptedAt),
        region: entry.region,
        displayName: entry.displayNameSnapshot,
      } : {
        status: "ACTION_REQUIRED", acceptedAt: null, region: null,
        displayName: user.displayName || "",
      },
      standing: entry?.status === "WITHDRAWN" ? null : {
        verifiedCount: row?.verifiedCount || 0,
        reviewableCount: contest.lifecycleStatus === "FINAL" ? 0 : (row?.reviewableCount || 0),
        provisionalRank: row?.finalRank || row?.provisionalRank || null,
        reachedCountAt: iso(row?.reachedCountAt),
      },
      share: entry?.status === "WITHDRAWN" ? null : share,
    };
  }

  async function enter(slug, user, body, clientFeatures = null) {
    const contest = await publicBySlug(slug);
    if (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE && !supportsGlobalContest(clientFeatures)) {
      throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
    }
    const account = await db.user.findUnique({ where: { id: user.id }, select: { isReviewAccount: true, displayName: true } });
    if (account?.isReviewAccount) throw new ConflictError("Review accounts cannot enter contests", "ENTRY_INELIGIBLE");
    const identities = identityHashes(user, env);
    const identity = identities.active;
    const existing = await db.giveawayEntrant.findFirst({ where: { contestId: contest.id, OR: [{ userId: user.id }, { entrantIdentityHash: { in: identities.all.map((candidate) => candidate.hash) } }] } });
    const global = contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE;
    const allowed = new Set(global
      ? ["rulesVersion", "rulesAccepted"]
      : ["rulesVersion", "country", "region", "ageConfirmed", "residencyConfirmed", "rulesAccepted"]);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) throw new ValidationError("Invalid entry body", "INVALID_BODY");
    const exact = existing && existing.status === "ELIGIBLE" && body.rulesVersion === existing.acceptedRulesVersion && body.rulesAccepted === true && (global || (body.country === existing.country && body.region === existing.region && body.ageConfirmed === true && body.residencyConfirmed === true));
    if (exact) return { created: false, entry: serializeEntry(existing, global) };
    if (existing) throw new ConflictError("Contest entry is immutable", "ENTRY_IMMUTABLE");
    if (deriveContestStatus(contest, nowFn()) !== "ACTIVE") throw new ConflictError("Contest is not open", "CONTEST_NOT_OPEN");
    if (body.rulesVersion !== contest.rulesVersion) throw new ConflictError("Official Rules changed", "RULES_CHANGED", { currentRulesVersion: contest.rulesVersion });
    if (body.rulesAccepted !== true) throw new ValidationError("Rules acceptance is required", "RULES_ACCEPTANCE_REQUIRED");
    if (!global) {
      if (body.ageConfirmed !== true) throw new ValidationError("Age confirmation is required", "AGE_CONFIRMATION_REQUIRED");
      if (body.residencyConfirmed !== true || body.country !== "US") throw new ValidationError("U.S. residency confirmation is required", "RESIDENCY_CONFIRMATION_REQUIRED");
      if (!Array.isArray(contest.eligibleRegions) || !contest.eligibleRegions.includes(body.region)) throw new ValidationError("Region is not eligible", "INVALID_REGION");
    }
    const displayValidation = global ? validateDisplayName(account?.displayName) : null;
    if (global && !displayValidation.isValid) throw new ConflictError("A valid Bara display name is required", "DISPLAY_NAME_REQUIRED");
    const displayName = global
      ? displayValidation.normalized
      : (typeof user.displayName === "string" ? user.displayName.trim() : "");
    if (!global && (!displayName || displayName.length > 50)) throw new ValidationError("A valid Bara display name is required", "INVALID_DISPLAY_NAME");
    const at = nowFn();
    let lostCreateRace = false;
    const entry = await db.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: user.id, entrantIdentityHash: identity.hash, identityHashVersion: identity.version,
      status: "ELIGIBLE", country: global ? null : "US", region: global ? null : body.region,
      ageConfirmedAt: global ? null : at, residencyConfirmedAt: global ? null : at, rulesAcceptedAt: at,
      acceptedRulesVersion: contest.rulesVersion, acceptedRulesHash: contest.rulesHash,
      displayNameSnapshot: displayName, displayNameConsentedAt: at,
    } }).catch(async (error) => {
      if (error?.code !== "P2002") throw error;
      lostCreateRace = true;
      const raced = await db.giveawayEntrant.findFirst({ where: { contestId: contest.id, OR: [{ userId: user.id }, { entrantIdentityHash: { in: identities.all.map((candidate) => candidate.hash) } }] } });
      const racedExact = raced && raced.status === "ELIGIBLE" && raced.acceptedRulesVersion === contest.rulesVersion && raced.acceptedRulesHash === contest.rulesHash && raced.displayNameSnapshot === displayName && (global
        ? raced.country === null && raced.region === null && raced.ageConfirmedAt === null && raced.residencyConfirmedAt === null
        : raced.country === "US" && raced.region === body.region && raced.ageConfirmedAt && raced.residencyConfirmedAt);
      if (racedExact) return raced;
      throw new ConflictError("Contest entry is immutable", "ENTRY_IMMUTABLE");
    });
    return { created: !lostCreateRace, entry: serializeEntry(entry, global) };
  }

  function serializeEntry(entry, global = false) {
    return {
      status: entry.status,
      acceptedAt: iso(entry.rulesAcceptedAt),
      ...(!global ? { country: entry.country, region: entry.region } : {}),
      displayName: entry.displayNameSnapshot,
      rulesVersion: entry.acceptedRulesVersion,
    };
  }
  async function audit({ tx = db, contestId, actorId, method, action, key = null, requestHash = null, body = null, response, oldState, newState, reason = null }) {
    await tx.giveawayAuditEvent.create({ data: { contestId, actorId, method, action, idempotencyKey: key, requestHash, requestBody: normalizedAuditBody(action, body), responseBody: response, oldState, newState, reason } });
  }
  function assertRevision(contest, revision) {
    if (!Number.isInteger(revision) || revision !== contest.revision) throw new ConflictError("Contest revision changed", "REVISION_CONFLICT", { currentRevision: contest.revision });
  }

  async function createDraft(actor, key, body, clientFeatures = null) {
    if (body?.eligibilityMode === GLOBAL_ELIGIBILITY_MODE && !supportsGlobalContest(clientFeatures)) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
    const data = normalizeContestInput(body);
    if (supportsGlobalContest(clientFeatures) && data.cashMinor > 0) {
      throw new ValidationError("New contests must be coin-only", "INVALID_PRIZE");
    }
    try {
      return await withIdempotency({ actorId: actor.id, method: "POST:create", key, body }, async (tx, createHash) => {
        const contest = await tx.giveawayContest.create({ data });
        const response = { contest: await fullAdminContest(tx, contest, nowFn()) };
        await audit({ tx, contestId: contest.id, actorId: actor.id, method: "POST:create", action: "CREATE", key, requestHash: createHash, body, response, oldState: null, newState: "DRAFT" });
        return response;
      });
    } catch (error) {
      if (error?.code === "P2002") throw new ConflictError("Contest slug already exists", "CONTEST_SLUG_CONFLICT");
      throw error;
    }
  }

  async function patchDraft(actor, id, body, clientFeatures = null) {
    exactBody(body, ["revision", "patch"]);
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM giveaway_contests WHERE id = ${id} FOR UPDATE`;
      const contest = await tx.giveawayContest.findUnique({ where: { id } });
      if (!contest || (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE && !supportsGlobalContest(clientFeatures))) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
      const patch = normalizeContestInput(body?.patch, { partial: true, eligibilityMode: contest.eligibilityMode });
      assertRevision(contest, body?.revision);
      if (contest.lifecycleStatus !== "DRAFT") throw new ConflictError("Published contests are immutable", "CONTEST_IMMUTABLE");
      const merged = { ...contest, ...patch };
      if (new Date(merged.startsAt) >= new Date(merged.endsAt)) throw new ValidationError("Contest start must precede end", "INVALID_DATE_RANGE");
      if (!hasEnabledPrize(merged)) throw new ValidationError("At least one prize must be enabled", "INVALID_PRIZE");
      const refreshedLegacyCashChange = supportsGlobalContest(clientFeatures) &&
        contest.eligibilityMode !== GLOBAL_ELIGIBILITY_MODE && (
          (Object.hasOwn(patch, "cashMinor") && patch.cashMinor !== contest.cashMinor) ||
          (Object.hasOwn(patch, "cashCurrency") && patch.cashCurrency !== contest.cashCurrency)
        );
      if (refreshedLegacyCashChange) {
        throw new ValidationError("New contests must be coin-only", "INVALID_PRIZE");
      }
      if (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE) {
        const rules = generateStandardRules(merged);
        Object.assign(patch, { rulesVersion: rules.version, rulesSections: rules.sections, rulesHash: rules.hash });
      }
      const changed = await tx.giveawayContest.updateMany({
        where: { id, revision: body.revision, lifecycleStatus: "DRAFT" },
        data: { ...patch, revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ConflictError("Contest revision changed", "REVISION_CONFLICT");
      const updated = await tx.giveawayContest.findUnique({ where: { id } });
      const response = { contest: await fullAdminContest(tx, updated, nowFn()) };
      await audit({ tx, contestId: id, actorId: actor.id, method: "PATCH", action: "EDIT", body, response, oldState: "DRAFT", newState: "DRAFT" });
      return response;
    });
  }

  async function mutation(actor, id, action, key, body, work) {
    const method = `POST:${action.toLowerCase()}`;
    return withIdempotency({ actorId: actor.id, method, contestId: id, key, body }, async (tx, requestHash) => {
      await tx.$queryRaw`SELECT id FROM giveaway_contests WHERE id = ${id} FOR UPDATE`;
      const contest = await tx.giveawayContest.findUnique({ where: { id } });
      if (!contest) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
      assertRevision(contest, body?.revision);
      const result = await work(tx, contest);
      const fresh = result.contest || await tx.giveawayContest.findUnique({ where: { id } });
      const response = {
        contest: await fullAdminContest(tx, fresh, nowFn()),
        ...(result.result !== undefined ? { result: result.result } : {}),
        ...(result.review !== undefined ? { review: result.review } : {}),
        ...(result.fulfillment !== undefined ? { fulfillment: result.fulfillment } : {}),
      };
      await audit({ tx, contestId: id, actorId: actor.id, method, action, key, requestHash, body, response, oldState: contest.lifecycleStatus, newState: fresh.lifecycleStatus, reason: result.reason || null });
      return response;
    });
  }

  async function publish(actor, id, key, body, clientFeatures = null) {
    exactBody(body, ["revision"]);
    try {
      const response = await mutation(actor, id, "PUBLISH", key, body, async (tx, contest) => {
        if (contest.lifecycleStatus !== "DRAFT") throw new ConflictError("Contest is immutable", "CONTEST_IMMUTABLE");
        const fields = publishValidationFields(contest, nowFn());
        if (supportsGlobalContest(clientFeatures) && contest.cashMinor > 0 && !fields.includes("prize")) fields.push("prize");
        if (fields.length) throw new ValidationError("Contest is not ready to publish", "PUBLISH_VALIDATION_FAILED", { fields });
        const conflict = await tx.giveawayContest.findFirst({
          where: { id: { not: id }, lifecycleStatus: "PUBLISHED" },
        });
        if (conflict) throw new ConflictError("Contest window conflicts with another published contest", "CONTEST_WINDOW_CONFLICT");
        const archiveable = await tx.giveawayContest.findMany({ where: { id: { not: id }, lifecycleStatus: { in: ["FINAL", "CANCELLED"] } } });
        for (const old of archiveable) {
          const archived = await tx.giveawayContest.update({ where: { id: old.id }, data: { lifecycleStatus: "ARCHIVED", archivedAt: nowFn(), revision: { increment: 1 } } });
          await audit({ tx, contestId: old.id, actorId: actor.id, method: "POST:publish", action: "AUTO_ARCHIVE", body: { replacementContestId: id }, response: { contestId: old.id, lifecycleStatus: archived.lifecycleStatus }, oldState: old.lifecycleStatus, newState: "ARCHIVED" });
        }
        const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: "PUBLISHED", publishedAt: nowFn(), frozenAt: nowFn(), revision: { increment: 1 } } });
        return { contest: updated };
      });
      await invalidateActiveContestBannerCache();
      return response;
    } catch (error) {
      if (error?.code === "P2002") throw new ConflictError("Contest window conflicts with another published contest", "CONTEST_WINDOW_CONFLICT");
      throw error;
    }
  }

  async function cancel(actor, id, key, body) {
    exactBody(body, ["revision", "publicReason", "amendedRulesVersion"]);
    const response = await mutation(actor, id, "CANCEL", key, body, async (tx, contest) => {
      if (contest.lifecycleStatus !== "PUBLISHED" || contest.finalizedAt) throw new ConflictError("Contest cannot be cancelled", "INVALID_TRANSITION");
      if (typeof body.publicReason !== "string" || body.publicReason.trim().length < 10 || typeof body.amendedRulesVersion !== "string" || !body.amendedRulesVersion.trim()) throw new ValidationError("Cancellation reason and amended rules version are required", "INVALID_CANCEL");
      const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: "CANCELLED", publicReason: body.publicReason.trim().slice(0, 500), amendedRulesVersion: body.amendedRulesVersion.trim(), cancelledAt: nowFn(), revision: { increment: 1 } } });
      return { contest: updated, reason: body.publicReason };
    });
    await invalidateActiveContestBannerCache();
    return response;
  }

  async function review(actor, id, key, body) {
    exactBody(body, ["revision", "referralFactId", "decision", "reasonCode", "privateNote"]);
    return mutation(actor, id, "REVIEWS", key, body, async (tx, contest) => {
      const reasonCodes = { APPROVE: new Set(["LEGITIMATE"]), REJECT: new Set(["FRAUD", "INELIGIBLE", "DUPLICATE", "COORDINATED_RING"]) };
      if (!UUID_V4.test(String(body.referralFactId || "")) || !["APPROVE", "REJECT"].includes(body.decision) || !reasonCodes[body.decision]?.has(body.reasonCode)) throw new ValidationError("Invalid review decision", "INVALID_REVIEW");
      await tx.$queryRaw`SELECT id FROM referral_qualification_facts WHERE referral_fact_id = ${body.referralFactId} FOR UPDATE`;
      const durableFact = await tx.referralQualificationFact.findUnique({ where: { referralFactId: body.referralFactId } });
      if (!durableFact) await tx.$queryRaw`SELECT id FROM referrals WHERE id = ${body.referralFactId} FOR UPDATE`;
      const liveReferral = await tx.referral.findUnique({ where: { id: body.referralFactId } });
      const fact = durableFact ? {
        id: durableFact.referralFactId, referrerId: durableFact.referrerId,
        qualifiedAt: durableFact.qualifiedAt, qualifyingRaceId: durableFact.qualifyingRaceId,
        status: durableFact.status,
      } : liveReferral;
      if (!fact || !["FLAGGED", "QUALIFIED", "REWARDED"].includes(fact.status)) throw new ValidationError("Referral fact is not reviewable", "INVALID_REVIEW");
      const entrant = fact.referrerId ? await tx.giveawayEntrant.findFirst({ where: { contestId: id, userId: fact.referrerId, status: { in: ["ELIGIBLE", "UNDER_REVIEW"] } } }) : null;
      if (!entrant || !fact.qualifiedAt || new Date(fact.qualifiedAt) < new Date(contest.startsAt) || new Date(fact.qualifiedAt) < new Date(entrant.rulesAcceptedAt) || new Date(fact.qualifiedAt) >= new Date(contest.endsAt)) throw new ValidationError("Referral fact is outside this entrant's contest window", "INVALID_REVIEW");
      const existing = await tx.giveawayPointReview.findUnique({ where: { contestId_referralFactId: { contestId: id, referralFactId: fact.id } } });
      if (existing && existing.decision !== body.decision) throw new ConflictError("Referral review already has a different decision", "REVIEW_CONFLICT");
      if (body.privateNote !== undefined && (typeof body.privateNote !== "string" || body.privateNote.length > 1000)) throw new ValidationError("Invalid private note", "INVALID_REVIEW");
      const pointReview = existing || await tx.giveawayPointReview.create({ data: { contestId: id, referralFactId: fact.id, qualifiedAtSnapshot: fact.qualifiedAt, qualifyingRaceIdSnapshot: fact.qualifyingRaceId, referralStatusSnapshot: fact.status, decision: body.decision, reasonCode: body.reasonCode, privateNote: body.privateNote || null, actorId: actor.id, decidedAt: nowFn() } });
      if (!existing && body.decision === "APPROVE" && liveReferral?.status === "FLAGGED") {
        const grant = await approveFlaggedReferralReward({ referralId: fact.id, db: tx, now: nowFn });
        if (grant.status !== "REWARDED") throw new ConflictError("Referral is no longer reward eligible", "INVALID_TRANSITION");
      }
      const updated = await tx.giveawayContest.update({ where: { id }, data: { revision: { increment: 1 } } });
      return { contest: updated, review: { id: pointReview.id, referralFactId: pointReview.referralFactId, decision: pointReview.decision, reasonCode: pointReview.reasonCode, decidedAt: iso(pointReview.decidedAt) } };
    });
  }

  async function finalize(actor, id, key, body) {
    exactBody(body, ["revision"]);
    const response = await mutation(actor, id, "FINALIZE", key, body, async (tx, contest) => {
      if (contest.lifecycleStatus !== "PUBLISHED" || contest.finalizedAt || deriveContestStatus(contest, nowFn()) !== "VERIFYING") throw new ConflictError("Contest is not ready to finalize", "INVALID_TRANSITION");
      await acquireReferralQualificationFence(tx);
      const entrants = await tx.giveawayEntrant.findMany({
        where: { contestId: id, userId: { not: null } },
        select: { userId: true, rulesAcceptedAt: true },
      });
      // Conservatively fence every ended, unsettled real race. This avoids a
      // time-of-check gap where settlement has not yet stamped which entrant,
      // if any, its durable fact belongs to.
      const unsettled = await tx.race.findFirst({ where: {
        status: "ACTIVE", seedId: null, tournamentId: null,
        endsAt: { lte: nowFn(), lt: contest.endsAt },
        participants: { some: { status: "ACCEPTED", rawSteps: { gte: 2000 } } },
      }, select: { id: true } });
      if (unsettled) throw new ConflictError("Referral qualification processing is pending", "QUALIFICATION_PROCESSING_PENDING");
      if (await hasPendingReferralQualificationIntents({
        entrantWindows: entrants,
        startsAt: contest.startsAt,
        endsAt: contest.endsAt,
        db: tx,
      })) throw new ConflictError("Referral qualification processing is pending", "QUALIFICATION_PROCESSING_PENDING");
      const standings = await getContestStandings(contest, { db: tx });
      if (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE) {
        const unresolved = await unresolvedGlobalOutcomeFacts({ contest, standings, db: tx });
        if (unresolved.length) {
          throw new ConflictError("Outcome-changing referral review is required", "OUTCOME_REVIEW_REQUIRED", {
            referralFactIds: unresolved,
          });
        }
      }
      const leader = standings.find((row) => row.verifiedCount > 0) || null;
      const outcomeChanging = standings.some((row) => {
        if (!row.reviewableCount || row.entrantId === leader?.entrantId) return false;
        if (!leader) return true;
        const hypothetical = {
          ...row,
          verifiedCount: row.verifiedCount + row.reviewableCount,
          reachedCountAt: [...(row.reviewableFacts || []).map((fact) => fact.qualifiedAt), row.reachedCountAt]
            .filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).at(-1) || null,
        };
        return require("../queries/getContestStandings").compareRows(hypothetical, leader) < 0;
      });
      if (outcomeChanging) throw new ConflictError("Outcome-changing referral review is required", "OUTCOME_REVIEW_REQUIRED");
      const ranked = standings.filter((row) => row.verifiedCount > 0);
      for (let index = 0; index < ranked.length; index += 1) {
        await tx.giveawayResult.create({ data: { entrantId: ranked[index].entrantId, frozenCount: ranked[index].verifiedCount, reachedCountAt: ranked[index].reachedCountAt, finalRank: index + 1, status: index === 0 ? "POTENTIAL" : "RANKED", selectedAt: index === 0 ? nowFn() : null } });
      }
      const noWinner = ranked.length === 0;
      const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: noWinner ? "FINAL" : "PUBLISHED", finalizedAt: nowFn(), revision: { increment: 1 } } });
      return { contest: updated, result: { rankedCount: ranked.length, noWinner, potentialWinner: ranked[0] ? { entrantId: ranked[0].entrantId, displayName: ranked[0].displayName, originalRank: 1 } : null, verifiedWinner: null } };
    });
    await invalidateActiveContestBannerCache();
    return response;
  }

  async function winner(actor, id, key, body) {
    exactBody(body, ["revision", "entrantId", "decision", "reasonCode"]);
    return mutation(actor, id, "WINNER", key, body, async (tx, contest) => {
      if (contest.lifecycleStatus !== "PUBLISHED" || !contest.finalizedAt) throw new ConflictError("Contest has no frozen result", "INVALID_TRANSITION");
      const winnerReasons = { VERIFY: new Set(["ELIGIBILITY_VERIFIED"]), REJECT: new Set(["INELIGIBLE", "UNREACHABLE", "FRAUD", "DECLINED"]) };
      if (!["VERIFY", "REJECT"].includes(body.decision) || !winnerReasons[body.decision]?.has(body.reasonCode)) throw new ValidationError("Invalid winner decision", "INVALID_WINNER_DECISION");
      const result = await tx.giveawayResult.findUnique({ where: { entrantId: body.entrantId }, include: { entrant: true } });
      if (!result || result.entrant.contestId !== id || result.status !== "POTENTIAL") throw new ConflictError("Entrant is not the potential winner", "INVALID_TRANSITION");
      if (body.decision === "VERIFY") {
        if (result.entrant.status !== "ELIGIBLE" || !result.entrant.userId) throw new ConflictError("Potential winner is no longer eligible", "INVALID_TRANSITION");
        await tx.giveawayResult.update({ where: { id: result.id }, data: { status: "VERIFIED", verifiedAt: nowFn(), decisionReason: body.reasonCode } });
        await tx.giveawayFulfillment.upsert({ where: { entrantId: result.entrantId }, create: { entrantId: result.entrantId }, update: {} });
        const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: "FINAL", revision: { increment: 1 } } });
        return { contest: updated, result: await adminResult(tx, updated) };
      }
      await tx.giveawayResult.update({ where: { id: result.id }, data: { status: "REJECTED", rejectedAt: nowFn(), decisionReason: body.reasonCode } });
      await tx.giveawayEntrant.update({ where: { id: result.entrantId }, data: { status: "INELIGIBLE", disqualifiedReason: body.reasonCode } });
      const updated = await tx.giveawayContest.update({ where: { id }, data: { revision: { increment: 1 } } });
      return { contest: updated, result: await adminResult(tx, updated) };
    });
  }

  async function selectNext(actor, id, key, body) {
    exactBody(body, ["revision"]);
    return mutation(actor, id, "SELECT_NEXT", key, body, async (tx, contest) => {
      if (contest.lifecycleStatus !== "PUBLISHED" || !contest.finalizedAt) throw new ConflictError("Contest has no frozen result", "INVALID_TRANSITION");
      const verified = await tx.giveawayResult.findFirst({ where: { entrant: { contestId: id }, status: "VERIFIED" } });
      if (verified) throw new ConflictError("Winner is already verified", "INVALID_TRANSITION");
      const existingPotential = await tx.giveawayResult.findFirst({ where: { entrant: { contestId: id }, status: "POTENTIAL" } });
      if (existingPotential) throw new ConflictError("A potential winner is already selected", "INVALID_TRANSITION");
      const rejected = await tx.giveawayResult.findFirst({ where: { entrant: { contestId: id }, status: "REJECTED" } });
      if (!rejected) throw new ConflictError("No rejected potential winner", "INVALID_TRANSITION");
      const ranked = await tx.giveawayResult.findMany({ where: { entrant: { contestId: id }, status: "RANKED" }, orderBy: { finalRank: "asc" }, include: { entrant: true } });
      let next = null;
      for (const candidate of ranked) {
        if (candidate.entrant.status === "ELIGIBLE" && candidate.entrant.userId) {
          next = candidate;
          break;
        }
        await tx.giveawayResult.update({ where: { id: candidate.id }, data: {
          status: "REJECTED", rejectedAt: nowFn(), decisionReason: "NO_LONGER_ELIGIBLE",
        } });
      }
      if (!next) {
        const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: "FINAL", revision: { increment: 1 } } });
        return { contest: updated, result: await adminResult(tx, updated) };
      }
      await tx.giveawayResult.update({ where: { id: next.id }, data: { status: "POTENTIAL", selectedAt: nowFn() } });
      const updated = await tx.giveawayContest.update({ where: { id }, data: { revision: { increment: 1 } } });
      return { contest: updated, result: await adminResult(tx, updated) };
    });
  }

  async function fulfillment(actor, id, key, body) {
    exactBody(body, ["revision", "transition", "provider", "providerReference"]);
    return mutation(actor, id, "FULFILLMENT", key, body, async (tx, contest) => {
      if (contest.lifecycleStatus !== "FINAL") throw new ConflictError("Contest is not final", "INVALID_TRANSITION");
      if (contest.cashMinor === 0) throw new ConflictError("Contest has no cash prize", "INVALID_TRANSITION");
      const verified = await tx.giveawayResult.findFirst({ where: { entrant: { contestId: id }, status: "VERIFIED" } });
      if (!verified) throw new ConflictError("Winner is not verified", "INVALID_TRANSITION");
      const currentRow = await tx.giveawayFulfillment.findUnique({ where: { entrantId: verified.entrantId } });
      const expected = { UNCLAIMED: "CLAIMED", CLAIMED: "CASH_SENT", CASH_SENT: "CASH_DELIVERED" }[currentRow?.cashStatus];
      if (body.transition !== expected) throw new ConflictError("Invalid fulfillment transition", "INVALID_TRANSITION");
      const needsReference = ["CASH_SENT", "CASH_DELIVERED"].includes(body.transition);
      const providers = new Set(["ACH", "PAYPAL", "VENMO", "CHECK", "OTHER"]);
      if (needsReference && (!providers.has(body.provider) || typeof body.providerReference !== "string" || !body.providerReference.trim() || body.providerReference.length > 200)) throw new ValidationError("Provider and reference are required", "INVALID_FULFILLMENT");
      if (!needsReference && (body.provider !== undefined || body.providerReference !== undefined)) throw new ValidationError("Provider fields are not accepted for this transition", "INVALID_FULFILLMENT");
      const at = nowFn();
      const providerSecret = env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET;
      if (needsReference && !providerSecret) throw new AppError("Provider reference protection unavailable", "INTERNAL_ERROR", 500);
      const providerDigest = needsReference
        ? `hmac:${crypto.createHmac("sha256", providerSecret).update(body.providerReference.trim()).digest("hex")}`
        : null;
      const row = await tx.giveawayFulfillment.update({ where: { entrantId: verified.entrantId }, data: {
        cashStatus: body.transition,
        ...(body.transition === "CLAIMED" ? { claimedAt: at } : {}),
        ...(body.transition === "CASH_SENT" ? { cashProvider: body.provider, providerReference: providerDigest, cashSentMinor: contest.cashMinor, cashSentCurrency: contest.cashCurrency, cashSentAt: at } : {}),
        ...(body.transition === "CASH_DELIVERED" ? {
          cashProvider: body.provider, providerReference: providerDigest, cashDeliveredAt: at,
          ...(contest.coinPrize === 0 ? { fulfilledAt: at } : {}),
        } : {}),
      } });
      const updated = await tx.giveawayContest.update({ where: { id }, data: { revision: { increment: 1 } } });
      return { contest: updated, fulfillment: fulfillmentPayload(row) };
    });
  }

  async function awardWinnerCoins(actor, id, key, body) {
    exactBody(body, ["revision"]);
    return mutation(actor, id, "AWARD_COINS", key, body, async (tx, contest) => {
      await tx.$queryRaw`SELECT id FROM giveaway_contests WHERE id = ${id} FOR UPDATE`;
      if (contest.coinPrize === 0) throw new ConflictError("Contest has no coin prize", "INVALID_TRANSITION");
      const verified = await tx.giveawayResult.findFirst({ where: { entrant: { contestId: id }, status: "VERIFIED" }, include: { entrant: true } });
      if (!verified?.entrant.userId) throw new ConflictError("Verified winner account is unavailable", "INVALID_TRANSITION");
      let row = await tx.giveawayFulfillment.findUnique({ where: { entrantId: verified.entrantId } });
      const readyStatuses = contest.cashMinor === 0
        ? ["UNCLAIMED", "COINS_AWARDED"]
        : ["CASH_DELIVERED", "COINS_AWARDED"];
      if (!row || !readyStatuses.includes(row.cashStatus)) throw new ConflictError("Cash delivery must be confirmed first", "INVALID_TRANSITION");
      const refId = `giveaway:${id}:${verified.entrantId}`;
      const priorLedger = await tx.coinTransaction.findUnique({
        where: { userId_reason_refId: { userId: verified.entrant.userId, reason: "giveaway_winner", refId } },
      });
      if (!priorLedger) {
        const balances = await tx.$queryRaw`SELECT coins FROM users WHERE id = ${verified.entrant.userId} FOR UPDATE`;
        const currentCoins = Number(balances[0]?.coins);
        if (!Number.isSafeInteger(currentCoins) || currentCoins > 2147483647 - contest.coinPrize) {
          throw new ConflictError("Winner must reduce their coin balance before this prize can be awarded", "COIN_BALANCE_LIMIT", {
            maximumBalanceBeforeAward: 2147483647 - contest.coinPrize,
          });
        }
      }
      const credit = await award({ tx, userId: verified.entrant.userId, amount: contest.coinPrize, reason: "giveaway_winner", refId });
      const ledger = priorLedger || await tx.coinTransaction.findUnique({ where: { userId_reason_refId: { userId: verified.entrant.userId, reason: "giveaway_winner", refId } } });
      row = await tx.giveawayFulfillment.update({ where: { entrantId: verified.entrantId }, data: { cashStatus: "COINS_AWARDED", coinTransactionId: ledger.id, coinsAwardedAt: row.coinsAwardedAt || nowFn(), fulfilledAt: row.fulfilledAt || nowFn() } });
      const updated = credit.awarded === false && row.cashStatus === "COINS_AWARDED" ? contest : await tx.giveawayContest.update({ where: { id }, data: { revision: { increment: 1 } } });
      return { contest: updated, fulfillment: fulfillmentPayload(row) };
    });
  }

  async function archive(actor, id, key, body) {
    exactBody(body, ["revision"]);
    const response = await mutation(actor, id, "ARCHIVE", key, body, async (tx, contest) => {
      if (!["FINAL", "CANCELLED"].includes(contest.lifecycleStatus)) throw new ConflictError("Contest cannot be archived", "INVALID_TRANSITION");
      const updated = await tx.giveawayContest.update({ where: { id }, data: { lifecycleStatus: "ARCHIVED", archivedAt: nowFn(), revision: { increment: 1 } } });
      return { contest: updated };
    });
    await invalidateActiveContestBannerCache();
    return response;
  }

  async function bannerCorrection(actor, id, key, body) {
    exactBody(body, ["revision", "bannerMessage", "reason"]);
    const response = await mutation(actor, id, "BANNER_CORRECTION", key, body, async (tx, contest) => {
      const corrected = typeof body.bannerMessage === "string" ? body.bannerMessage.trim() : "";
      if (contest.lifecycleStatus !== "PUBLISHED" || !isAllowedBannerMessage(corrected, contest) || typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 500) {
        throw new ValidationError("Invalid banner correction", "INVALID_BANNER_CORRECTION");
      }
      const updated = await tx.giveawayContest.update({ where: { id }, data: {
        bannerMessage: corrected, revision: { increment: 1 },
      } });
      const linked = await tx.appSetting.findUnique({ where: { key: "homeServiceBannerContestSlug" } });
      const enabled = await tx.appSetting.findUnique({ where: { key: "homeServiceBannerEnabled" } });
      if (linked?.value === contest.slug && enabled?.value === true) {
        await tx.appSetting.upsert({ where: { key: "homeServiceBannerMessage" }, update: { value: corrected }, create: { key: "homeServiceBannerMessage", value: corrected } });
      }
      return { contest: updated, reason: body.reason.trim() };
    });
    appSettings.bustCache?.();
    await invalidateActiveContestBannerCache();
    return response;
  }

  async function listAdmin(cursorValue, limitValue, clientFeatures = null) {
    const limit = parseLimit(limitValue, { fallback: 25, max: 100 }); const cursor = decodeCursor(cursorValue);
    const pagination = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {};
    const where = supportsGlobalContest(clientFeatures) ? pagination : { AND: [pagination, { eligibilityMode: "US_18" }] };
    const records = await db.giveawayContest.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1 });
    const page = records.slice(0, limit);
    return { records: await Promise.all(page.map((contest) => fullAdminContest(db, contest, nowFn()))), nextCursor: records.length > limit ? encodeCursor({ createdAt: page[page.length - 1].createdAt.toISOString(), id: page[page.length - 1].id }) : null };
  }

  async function candidates(id, cursorValue, limitValue, clientFeatures = null) {
    const contest = await contestById(id, clientFeatures); const limit = parseLimit(limitValue, { fallback: 25, max: 100 }); const cursor = decodeCursor(cursorValue);
    const canonicalDate = (value, nullable = false) => {
      if (nullable && value === null) return null;
      if (typeof value !== "string") throw new ValidationError("Invalid cursor", "INVALID_CURSOR");
      const date = new Date(value);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new ValidationError("Invalid cursor", "INVALID_CURSOR");
      return date;
    };
    if (cursor && (!Number.isInteger(cursor.verifiedCount) || cursor.verifiedCount < 0 || !UUID_V4.test(String(cursor.entrantId || "")))) throw new ValidationError("Invalid cursor", "INVALID_CURSOR");
    // Pagination snapshot is about row insertion visibility, not contest time;
    // use wall-clock/database time even when lifecycle tests inject a clock.
    const asOf = cursor ? canonicalDate(cursor.asOf) : new Date();
    if (cursor) canonicalDate(cursor.reachedCountAt, true);
    let rows = await getContestStandings(contest, { db, asOf });
    if (cursor) {
      const cursorRow = { verifiedCount: cursor.verifiedCount, reachedCountAt: cursor.reachedCountAt, entrantId: cursor.entrantId };
      rows = rows.filter((row) => require("../queries/getContestStandings").compareRows(row, cursorRow) > 0);
    }
    const page = rows.slice(0, limit);
    const records = [];
    for (const row of page) {
      const facts = [...(row.auditFacts || [])].slice(0, 100);
      const raceIds = [...new Set(facts.map((fact) => fact.qualifyingRaceId).filter(Boolean))];
      const sharedRaceCount = raceIds.length ? await db.raceParticipant.count({ where: {
        raceId: { in: raceIds }, userId: row.userId, status: "ACCEPTED",
      } }) : 0;
      const raceFrequency = new Map();
      for (const fact of facts) raceFrequency.set(fact.qualifyingRaceId, (raceFrequency.get(fact.qualifyingRaceId) || 0) + 1);
      const orderedTimes = facts.map((fact) => new Date(fact.qualifiedAt).getTime()).sort((a, b) => a - b);
      const sourceCounts = new Map();
      const identityCounts = new Map();
      const allowedAttributionSources = new Set(["provision_body", "ip_fallback_exact", "ip_fallback_net", "redeem", "repair"]);
      for (const fact of facts) {
        const source = allowedAttributionSources.has(fact.attributionSource) ? fact.attributionSource : "unknown";
        sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
        identityCounts.set(fact.refereeIdentityHash, (identityCounts.get(fact.refereeIdentityHash) || 0) + 1);
      }
      const refereeIds = [...new Set(facts.map((fact) => fact.refereeId).filter(Boolean))];
      const referralCodes = [...new Set(facts.map((fact) => fact.referralCode).filter(Boolean))];
      const [samples, linkOpens] = await Promise.all([
        refereeIds.length ? db.stepSample.findMany({
          where: { userId: { in: refereeIds }, periodStart: { gte: contest.startsAt, lt: contest.endsAt } },
          select: { userId: true, periodStart: true, steps: true, sourceDeviceId: true },
          orderBy: [{ periodStart: "asc" }, { id: "asc" }], take: 500,
        }) : [],
        referralCodes.length ? db.linkOpen.findMany({
          where: { kind: "referral", code: { in: referralCodes }, createdAt: { gte: contest.startsAt, lt: contest.endsAt } },
          select: { ipHash: true, ipNetHash: true },
          orderBy: { createdAt: "asc" }, take: 500,
        }) : [],
      ]);
      const deviceUsers = new Map();
      const synchronizedUsers = new Map();
      for (const sample of samples) {
        if (sample.sourceDeviceId) {
          if (!deviceUsers.has(sample.sourceDeviceId)) deviceUsers.set(sample.sourceDeviceId, new Set());
          deviceUsers.get(sample.sourceDeviceId).add(sample.userId);
        }
        const signature = `${sample.periodStart.toISOString()}:${sample.steps}`;
        if (!synchronizedUsers.has(signature)) synchronizedUsers.set(signature, new Set());
        synchronizedUsers.get(signature).add(sample.userId);
      }
      const networkCounts = new Map();
      for (const open of linkOpens) {
        for (const hash of [open.ipHash, open.ipNetHash].filter(Boolean)) {
          networkCounts.set(hash, (networkCounts.get(hash) || 0) + 1);
        }
      }
      const maxWithin = (windowMs) => orderedTimes.reduce((maximum, start, index) => {
        let end = index;
        while (end < orderedTimes.length && orderedTimes[end] - start <= windowMs) end += 1;
        return Math.max(maximum, end - index);
      }, 0);
      const sharedDeviceCount = [...deviceUsers.values()].filter((users) => users.size > 1).length;
      const synchronizedStepWindowCount = [...synchronizedUsers.values()].filter((users) => users.size > 1).length;
      const sharedNetworkHashCount = [...networkCounts.values()].filter((count) => count > 1).length;
      const repeatedProviderIdentityCount = [...identityCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
      const deletedRefereeFactCount = facts.filter((fact) => !fact.refereeId).length;
      const flags = [];
      if (sharedRaceCount > 0) flags.push("REFERRER_IN_QUALIFYING_RACE");
      if ([...raceFrequency.values()].some((count) => count > 1)) flags.push("MULTIPLE_REFERRALS_SAME_RACE");
      if (orderedTimes.some((time, index) => index > 0 && time - orderedTimes[index - 1] <= 60 * 60 * 1000)) flags.push("RAPID_QUALIFICATIONS");
      if (repeatedProviderIdentityCount > 0) flags.push("PROVIDER_IDENTITY_REUSED");
      if (deletedRefereeFactCount > 0) flags.push("DELETE_REINSTALL_HISTORY");
      if (sharedDeviceCount > 0) flags.push("SHARED_DEVICE_SOURCE");
      if (sharedNetworkHashCount > 0) flags.push("SHARED_NETWORK_SOURCE");
      if (synchronizedStepWindowCount > 0) flags.push("SYNCHRONIZED_STEPS");
      let candidateReviewFactIds = row.reviewableFactIds;
      if (contest.eligibilityMode === GLOBAL_ELIGIBILITY_MODE) {
        const implicated = await implicatedFactsForEntrant({ contest, row, db });
        const decided = implicated.size ? await db.giveawayPointReview.findMany({
          where: { contestId: contest.id, referralFactId: { in: [...implicated] } },
          select: { referralFactId: true },
        }) : [];
        const decidedIds = new Set(decided.map((review) => review.referralFactId));
        candidateReviewFactIds = [...implicated].filter((id) => !decidedIds.has(id)).sort();
      }
      records.push({
        entrantId: row.entrantId, displayName: row.displayName, status: row.entryStatus,
        verifiedCount: row.verifiedCount, reviewableCount: row.reviewableCount,
        reachedCountAt: iso(row.reachedCountAt), provisionalRank: row.provisionalRank,
        auditSignals: {
          sharedRaceCount,
          correlationFlags: flags,
          attributionSources: [...sourceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, count]) => ({ source, count })),
          providerIdentity: { distinctCount: identityCounts.size, repeatedCount: repeatedProviderIdentityCount, deletedRefereeFactCount },
          network: { inspectedOpenCount: linkOpens.length, sharedHashCount: sharedNetworkHashCount, truncated: linkOpens.length === 500 },
          device: { inspectedSampleCount: samples.length, sharedSourceCount: sharedDeviceCount, truncated: samples.length === 500 },
          synchronizedSteps: { matchingWindowCount: synchronizedStepWindowCount },
          velocity: { maxInHour: maxWithin(60 * 60 * 1000), maxInDay: maxWithin(24 * 60 * 60 * 1000) },
        },
        reviewFacts: candidateReviewFactIds.slice(0, 100).map((referralFactId) => ({ referralFactId, status: "FLAGGED" })),
        auditFacts: facts.map((fact) => ({ referralFactId: fact.id, status: fact.status })),
      });
    }
    return { records, nextCursor: rows.length > limit ? encodeCursor({ asOf: asOf.toISOString(), verifiedCount: page[page.length - 1].verifiedCount, reachedCountAt: iso(page[page.length - 1].reachedCountAt), entrantId: page[page.length - 1].entrantId }) : null };
  }

  async function adminDetail(id, clientFeatures = null) {
    const contest = await contestById(id, clientFeatures);
    const fulfillment = await db.giveawayFulfillment.findFirst({
      where: { entrant: { contestId: id } },
      orderBy: { createdAt: "desc" },
    });
    return {
      contest: await fullAdminContest(db, contest, nowFn()),
      result: await adminResult(db, contest),
      fulfillment: fulfillmentPayload(fulfillment),
    };
  }

  return { adminDetail, archive, awardWinnerCoins, bannerCorrection, cancel, candidates, contestById, createDraft, current, deleteDraftContest, enter, fulfillment, listAdmin, memberCurrent, patchDraft, publicBySlug, publicData, publish, review, selectNext, finalize, winner };
}

module.exports = { buildGiveawayService, fulfillmentPayload, identityHash, identityHashes };
