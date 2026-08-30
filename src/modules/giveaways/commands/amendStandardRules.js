const { prisma: defaultPrisma } = require("../../../db");
const {
  AppError,
  ConflictError,
  NotFoundError,
} = require("../../../shared/errors/AppError");
const { deriveContestStatus } = require("../models/contest");
const {
  buildStandardRulesAmendmentModel,
} = require("../models/standardRulesAmendment");
const { createGiveawayIdempotency } = require("../services/idempotency");
const {
  GLOBAL_ELIGIBILITY_MODE,
  LEGACY_STANDARD_TEMPLATE_VERSION,
  STANDARD_TEMPLATE_VERSION,
  canonicalJson,
  generateStandardRulesForVersion,
} = require("../services/standardRules");

const AMENDMENT_REASON =
  "Replace internal interval notation with equivalent plain language";

function invalidAmendment(message = "Rules amendment is not the approved clarification") {
  return new AppError(message, "INVALID_RULES_AMENDMENT", 422);
}

function exactAmendmentBody(body) {
  const keys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body).sort()
    : [];
  if (canonicalJson(keys) !== canonicalJson([
    "reason",
    "revision",
    "templateVersion",
  ])) {
    throw invalidAmendment("Invalid standard rules amendment body");
  }
  if (
    body.templateVersion !== STANDARD_TEMPLATE_VERSION ||
    body.reason !== AMENDMENT_REASON
  ) {
    throw invalidAmendment();
  }
}

function rulesSnapshot(rules) {
  return {
    version: rules.version,
    hash: rules.hash,
    sections: rules.sections,
  };
}

function storedRulesSnapshot(contest) {
  return {
    version: contest.rulesVersion,
    hash: contest.rulesHash,
    sections: contest.rulesSections,
  };
}

function snapshotsMatch(left, right) {
  return left.version === right.version &&
    left.hash === right.hash &&
    canonicalJson(left.sections) === canonicalJson(right.sections);
}

function buildAmendStandardRules(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const model = dependencies.standardRulesAmendmentModel ||
    buildStandardRulesAmendmentModel();
  const { withIdempotency } = dependencies.withIdempotency
    ? { withIdempotency: dependencies.withIdempotency }
    : createGiveawayIdempotency({ db, env: dependencies.env || process.env });

  return async function amendStandardRules({
    actorId,
    contestId,
    idempotencyKey,
    body,
  }) {
    exactAmendmentBody(body);
    return withIdempotency({
      actorId,
      method: "POST:amend-standard-rules",
      contestId,
      key: idempotencyKey,
      body,
    }, async (tx, requestHash) => {
      const contest = await model.lockContest(tx, contestId);
      if (!contest) {
        throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
      }
      if (!Number.isInteger(body.revision) || body.revision !== contest.revision) {
        throw new ConflictError(
          "Contest revision changed",
          "REVISION_CONFLICT",
          { currentRevision: contest.revision },
        );
      }
      const at = now();
      if (
        contest.eligibilityMode !== GLOBAL_ELIGIBILITY_MODE ||
        contest.lifecycleStatus !== "PUBLISHED" ||
        !["SCHEDULED", "ACTIVE"].includes(deriveContestStatus(contest, at))
      ) {
        throw new ConflictError(
          "Contest rules cannot be amended in this state",
          "INVALID_TRANSITION",
        );
      }

      const predecessor = rulesSnapshot(generateStandardRulesForVersion(
        contest,
        LEGACY_STANDARD_TEMPLATE_VERSION,
      ));
      const oldRules = storedRulesSnapshot(contest);
      if (!snapshotsMatch(oldRules, predecessor)) {
        throw invalidAmendment(
          "Stored rules are not the canonical v1 predecessor",
        );
      }
      const successor = rulesSnapshot(generateStandardRulesForVersion(
        contest,
        STANDARD_TEMPLATE_VERSION,
      ));
      const updated = await model.replaceRules(tx, {
        contestId,
        revision: body.revision,
        rulesVersion: successor.version,
        rulesHash: successor.hash,
        rulesSections: successor.sections,
      });
      if (!updated) {
        throw new ConflictError(
          "Contest revision changed",
          "REVISION_CONFLICT",
        );
      }
      const response = {
        contest: await model.fullAdminResponse(tx, updated, at),
      };
      const auditRules = { oldRules, newRules: successor };
      await model.createAudit(tx, {
        contestId,
        actorId,
        method: "POST:amend-standard-rules",
        action: "AMEND_STANDARD_RULES",
        idempotencyKey,
        requestHash,
        requestBody: { ...body, ...auditRules },
        responseBody: { ...response, reason: body.reason, ...auditRules },
        oldState: contest.lifecycleStatus,
        newState: updated.lifecycleStatus,
        reason: body.reason,
      });
      return response;
    });
  };
}

module.exports = {
  AMENDMENT_REASON,
  buildAmendStandardRules,
};
