const { randomUUID } = require("node:crypto");
const { prisma: defaultPrisma } = require("../../db");
const { User: defaultUser } = require("../users");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const { activeAdminMetricsEpochCache } = require("../analytics/services/activeAdminMetricsEpochCache");

function canonicalPushDeliveryKey(notificationType, recipientUserId, intentId) {
  if (!notificationType || !recipientUserId || !intentId) return null;
  return `visible:${notificationType}:${recipientUserId}:${intentId}`;
}

function buildPushDeliveryAttribution(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const User = dependencies.User || defaultUser;
  const appSettings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());

  async function prepare({
    recipientUserId,
    notificationType,
    tokens,
    deliveryKey,
    payload,
  }) {
    try {
      if (!deliveryKey) return { delivery: null, payload, epochId: null };
      if ((await appSettings.getFlag("adminMetricsV2TelemetryEnabled")) !== true) {
        return { delivery: null, payload, epochId: null };
      }
      const [user, epoch] = await Promise.all([
        User.findById(recipientUserId),
        activeAdminMetricsEpochCache.get(prisma),
      ]);
      const capable =
        user && user.isReviewAccount !== true && epoch &&
        (tokens || []).some((token) =>
          token.platform === "ios" &&
          token.adminMetricsOpenCapable === true &&
          token.adminMetricsOpenEpochId === epoch.id
        );
      if (!capable) return { delivery: null, payload, epochId: epoch?.id || null };
      const delivery = await prisma.pushDelivery.upsert({
        where: { deliveryKey },
        update: {},
        create: {
          publicId: randomUUID(),
          deliveryKey,
          userId: recipientUserId,
          notificationType: String(notificationType),
          openCapable: false,
        },
      });
      return {
        delivery,
        payload: { ...(payload || {}), notificationId: delivery.publicId },
        epochId: epoch.id,
      };
    } catch (error) {
      logger.error("push delivery attribution preparation failed", {
        notificationType,
        userId: recipientUserId,
        error: error?.message || String(error),
      });
      return { delivery: null, payload, epochId: null };
    }
  }

  async function markAccepted(attribution, tokenRecord, result) {
    if (!attribution?.delivery || !result?.success) return;
    if (
      tokenRecord.platform !== "ios" ||
      tokenRecord.adminMetricsOpenCapable !== true ||
      tokenRecord.adminMetricsOpenEpochId !== attribution.epochId
    ) return;
    await prisma.pushDelivery.updateMany({
      where: { id: attribution.delivery.id, providerAcceptedAt: null },
      data: { openCapable: true, providerAcceptedAt: now() },
    });
  }

  return { prepare, markAccepted };
}

module.exports = { buildPushDeliveryAttribution, canonicalPushDeliveryKey };
