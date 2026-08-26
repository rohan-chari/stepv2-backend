const crypto = require("node:crypto");
const {
  prisma: defaultPrisma,
  deferUntilAfterCommit,
} = require("../../../db");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
const { User } = require("../../users");
const { DeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_INTERVAL_FLOOR_MS = 15 * 60 * 1000;

function buildRaceResolutionDeliveryIntents(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const now = dependencies.now || (() => new Date());
  const compatibilityEvents = dependencies.eventBus || defaultEventBus;
  const logger = dependencies.logger || console;
  const secret = dependencies.secret || process.env.SESSION_TOKEN_SECRET;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  // The production Prisma proxy exposes the additive model. Legacy narrow
  // doubles retain their old serializable return shape for compatibility tests;
  // they never execute a provider call from this module.
  const centralized = Boolean(dependencies.appendDomainEvent || prisma.domainEventOutbox);

  function deliveryKeyHash(value) {
    if (typeof secret !== "string" || secret.length < 8) {
      throw new Error("SESSION_TOKEN_SECRET required for delivery intent hashing");
    }
    return crypto.createHmac("sha256", secret).update(value).digest("hex");
  }

  async function claimHighMultiplier(data, {
    sourceGeneration,
    client = null,
    participantClaim = null,
  } = {}) {
    const raceId = data?.raceId;
    const actorUserId = data?.actorUserId;
    const recipients = [...new Set(data?.recipientUserIds || [])]
      .filter((id) => id && id !== actorUserId);
    if (!raceId || !actorUserId || recipients.length === 0) return [];
    let actorName = data?.stealthed === true ? "???" : data?.actorName;
    if (!actorName) {
      try { actorName = (await userModel.findById(actorUserId))?.displayName; } catch {}
    }
    actorName ||= "Someone";
    const multiplier = Number.isFinite(Number(data?.multiplier)) ? Number(data.multiplier) : null;
    const currentTime = now();
    const candidates = recipients.map((userId, ordinal) => ({
      id: crypto.randomUUID(),
      userId,
      ordinal,
      deliveryKey: `race-resolution:${raceId}:${sourceGeneration}:${actorUserId}:${userId}`,
    }));
    const claimRows = async (transaction) => {
      if (participantClaim?.participantId) {
        const claimed = await transaction.raceParticipant.updateMany({
          where: { id: participantClaim.participantId, highMultiplierNotifiedAt: null },
          data: { highMultiplierNotifiedAt: participantClaim.claimedAt || currentTime },
        });
        if (claimed.count !== 1) return [];
      }
      if (!centralized) {
        // Compatibility-only path for old internal callers and narrow doubles.
        // Production appends a domain event below and performs this cooldown
        // claim in the projector, isolated from gameplay/race resolution.
        await transaction.$queryRawUnsafe(
          `SELECT input."userId", pg_advisory_xact_lock(
             hashtextextended('race-resolution-high-multiplier:' || input."userId", 0)
           )::text AS "lockResult"
             FROM jsonb_to_recordset($1::jsonb) AS input("userId" text)
            ORDER BY input."userId"`,
          JSON.stringify(candidates)
        );
        return transaction.$queryRawUnsafe(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
               id text, "userId" text, ordinal integer, "deliveryKey" text
             )
           )
           INSERT INTO notifications (id, user_id, type, title, body, race_id, delivery_key, created_at)
           SELECT input.id, input."userId", 'HIGH_MULTIPLIER_ALERT', $3, $4, $5,
                  input."deliveryKey", $6
             FROM input
            WHERE NOT EXISTS (
              SELECT 1 FROM notifications existing
               WHERE existing.user_id=input."userId"
                 AND existing.type='HIGH_MULTIPLIER_ALERT'
                 AND existing.created_at >= $2
            )
           ON CONFLICT (delivery_key) WHERE delivery_key IS NOT NULL DO NOTHING
           RETURNING user_id AS "userId"`,
          JSON.stringify(candidates),
          new Date(currentTime.getTime() - DAY_MS),
          "🔥 Someone's heating up",
          `${actorName}'s multiplier is stacked at ${multiplier != null ? `${multiplier}x` : "a high multiplier"}. Slow them down or catch up!`,
          raceId,
          currentTime,
        );
      }
      const sourceId = `race-resolution:${raceId}:${sourceGeneration}:${actorUserId}`;
      await appendDomainEvent(transaction, {
        eventKey: `HIGH_MULTIPLIER_ALERT_V1:${sourceId}`,
        eventType: "HIGH_MULTIPLIER_ALERT_V1", schemaVersion: 1,
        aggregateType: "RACE", aggregateId: raceId,
        occurredAt: currentTime,
        payload: {
          raceId, raceName: data?.raceName ?? null, sourceGeneration,
          actorUserId, actorName, multiplier, stealthed: data?.stealthed === true,
          endsAt: data?.endsAt ?? null,
        },
        audience: candidates.map((candidate) => ({ recipientId: candidate.userId, facts: {} })),
      });
      return candidates.map(({ userId }) => ({ userId }));
    };
    const rows = client ? await claimRows(client) : await prisma.$transaction(claimRows);
    const claimed = new Set(rows.map((row) => row.userId));
    if (centralized) {
      const recipientDeliverySourceIds = Object.fromEntries(
        candidates
          .filter((candidate) => claimed.has(candidate.userId))
          .map((candidate) => [candidate.userId, deliveryKeyHash(candidate.deliveryKey)]),
      );
      await deferUntilAfterCommit(async () => {
        try {
          await compatibilityEvents.emit("HIGH_MULTIPLIER_ALERT", {
            ...data,
            actorName,
            multiplier,
            recipientUserIds: [...claimed],
            recipientDeliverySourceIds,
          });
        } catch (error) {
          logger.warn?.("HIGH_MULTIPLIER_ALERT compatibility hint failed", {
            raceId,
            actorUserId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return [];
    }
    return candidates.filter((candidate) => claimed.has(candidate.userId)).map((candidate) => ({
      kind: "STATE_NOTIFICATION",
      recipientUserId: candidate.userId,
      payload: {
        type: "HIGH_MULTIPLIER_ALERT",
        title: "🔥 Someone's heating up",
        body: `${actorName}'s multiplier is stacked at ${multiplier != null ? `${multiplier}x` : "a high multiplier"}. Slow them down or catch up!`,
        pushPayload: { type: "HIGH_MULTIPLIER_ALERT", route: "race_detail", params: { raceId }, multiplier },
        collapseId: `himult_${String(raceId).slice(0, 8)}_${String(actorUserId).slice(0, 8)}`,
      },
      deliveryKeyHash: deliveryKeyHash(candidate.deliveryKey),
      cooldownClaimId: null,
    }));
  }

  // Silent/background step-sync remains in the race-resolution path by design;
  // it is not a visible notification intent.
  async function claimStepSync(userIds, {
    raceId,
    sourceGeneration,
    kind = "NUDGE",
    minIntervalMs = HOUR_MS,
    client = null,
  } = {}) {
    const recipients = [...new Set(userIds || [])].filter(Boolean);
    if (recipients.length === 0) return [];
    const currentTime = now();
    const cutoff = new Date(currentTime.getTime() - Math.max(MIN_INTERVAL_FLOOR_MS, Number(minIntervalMs) || HOUR_MS));
    const candidates = recipients.map((userId, ordinal) => ({
      userId,
      ordinal,
      cooldownClaimId: crypto.randomUUID(),
      deliveryKey: `race-resolution:${raceId}:${sourceGeneration}:${kind}:${ordinal}:${userId}`,
    }));
    const rows = await (client || prisma).$queryRawUnsafe(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
           "userId" text, ordinal integer, "cooldownClaimId" text, "deliveryKey" text
         )
       ), eligible AS (
         SELECT input."userId" FROM input JOIN users candidate ON candidate.id=input."userId"
          WHERE (candidate.last_step_sync_at IS NULL OR candidate.last_step_sync_at <= $2)
            AND (candidate.last_silent_push_sent_at IS NULL OR candidate.last_silent_push_sent_at <= $2)
            AND EXISTS (SELECT 1 FROM device_tokens token WHERE token.user_id=input."userId")
       )
       UPDATE users candidate SET last_silent_push_sent_at=$3 FROM eligible
        WHERE candidate.id=eligible."userId"
        RETURNING candidate.id AS "userId"`,
      JSON.stringify(candidates), cutoff, currentTime,
    );
    const claimed = new Set(rows.map((row) => row.userId));
    return candidates.filter((candidate) => claimed.has(candidate.userId)).map((candidate) => ({
      kind,
      recipientUserId: candidate.userId,
      payload: { type: "STEP_SYNC_REQUEST" },
      deliveryKeyHash: deliveryKeyHash(candidate.deliveryKey),
      cooldownClaimId: candidate.cooldownClaimId,
    }));
  }

  async function deliver(intent) {
    const recipientUserId = intent?.recipientUserId;
    if (!recipientUserId) return { accepted: false, disposition: "RECIPIENT_DELETED" };
    const tokens = await deviceTokenModel.findByUserId(recipientUserId);
    if (!tokens?.length) return { accepted: false, disposition: "NO_DEVICE_TOKEN" };
    if (!["NUDGE", "STEP_SYNC"].includes(intent.kind)) {
      return { accepted: false, disposition: "CENTRALIZED_REQUIRED" };
    }
    let accepted = false;
    let explicitFailures = 0;
    let ambiguousError = null;
    for (const tokenRecord of tokens) {
      const provider = tokenRecord.platform === "android" ? fcm : apns;
      try {
        const result = await provider.sendSilentNotification({
          deviceToken: tokenRecord.token,
          payload: { type: "STEP_SYNC_REQUEST" },
        });
        if (result?.success) accepted = true;
        else if (result?.unregistered) await deviceTokenModel.deleteToken({ userId: recipientUserId, token: tokenRecord.token });
        else explicitFailures += 1;
      } catch (error) {
        ambiguousError ||= error;
      }
    }
    if (accepted) return { accepted: true, disposition: "PROVIDER_ACCEPTED" };
    if (ambiguousError) throw ambiguousError;
    return { accepted: false, disposition: explicitFailures > 0 ? "PROVIDER_REJECTED" : "UNREGISTERED" };
  }

  return { claimHighMultiplier, claimStepSync, deliver, deliveryKeyHash };
}

const raceResolutionDeliveryIntents = buildRaceResolutionDeliveryIntents();

module.exports = { buildRaceResolutionDeliveryIntents, raceResolutionDeliveryIntents };
