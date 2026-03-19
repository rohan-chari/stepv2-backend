const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("../services/apns");

function registerNotificationHandlers(dependencies = {}) {
  const events = dependencies.eventBus || eventBus;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const logger = dependencies.logger || console;

  function deviceTokenSuffix(token) {
    if (!token || typeof token !== "string") return "";
    return token.slice(-9);
  }

  async function findActorName(userId) {
    let actorName = "Someone";

    try {
      const user = await userModel.findById(userId);
      if (user && user.displayName) {
        actorName = user.displayName;
      }
    } catch {}

    return actorName;
  }

  async function sendNotificationToUser({
    eventName,
    recipientUserId,
    actorUserId,
    title,
    buildBody,
    payload,
    logContext = {},
  }) {
    const actorName = await findActorName(actorUserId);
    const tokens = await deviceTokenModel.findByUserId(recipientUserId);
    if (!tokens || tokens.length === 0) return;

    for (const tokenRecord of tokens) {
      try {
        const result = await apns.sendNotification({
          deviceToken: tokenRecord.token,
          title,
          body: buildBody(actorName),
          payload,
        });

        if (!result.success && !result.unregistered) {
          logger.warn(`${eventName} push failed`, {
            ...logContext,
            deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
            statusCode: result.statusCode,
            reason: result.reason,
          });
        }

        if (result.unregistered) {
          await deviceTokenModel.deleteToken({
            userId: recipientUserId,
            token: tokenRecord.token,
          });
        }
      } catch (error) {
        logger.error(`${eventName} push threw`, {
          ...logContext,
          deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  events.on("CHALLENGE_INITIATED", async (data) => {
    try {
      const { instanceId, userId, friendUserId } = data;
      await sendNotificationToUser({
        eventName: "CHALLENGE_INITIATED",
        recipientUserId: friendUserId,
        actorUserId: userId,
        title: "New Challenge",
        buildBody: (challengerName) => `${challengerName} challenged you!`,
        payload: {
          type: "CHALLENGE_INITIATED",
          route: "challenge_detail",
          params: { instanceId },
        },
        logContext: { friendUserId, instanceId },
      });
    } catch (error) {
      logger.error("CHALLENGE_INITIATED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("FRIEND_REQUEST_SENT", async (data) => {
    try {
      const { userId, addresseeId } = data;

      await sendNotificationToUser({
        eventName: "FRIEND_REQUEST_SENT",
        recipientUserId: addresseeId,
        actorUserId: userId,
        title: "New Friend Request",
        buildBody: (senderName) => `${senderName} sent you a friend request`,
        payload: {
          type: "FRIEND_REQUEST_SENT",
          route: "friends",
        },
        logContext: { addresseeId, senderUserId: userId },
      });
    } catch (error) {
      logger.error("FRIEND_REQUEST_SENT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("FRIEND_REQUEST_ACCEPTED", async (data) => {
    try {
      const { userId, requesterId, friendshipId } = data;

      await sendNotificationToUser({
        eventName: "FRIEND_REQUEST_ACCEPTED",
        recipientUserId: requesterId,
        actorUserId: userId,
        title: "Friend Request Accepted",
        buildBody: (acceptorName) =>
          `${acceptorName} accepted your friend request`,
        payload: {
          type: "FRIEND_REQUEST_ACCEPTED",
          route: "friends",
        },
        logContext: { requesterId, friendshipId, acceptedByUserId: userId },
      });
    } catch (error) {
      logger.error("FRIEND_REQUEST_ACCEPTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("STAKE_ACCEPTED", async (data) => {
    try {
      const { instanceId, acceptedById, proposedById } = data;
      if (!proposedById) return;

      await sendNotificationToUser({
        eventName: "STAKE_ACCEPTED",
        recipientUserId: proposedById,
        actorUserId: acceptedById,
        title: "Challenge Accepted",
        buildBody: (acceptorName) =>
          `${acceptorName} accepted your challenge`,
        payload: {
          type: "STAKE_ACCEPTED",
          route: "challenge_detail",
          params: { instanceId },
        },
        logContext: { instanceId, acceptedById, proposedById },
      });
    } catch (error) {
      logger.error("STAKE_ACCEPTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

          if (!result.success && !result.unregistered) {
            logger.warn("CHALLENGE_DROPPED push failed", {
              challengeId,
              deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
              statusCode: result.statusCode,
              reason: result.reason,
            });
          }

          if (result.unregistered) {
            await deviceTokenModel.deleteToken({
              userId: tokenRecord.userId,
              token: tokenRecord.token,
            });
          }
        } catch (error) {
          logger.error("CHALLENGE_DROPPED push threw", {
            challengeId,
            deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      logger.error("CHALLENGE_DROPPED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

module.exports = { registerNotificationHandlers };
