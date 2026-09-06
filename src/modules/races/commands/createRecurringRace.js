const crypto = require("node:crypto");
const { prisma, runInPrismaTransaction, deferUntilAfterCommit } = require("../../../db");
const { createRace: defaultCreateRace } = require("./createRace");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { invalidateUser: defaultInvalidateRaceListUser } = require("../services/raceListCache");
const authMeCache = require("../../users/services/authMeCache");
const {
  AppError,
  ConflictError,
  ValidationError,
} = require("../../../shared/errors/AppError");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECURRING_PAYOUT_MIN_RAW_STEPS = 2000;
const RECURRING_PAYOUT_POLICY_VERSION = 1;

function canonicalInput(input) {
  const keys = Object.keys(input || {})
    .filter((key) => key !== "idempotencyKey")
    .sort();
  return Object.fromEntries(keys.map((key) => [key, input[key] ?? null]));
}

function digestInput(input) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalInput(input)))
    .digest("hex");
}

function validateKey(value) {
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new ValidationError(
      "A valid Idempotency-Key is required.",
      "INVALID_REQUEST",
    );
  }
  return value.trim().toLowerCase();
}

function readReceipt(receipt, digest) {
  if (!receipt) return null;
  if (receipt.requestDigest !== digest) {
    throw new ConflictError(
      "That idempotency key was already used for another request.",
      "IDEMPOTENCY_KEY_REUSED",
    );
  }
  return receipt.response;
}

function assertEligible(input, clientFeatures) {
  const features = clientFeatures instanceof Set
    ? clientFeatures
    : new Set(clientFeatures || []);
  if (!features.has("recurring_races_v1")) {
    throw new ValidationError(
      "Update the app to create recurring races.",
      "UPDATE_REQUIRED",
    );
  }
  if (input?.scheduledStartAt != null || input?.scheduledEndAt != null) {
    throw new ValidationError(
      "Scheduled and custom-window races cannot recur.",
      "RECURRING_SCHEDULE_UNSUPPORTED",
    );
  }
  if (
    input?.isTeamRace === true ||
    input?.creationSource != null ||
    input?.startPolicy != null ||
    Number(input?.buyInAmount || 0) !== 0 ||
    !Number.isInteger(input?.maxParticipants) ||
    input.maxParticipants < 2 ||
    input.maxParticipants > 100
  ) {
    throw new ValidationError(
      "This race configuration cannot recur.",
      "INVALID_REQUEST",
    );
  }
}

function assertRecurringSeriesToggle(value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ValidationError("Invalid request.", "INVALID_REQUEST");
  }
}

function buildCreateRecurringRace(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const createRace = dependencies.createRace || defaultCreateRace;
  const settings = dependencies.appSettings || defaultAppSettings;
  const invalidateRaceListUser =
    dependencies.invalidateRaceListUser || defaultInvalidateRaceListUser;
  const invalidateAuthUser =
    dependencies.invalidateAuthUser ||
    (Object.keys(dependencies).length > 0
      ? async () => null
      : authMeCache.invalidateSafe);

  return async function createRecurringRace({
    userId,
    idempotencyKey,
    input,
    timeZone,
    clientFeatures,
  }) {
    assertEligible(input, clientFeatures);
    const key = validateKey(idempotencyKey);
    const requestDigest = digestInput(input);
    const existing = await db.raceSeriesCreateReceipt.findUnique({
      where: { creatorId_idempotencyKey: { creatorId: userId, idempotencyKey: key } },
    });
    const replay = readReceipt(existing, requestDigest);
    if (replay) return { response: replay, replay: true };
    if ((await settings.getFlag("fundedPrizePoolsEnabled")) !== true) {
      throw new ValidationError(
        "Recurring races require app-funded free entry.",
        "INVALID_REQUEST",
      );
    }

    try {
      const response = await runInPrismaTransaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))::text AS locked`;
        const receipt = await tx.raceSeriesCreateReceipt.findUnique({
          where: { creatorId_idempotencyKey: { creatorId: userId, idempotencyKey: key } },
        });
        const stored = readReceipt(receipt, requestDigest);
        if (stored) return stored;

        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const active = await tx.raceSeriesSubscription.findFirst({
          where: { userId, active: true },
          select: { id: true },
        });
        if (active) {
          throw new ConflictError(
            "You already belong to an active recurring race series.",
            "RECURRING_SUBSCRIPTION_LIMIT",
          );
        }

        const race = await createRace({
          ...input,
          userId,
          recurringSeries: undefined,
          timeZone,
          clientFeatures,
        });
        const current = await tx.race.findUnique({ where: { id: race.id } });
        if (!current || current.fundedPrize !== true || current.buyInAmount !== 0) {
          throw new ValidationError(
            "Recurring races require app-funded free entry.",
            "INVALID_REQUEST",
          );
        }
        const settingsSnapshot = {
          name: current.name,
          targetSteps: current.targetSteps,
          maxDurationDays: current.maxDurationDays,
          powerupsEnabled: current.powerupsEnabled,
          powerupStepInterval: current.powerupStepInterval,
          payoutPreset: current.payoutPreset,
          isPublic: current.isPublic,
          maxParticipants: current.maxParticipants,
          timezone: current.timezone,
        };
        const series = await tx.raceSeries.create({
          data: {
            creatorId: userId,
            currentRaceId: current.id,
            generation: 0,
            settings: settingsSnapshot,
          },
        });
        await tx.race.update({
          where: { id: current.id },
          data: {
            seriesId: series.id,
            seriesGeneration: 0,
            recurringPayoutMinRawSteps: RECURRING_PAYOUT_MIN_RAW_STEPS,
            recurringPayoutPolicyVersion: RECURRING_PAYOUT_POLICY_VERSION,
          },
        });
        await tx.raceSeriesSubscription.create({
          data: { seriesId: series.id, userId, active: true },
        });
        const canonical = {
          race: { ...race, seriesId: series.id, seriesGeneration: 0 },
          series: {
            id: series.id,
            enabled: true,
            subscribed: true,
            canManage: true,
          },
        };
        await tx.raceSeriesCreateReceipt.create({
          data: {
            creatorId: userId,
            seriesId: series.id,
            idempotencyKey: key,
            requestDigest,
            response: canonical,
          },
        });
        await deferUntilAfterCommit(async () => {
          await Promise.allSettled([
            invalidateRaceListUser(userId),
            invalidateAuthUser(userId),
          ]);
        });
        return canonical;
      }, { maxWait: 10_000, timeout: 30_000 });
      return { response, replay: false };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code === "P2002" || error?.code === "23505") {
        const receipt = await db.raceSeriesCreateReceipt.findUnique({
          where: { creatorId_idempotencyKey: { creatorId: userId, idempotencyKey: key } },
        });
        const response = readReceipt(receipt, requestDigest);
        if (response) return { response, replay: true };
        throw new ConflictError(
          "You already belong to an active recurring race series.",
          "RECURRING_SUBSCRIPTION_LIMIT",
        );
      }
      throw error;
    }
  };
}

const createRecurringRace = buildCreateRecurringRace();

module.exports = {
  RECURRING_PAYOUT_MIN_RAW_STEPS,
  RECURRING_PAYOUT_POLICY_VERSION,
  assertRecurringSeriesToggle,
  buildCreateRecurringRace,
  createRecurringRace,
};
