const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const {
  DeviceToken: DefaultDeviceToken,
} = require("../../shared/push/deviceToken");
const { User: DefaultUser } = require("../users");

function createNotificationsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const DeviceToken = dependencies.DeviceToken || DefaultDeviceToken;
  const User = dependencies.User || DefaultUser;

  router.use(requireAuth);

  // GET /notifications/preferences (§9.1). Auth required. Absent/never-set
  // preference reads as true (the model defaults it). Old clients never call
  // this; device-token registration and all existing endpoints are untouched.
  router.get("/preferences", async (req, res) => {
    try {
      const prefs = await User.getNotificationPreferences(req.user.id);
      res.json({
        dailyRewardRemindersEnabled: prefs.dailyRewardRemindersEnabled !== false,
      });
    } catch (error) {
      console.error("Get notification preferences error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /notifications/preferences (§9.1). Body: { dailyRewardRemindersEnabled:
  // boolean }. Unknown fields are ignored; a non-boolean field is a 400. Returns
  // the persisted value.
  router.patch("/preferences", async (req, res) => {
    try {
      const value = req.body ? req.body.dailyRewardRemindersEnabled : undefined;
      if (value === undefined) {
        // No recognized field present — nothing to change; echo current value.
        const prefs = await User.getNotificationPreferences(req.user.id);
        return res.json({
          dailyRewardRemindersEnabled: prefs.dailyRewardRemindersEnabled !== false,
        });
      }
      if (typeof value !== "boolean") {
        return res
          .status(400)
          .json({ error: "dailyRewardRemindersEnabled must be a boolean" });
      }
      const saved = await User.setDailyRewardRemindersEnabled(req.user.id, value);
      res.json({ dailyRewardRemindersEnabled: saved.dailyRewardRemindersEnabled });
    } catch (error) {
      console.error("Update notification preferences error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /notifications/device-token
  router.post("/device-token", async (req, res) => {
    try {
      const { deviceToken, platform } = req.body;

      if (!deviceToken || typeof deviceToken !== "string") {
        return res.status(400).json({ error: "deviceToken is required" });
      }

      if (!["ios", "android"].includes(platform)) {
        return res
          .status(400)
          .json({ error: "platform must be 'ios' or 'android'" });
      }

      await DeviceToken.saveToken({
        userId: req.user.id,
        token: deviceToken,
        platform,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Device token registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /notifications/device-token
  router.delete("/device-token", async (req, res) => {
    try {
      const { deviceToken } = req.body;

      if (!deviceToken || typeof deviceToken !== "string") {
        return res.status(400).json({ error: "deviceToken is required" });
      }

      await DeviceToken.deleteToken({
        userId: req.user.id,
        token: deviceToken,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Device token removal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createNotificationsRouter };
