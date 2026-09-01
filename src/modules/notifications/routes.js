const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { activeAdminMetricsEpochCache } = require("../analytics/services/activeAdminMetricsEpochCache");
const {
  DeviceToken: DefaultDeviceToken,
} = require("../../shared/push/deviceToken");
const { User: DefaultUser } = require("../users");
const { prisma: defaultPrisma } = require("../../db");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const { buildRegisterDeviceToken } = require("./commands/registerDeviceToken");
const { buildRemoveDeviceToken } = require("./commands/removeDeviceToken");

function createNotificationsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const DeviceToken = dependencies.DeviceToken || DefaultDeviceToken;
  const User = dependencies.User || DefaultUser;
  const prisma = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || defaultAppSettings;
  // Preserve the long-standing DeviceToken injection seam used by narrow
  // router callers while production uses the installation-aware model.
  const legacyRegistrationAdapter = !dependencies.DeviceRegistration && dependencies.DeviceToken
    ? {
        async register({
          userId, token, platform, adminMetricsOpenCapable,
          adminMetricsOpenEpochId,
        }) {
          await dependencies.DeviceToken.saveToken({
            userId,
            token,
            platform,
            ...(adminMetricsOpenCapable
              ? { adminMetricsOpenCapable, adminMetricsOpenEpochId }
              : {}),
          });
        },
        async remove({ userId, token, installationId }) {
          if (!token || installationId) return { mismatch: false, removed: 0 };
          await dependencies.DeviceToken.deleteToken({ userId, token });
          return { mismatch: false, removed: 1 };
        },
      }
    : null;
  const commandDependencies = legacyRegistrationAdapter
    ? { ...dependencies, DeviceRegistration: legacyRegistrationAdapter }
    : dependencies;
  const registerDeviceToken = dependencies.registerDeviceToken ||
    buildRegisterDeviceToken(commandDependencies);
  const removeDeviceToken = dependencies.removeDeviceToken ||
    buildRemoveDeviceToken(commandDependencies);

  router.use(requireAuth);

  // GET /notifications/preferences (§9.1). Auth required. Absent/never-set
  // preference reads as true (the model defaults it). Old clients never call
  // this; device-token registration and all existing endpoints are untouched.
  // Serialize the preference payload. Both columns are NOT NULL with a true
  // default, so anything that isn't an explicit false reads as true. Batch
  // 2026-08-08 item 3 added stepMilestoneRemindersEnabled ADDITIVELY — frozen
  // clients simply ignore the extra key.
  function prefsPayload(prefs) {
    return {
      dailyRewardRemindersEnabled: prefs.dailyRewardRemindersEnabled !== false,
      stepMilestoneRemindersEnabled:
        prefs.stepMilestoneRemindersEnabled !== false,
    };
  }

  router.get("/preferences", async (req, res) => {
    try {
      const prefs = await User.getNotificationPreferences(req.user.id);
      res.json(prefsPayload(prefs));
    } catch (error) {
      console.error("Get notification preferences error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /notifications/preferences (§9.1 + batch 2026-08-08 item 3). Body:
  // { dailyRewardRemindersEnabled?: boolean, stepMilestoneRemindersEnabled?:
  // boolean }. Unknown fields are ignored; a present non-boolean field is a 400.
  //
  // FROZEN-CLIENT CONTRACT: each field is written only when it is PRESENT, via
  // its own setter. An old client's body (daily-reward only, or empty) can
  // therefore never disturb the step-milestone preference. Returns both values.
  router.patch("/preferences", async (req, res) => {
    try {
      const body = req.body || {};
      const dailyValue = body.dailyRewardRemindersEnabled;
      const milestoneValue = body.stepMilestoneRemindersEnabled;

      if (dailyValue !== undefined && typeof dailyValue !== "boolean") {
        return res
          .status(400)
          .json({ error: "dailyRewardRemindersEnabled must be a boolean" });
      }
      if (milestoneValue !== undefined && typeof milestoneValue !== "boolean") {
        return res
          .status(400)
          .json({ error: "stepMilestoneRemindersEnabled must be a boolean" });
      }

      if (dailyValue !== undefined) {
        await User.setDailyRewardRemindersEnabled(req.user.id, dailyValue);
      }
      if (milestoneValue !== undefined) {
        await User.setStepMilestoneRemindersEnabled(req.user.id, milestoneValue);
      }

      // Read back rather than echoing the request so the response always
      // reflects what is stored (including the field the client didn't send).
      const prefs = await User.getNotificationPreferences(req.user.id);
      res.json(prefsPayload(prefs));
    } catch (error) {
      console.error("Update notification preferences error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /notifications/device-token
  router.post("/device-token", asyncHandler(async (req, res) => {
      const { platform } = req.body || {};
      let metricsEpochId = null;
      if (
        platform === "ios" &&
        req.user.isReviewAccount !== true &&
        req.clientFeatures?.has("admin_metrics_v2") === true &&
        (await settings.getFlag("adminMetricsV2TelemetryEnabled")) === true
      ) {
        const epoch = await activeAdminMetricsEpochCache.get(prisma);
        metricsEpochId = epoch?.id || null;
      }
      const result = await registerDeviceToken({
        userId: req.user.id,
        body: req.body,
        metrics: metricsEpochId
          ? {
              adminMetricsOpenCapable: true,
              adminMetricsOpenEpochId: metricsEpochId,
            }
          : {},
      });
      res.json(result);
  }));

  // DELETE /notifications/device-token
  router.delete("/device-token", asyncHandler(async (req, res) => {
    res.json(await removeDeviceToken({ userId: req.user.id, body: req.body }));
  }));

  return router;
}

module.exports = { createNotificationsRouter };
