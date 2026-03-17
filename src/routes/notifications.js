const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  DeviceToken: DefaultDeviceToken,
} = require("../models/deviceToken");

function createNotificationsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const DeviceToken = dependencies.DeviceToken || DefaultDeviceToken;

  router.use(requireAuth);

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
