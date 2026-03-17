const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("../services/apns");

function registerNotificationHandlers(dependencies = {}) {
  const events = dependencies.eventBus || eventBus;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;

  events.on("CHALLENGE_INITIATED", async (data) => {
    try {
      const { instanceId, userId, friendUserId } = data;

      let challengerName = "Someone";
      try {
        const challenger = await userModel.findById(userId);
        if (challenger && challenger.displayName) {
          challengerName = challenger.displayName;
        }
      } catch {}

      const tokens = await deviceTokenModel.findByUserId(friendUserId);
      if (!tokens || tokens.length === 0) return;

      for (const tokenRecord of tokens) {
        try {
          const result = await apns.sendNotification({
            deviceToken: tokenRecord.token,
            title: "New Challenge",
            body: `${challengerName} challenged you!`,
            payload: {
              type: "CHALLENGE_INITIATED",
              route: "challenge_detail",
              params: { instanceId },
            },
          });

          if (result.unregistered) {
            await deviceTokenModel.deleteToken({
              userId: friendUserId,
              token: tokenRecord.token,
            });
          }
        } catch {}
      }
    } catch {}
  });

  events.on("CHALLENGE_DROPPED", async (data) => {
    try {
      const { challengeId, title } = data;

      const tokens = await deviceTokenModel.findAll();
      if (!tokens || tokens.length === 0) return;

      for (const tokenRecord of tokens) {
        try {
          const result = await apns.sendNotification({
            deviceToken: tokenRecord.token,
            title: "New Competition",
            body: `This week's competition: ${title}`,
            payload: {
              type: "WEEKLY_CHALLENGE_DROPPED",
              route: "challenges",
              params: { challengeId },
            },
          });

          if (result.unregistered) {
            await deviceTokenModel.deleteToken({
              userId: tokenRecord.userId,
              token: tokenRecord.token,
            });
          }
        } catch {}
      }
    } catch {}
  });
}

module.exports = { registerNotificationHandlers };
