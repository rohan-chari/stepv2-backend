const { ConflictError, NotFoundError, ValidationError } = require("../../../shared/errors/AppError");

function buildDeleteDraftContest({ db, withIdempotency }) {
  return async function deleteDraftContest({ actorId, contestId, idempotencyKey, body, supportsGlobal = false }) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "revision") || !Number.isInteger(body.revision)) {
      throw new ValidationError("Invalid request body", "INVALID_BODY");
    }
    return withIdempotency({
      actorId,
      method: "DELETE",
      contestId,
      key: idempotencyKey,
      body,
    }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM giveaway_contests WHERE id = ${contestId} FOR UPDATE`;
      const contest = await tx.giveawayContest.findUnique({ where: { id: contestId } });
      if (!contest || (contest.eligibilityMode === "BARA_ACCOUNT" && !supportsGlobal)) throw new NotFoundError("Contest not found", "CONTEST_NOT_FOUND");
      if (contest.revision !== body.revision) {
        throw new ConflictError("Contest revision changed", "REVISION_CONFLICT", { currentRevision: contest.revision });
      }
      if (contest.lifecycleStatus !== "DRAFT") {
        throw new ConflictError("Contest cannot be deleted", "CONTEST_DELETE_NOT_ALLOWED");
      }
      const [entrants, results, fulfillments, reviews] = await Promise.all([
        tx.giveawayEntrant.count({ where: { contestId } }),
        tx.giveawayResult.count({ where: { entrant: { contestId } } }),
        tx.giveawayFulfillment.count({ where: { entrant: { contestId } } }),
        tx.giveawayPointReview.count({ where: { contestId } }),
      ]);
      if (entrants || results || fulfillments || reviews) {
        throw new ConflictError("Contest cannot be deleted", "CONTEST_DELETE_NOT_ALLOWED");
      }
      const deleted = { id: contest.id, slug: contest.slug, lifecycleStatus: "DRAFT" };
      await tx.giveawayContest.delete({ where: { id: contest.id } });
      return { deleted };
    });
  };
}

module.exports = { buildDeleteDraftContest };
