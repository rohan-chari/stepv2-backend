const crypto = require("node:crypto");
const { prisma, runInPrismaTransaction, deferUntilAfterCommit } = require("../../../db");
const { createRace: defaultCreateRace } = require("./createRace");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const { invalidateUser: defaultInvalidateRaceListUser } = require("../services/raceListCache");
const {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../../../shared/errors/AppError");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_REMATCH_COHORT = 100;

class RaceRematchError extends AppError {}

function digestRequest(sourceRaceId) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ sourceRaceId, version: 1 }))
    .digest("hex");
}

function normalizeKey(value) {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new ValidationError(
      "A valid Idempotency-Key is required.",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  return value.trim().toLowerCase();
}

function storedResponse(receipt, sourceRaceId, requestDigest) {
  if (!receipt) return null;
  if (
    receipt.sourceRaceId !== sourceRaceId ||
    receipt.requestDigest !== requestDigest
  ) {
    throw new ConflictError(
      "That idempotency key was already used for another request.",
      "IDEMPOTENCY_KEY_REUSED",
    );
  }
  return receipt.response;
}

function buildCreateRaceRematch(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const createRace = dependencies.createRace || defaultCreateRace;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  const invalidateRaceListUser =
    dependencies.invalidateRaceListUser || defaultInvalidateRaceListUser;
  const now = dependencies.now || (() => new Date());

  return async function createRaceRematch({
    requesterId,
    sourceRaceId,
    idempotencyKey,
    timeZone = null,
    clientFeatures = null,
  }) {
    const key = normalizeKey(idempotencyKey);
    const requestDigest = digestRequest(sourceRaceId);
    const firstReceipt = await db.raceRematchReceipt.findUnique({
      where: {
        requesterId_idempotencyKey: { requesterId, idempotencyKey: key },
      },
    });
    const replay = storedResponse(firstReceipt, sourceRaceId, requestDigest);
    if (replay) return { response: replay, replay: true };

    // The receipt has a required source FK, so establish the public 404 before
    // entering the reservation transaction. All mutable eligibility is still
    // re-read under the lineage locks below.
    const sourceExists = await db.race.findUnique({
      where: { id: sourceRaceId },
      select: { id: true },
    });
    if (!sourceExists) {
      throw new NotFoundError("The source race was not found.", "SOURCE_NOT_FOUND");
    }

    try {
      const response = await runInPrismaTransaction(async (tx) => {
        // Insert-first reservation: a concurrent duplicate waits on this
        // unique key and, if it loses, recovers the committed response outside
        // the aborted transaction. No incomplete row can commit because this
        // transaction also owns the race, invites, events and final response.
        const receipt = await tx.raceRematchReceipt.create({
          data: {
            requesterId,
            sourceRaceId,
            idempotencyKey: key,
            requestDigest,
          },
        });

        const source = await tx.race.findUnique({
          where: { id: sourceRaceId },
          include: {
            participants: {
              where: { status: "ACCEPTED" },
              orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
              take: MAX_REMATCH_COHORT + 1,
              select: { userId: true, team: true },
            },
            series: { select: { enabled: true } },
            seriesSuccessor: { select: { id: true } },
            rematchDescendants: {
              where: { status: "COMPLETED" },
              take: 1,
              select: { id: true },
            },
          },
        });
        if (!source) {
          throw new NotFoundError("The source race was not found.", "SOURCE_NOT_FOUND");
        }
        const requester = source.participants.find((row) => row.userId === requesterId);
        if (!requester) {
          throw new ForbiddenError(
            "Only a former participant can rematch this race.",
            "NOT_PARTICIPANT",
          );
        }
        if (source.status !== "COMPLETED") {
          throw new ConflictError(
            "This race has not completed.",
            "SOURCE_NOT_COMPLETED",
          );
        }
        if (
          source.seedId ||
          source.tournamentId ||
          source.creationSource != null ||
          source.startPolicy != null
        ) {
          throw new ConflictError(
            "This race cannot be rematched.",
            "SOURCE_NOT_REMATCHABLE",
          );
        }
        if (source.seriesId && (source.series?.enabled || source.seriesSuccessor)) {
          throw new ConflictError(
            "An enabled recurring race cannot be manually rematched.",
            "SOURCE_RECURRING",
          );
        }
        if (source.participants.length > MAX_REMATCH_COHORT) {
          throw new ConflictError(
            "This race has too many participants for a synchronous rematch.",
            "REMATCH_COHORT_TOO_LARGE",
          );
        }

        const rootRaceId = source.rematchRootRaceId || source.id;
        await tx.$queryRaw`SELECT id FROM races WHERE id = ${rootRaceId} FOR UPDATE`;
        const live = await tx.race.findFirst({
          where: {
            rematchRootRaceId: rootRaceId,
            status: { in: ["PENDING", "ACTIVE"] },
          },
          select: { id: true },
        });
        if (live) {
          throw new ConflictError(
            "A rematch in this race lineage is already live.",
            "REMATCH_ALREADY_LIVE",
          );
        }
        if (source.rematchDescendants.length > 0) {
          throw new ConflictError(
            "A newer completed race is the current rematch tip.",
            "SOURCE_NOT_REMATCHABLE",
          );
        }

        const userRows = await tx.user.findMany({
          where: { id: { in: source.participants.map((row) => row.userId) } },
          select: { id: true, clientFeatures: true },
        });
        const users = new Map(userRows.map((row) => [row.id, row]));
        const skipped = [];
        const inviteeIds = [];
        for (const former of source.participants) {
          if (former.userId === requesterId) continue;
          const account = users.get(former.userId);
          if (!account) {
            skipped.push({ userId: former.userId, reason: "ACCOUNT_UNAVAILABLE" });
          } else if (
            source.isTeamRace &&
            !(account.clientFeatures || []).includes("team_races")
          ) {
            skipped.push({
              userId: former.userId,
              reason: "CLIENT_UPDATE_REQUIRED",
            });
          } else {
            inviteeIds.push(former.userId);
          }
        }

        const created = await createRace({
          userId: requesterId,
          name: source.name,
          maxDurationDays: source.maxDurationDays || 7,
          powerupsEnabled: source.powerupsEnabled,
          powerupStepInterval: source.powerupStepInterval,
          buyInAmount: source.buyInAmount,
          payoutPreset: source.payoutPreset,
          isPublic: source.isPublic,
          maxParticipants: source.maxParticipants,
          targetSteps: source.targetSteps,
          timeZone,
          isTeamRace: source.isTeamRace,
          teamSize: source.teamSize,
          teamAName: source.teamAName,
          teamBName: source.teamBName,
          team: requester.team,
          clientFeatures,
        });
        await tx.race.update({
          where: { id: created.id },
          data: { rematchSourceRaceId: source.id, rematchRootRaceId: rootRaceId },
        });
        // createRace establishes this row before its creator membership. Keep
        // the generation-zero row inert and explicit for auditability.
        await acquireRaceWriteFence(tx, created.id);

        const expiresAt = new Date(now().getTime() + INVITE_TTL_MS);
        if (inviteeIds.length) {
          await tx.raceParticipant.createMany({
            data: inviteeIds.map((userId) => ({
              raceId: created.id,
              userId,
              status: "INVITED",
              inviteExpiresAt: expiresAt,
            })),
          });
        }
        const invites = inviteeIds.length
          ? await tx.raceParticipant.findMany({
              where: {
                raceId: created.id,
                userId: { in: inviteeIds },
                status: "INVITED",
              },
              select: { id: true, userId: true },
            })
          : [];
        for (const invite of invites) {
          let episode = await tx.raceRematchNotificationEpisode.findFirst({
            where: {
              recipientId: invite.userId,
              rootRaceId,
              closedAt: null,
            },
            orderBy: { generation: "desc" },
          });
          if (episode) {
            episode = await tx.raceRematchNotificationEpisode.update({
              where: { id: episode.id },
              data: {
                latestRaceId: created.id,
                revision: { increment: 1 },
              },
            });
          } else {
            const latest = await tx.raceRematchNotificationEpisode.findFirst({
              where: { recipientId: invite.userId, rootRaceId },
              orderBy: { generation: "desc" },
              select: { generation: true },
            });
            episode = await tx.raceRematchNotificationEpisode.create({
              data: {
                recipientId: invite.userId,
                rootRaceId,
                generation: (latest?.generation ?? -1) + 1,
                latestRaceId: created.id,
                revision: 1,
              },
            });
          }
          await appendDomainEvent(tx, {
            eventKey: `RACE_INVITE_SENT_V1:${invite.id}`,
            eventType: "RACE_INVITE_SENT_V1",
            schemaVersion: 1,
            aggregateType: "RACE",
            aggregateId: created.id,
            occurredAt: now(),
            payload: {
              raceId: created.id,
              raceName: source.name,
              creatorUserId: requesterId,
              inviteId: invite.id,
              rematchSourceRaceId: source.id,
              rematchRootRaceId: rootRaceId,
              rematchEpisodeId: episode.id,
              rematchEpisodeRevision: episode.revision,
            },
            audience: [{ recipientId: invite.userId, facts: {} }],
          });
        }

        const canonical = {
          race: { id: created.id, status: "PENDING" },
          sourceRaceId: source.id,
          invitedUserIds: inviteeIds,
          skipped,
        };
        await tx.raceRematchReceipt.update({
          where: { id: receipt.id },
          data: {
            newRaceId: created.id,
            response: canonical,
            completedAt: now(),
          },
        });
        await deferUntilAfterCommit(async () => {
          await Promise.allSettled(
            [requesterId, ...inviteeIds].map((userId) =>
              invalidateRaceListUser(userId),
            ),
          );
        });
        return canonical;
      }, { maxWait: 10_000, timeout: 30_000 });
      return { response, replay: false };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code === "P2002" || error?.code === "23505") {
        const receipt = await db.raceRematchReceipt.findUnique({
          where: {
            requesterId_idempotencyKey: { requesterId, idempotencyKey: key },
          },
        });
        const response = storedResponse(receipt, sourceRaceId, requestDigest);
        if (response) return { response, replay: true };
        throw new ConflictError(
          "A rematch in this race lineage is already live.",
          "REMATCH_ALREADY_LIVE",
        );
      }
      throw error;
    }
  };
}

const createRaceRematch = buildCreateRaceRematch();

module.exports = {
  MAX_REMATCH_COHORT,
  RaceRematchError,
  buildCreateRaceRematch,
  createRaceRematch,
};
