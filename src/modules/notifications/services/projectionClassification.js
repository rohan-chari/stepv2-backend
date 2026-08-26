const CHAT_COOLDOWN_MS = 60_000;
const PLACEMENT_COOLDOWN_MS = 10 * 60_000;
const TEAM_LEAD_COOLDOWN_MS = 10 * 60_000;
const TEAM_FINAL_STRETCH_COOLDOWN_MS = 30 * 60_000;
const DEFAULT_PAYOUT_DROP_WINDOW_HOURS = 3;
const {
  canonicalPushDeliveryKey,
} = require("../pushDeliveryAttribution");

function payoutDropWindowMs(env) {
  const hours = Number(env.PAYOUT_DROP_WINDOW_HOURS);
  return (Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_PAYOUT_DROP_WINDOW_HOURS) * 60 * 60_000;
}

async function claimCooldown(tx, {
  lockKey,
  userId,
  raceId,
  type,
  deliveryKey,
  since,
  scopeByUser = true,
}) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return true;
  const recent = await tx.notification.findFirst({
    where: {
      ...(scopeByUser ? { userId } : {}),
      type,
      raceId,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { deliveryKey: true },
  });
  if (recent) return recent.deliveryKey === deliveryKey;
  await tx.notification.create({
    data: { userId, type, raceId, deliveryKey },
  });
  return true;
}

function buildProjectionClassifier({ env = process.env } = {}) {
  return async function classifyProjection(tx, { event, audience }) {
    const p = event.payload || {};
    const recipientUserId = audience.recipientId;
    const occurredAt = new Date(event.occurredAt);

    if (event.eventType === "RACE_MESSAGE_SENT_V1") {
      const deliveryKey = `cooldown:race-message:${p.messageId}:${recipientUserId}`;
      const visible = await claimCooldown(tx, {
        lockKey: `race-message-cooldown:${p.raceId}:${recipientUserId}`,
        userId: recipientUserId,
        raceId: p.raceId,
        type: "RACE_MESSAGE_COOLDOWN",
        deliveryKey,
        since: new Date(occurredAt.getTime() - CHAT_COOLDOWN_MS),
      });
      return { projectionKind: visible ? "VISIBLE" : "SILENT_REFRESH" };
    }

    if (event.eventType === "PLACEMENT_CHANGED_V1") {
      const tookFirst = p.placement === 1 && p.previousPlacement !== 1;
      const lostFirst = p.previousPlacement === 1 && p.placement > 1;
      const droppedOutOfPaid = Number.isFinite(p.previousPlacement) &&
        Number.isFinite(p.paidPlaces) && p.paidPlaces > 0 &&
        p.previousPlacement <= p.paidPlaces && p.placement > p.paidPlaces;
      const endsAtMs = p.endsAt == null ? NaN : new Date(p.endsAt).getTime();
      const payoutDrop = droppedOutOfPaid && !tookFirst &&
        (!Number.isFinite(endsAtMs) || endsAtMs - occurredAt.getTime() <= payoutDropWindowMs(env));
      if (!tookFirst && !lostFirst && !payoutDrop) {
        return { projectionKind: "SILENT_REFRESH" };
      }
      let payoutDelivery = false;
      if (payoutDrop) {
        const payoutClaimKey = `payout-drop:${p.raceId}:${recipientUserId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`placement-payout:${p.raceId}:${recipientUserId}`}))`;
        const existingPayout = await tx.notification.findUnique({
          where: { deliveryKey: payoutClaimKey },
          select: { id: true },
        });
        if (existingPayout && !lostFirst) return { projectionKind: "SILENT_REFRESH" };
        if (!existingPayout) {
          const user = await tx.user.findUnique({
            where: { id: recipientUserId },
            select: { id: true },
          });
          if (user) {
            await tx.notification.create({
              data: {
                userId: recipientUserId,
                type: "PLACEMENT_PAYOUT_CLAIM",
                raceId: p.raceId,
                deliveryKey: payoutClaimKey,
              },
            });
            payoutDelivery = true;
          }
        }
      }
      const deliveryKey = `cooldown:placement:${p.transitionId}:${recipientUserId}`;
      const visible = await claimCooldown(tx, {
        lockKey: `placement-cooldown:${p.raceId}:${recipientUserId}`,
        userId: recipientUserId,
        raceId: p.raceId,
        type: "PLACEMENT_COOLDOWN",
        deliveryKey,
        since: new Date(occurredAt.getTime() - PLACEMENT_COOLDOWN_MS),
      });
      return {
        projectionKind: visible ? "VISIBLE" : "SILENT_REFRESH",
        ...(visible && payoutDelivery ? {
          deliveryKey: canonicalPushDeliveryKey(
            "PLACEMENT_CHANGED",
            recipientUserId,
            `payout-drop:${p.raceId}:${recipientUserId}`,
          ),
        } : {}),
      };
    }

    if (event.eventType === "TEAM_LEAD_CHANGED_V1") {
      const deliveryKey = `cooldown:team-lead:${p.transitionId}`;
      const visible = await claimCooldown(tx, {
        lockKey: `team-lead-cooldown:${p.raceId}`,
        userId: recipientUserId,
        raceId: p.raceId,
        type: "TEAM_LEAD_COOLDOWN",
        deliveryKey,
        since: new Date(occurredAt.getTime() - TEAM_LEAD_COOLDOWN_MS),
        scopeByUser: false,
      });
      return visible
        ? { projectionKind: "VISIBLE" }
        : { projectionKind: "VISIBLE", status: "SUPPRESSED", reason: "TEAM_LEAD_COOLDOWN" };
    }

    if (event.eventType === "TEAM_FINAL_STRETCH_V1") {
      const deliveryKey = `cooldown:team-final-stretch:${p.transitionId}:${recipientUserId}`;
      const visible = await claimCooldown(tx, {
        lockKey: `team-final-stretch-cooldown:${p.raceId}:${recipientUserId}`,
        userId: recipientUserId,
        raceId: p.raceId,
        type: "TEAM_FINAL_STRETCH_COOLDOWN",
        deliveryKey,
        since: new Date(occurredAt.getTime() - TEAM_FINAL_STRETCH_COOLDOWN_MS),
      });
      return visible
        ? { projectionKind: "VISIBLE" }
        : {
            projectionKind: "VISIBLE",
            status: "SUPPRESSED",
            reason: "TEAM_FINAL_STRETCH_COOLDOWN",
          };
    }

    return { projectionKind: "VISIBLE" };
  };
}

module.exports = {
  CHAT_COOLDOWN_MS,
  PLACEMENT_COOLDOWN_MS,
  TEAM_LEAD_COOLDOWN_MS,
  TEAM_FINAL_STRETCH_COOLDOWN_MS,
  buildProjectionClassifier,
};
