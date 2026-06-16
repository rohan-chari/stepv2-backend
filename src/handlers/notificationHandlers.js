const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("../services/apns");
const { fcmService } = require("../services/fcm");
const { prisma } = require("../db");

const CHAT_PUSH_COOLDOWN_MS = 60_000;

function registerNotificationHandlers(dependencies = {}) {
  const events = dependencies.eventBus || eventBus;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const fcm = dependencies.fcmService || fcmService;
  const raceParticipantModel = dependencies.RaceParticipant || prisma.raceParticipant;
  const logger = dependencies.logger || console;

  function deviceTokenSuffix(token) {
    if (!token || typeof token !== "string") return "";
    return token.slice(-9);
  }

  // Route by the device token's platform: Android -> FCM, everything else
  // (iOS) -> APNs. This is what keeps Android tokens off APNs (and the 410
  // churn that caused). Both senders share the same result shape, so the
  // unregistered -> deleteToken cleanup below works for either. See ANDROID.md
  // §G2; precedent: stepSyncPush.js's `.filter(platform === "ios")`.
  function pushServiceFor(tokenRecord) {
    return tokenRecord && tokenRecord.platform === "android" ? fcm : apns;
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
        const result = await pushServiceFor(tokenRecord).sendNotification({
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

  events.on("RACE_INVITE_SENT", async (data) => {
    try {
      const { raceId, raceName, creatorUserId, inviteeUserId } = data;
      await sendNotificationToUser({
        eventName: "RACE_INVITE_SENT",
        recipientUserId: inviteeUserId,
        actorUserId: creatorUserId,
        title: "Race Invite",
        buildBody: (creatorName) =>
          `${creatorName} invited you to a race: ${raceName}`,
        payload: {
          type: "RACE_INVITE_SENT",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, inviteeUserId },
      });
    } catch (error) {
      logger.error("RACE_INVITE_SENT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_INVITE_ACCEPTED", async (data) => {
    try {
      const { raceId, userId, creatorUserId, raceName } = data;
      await sendNotificationToUser({
        eventName: "RACE_INVITE_ACCEPTED",
        recipientUserId: creatorUserId,
        actorUserId: userId,
        title: "Race Update",
        buildBody: (userName) => `${userName} joined your race: ${raceName}`,
        payload: {
          type: "RACE_INVITE_ACCEPTED",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, userId },
      });
    } catch (error) {
      logger.error("RACE_INVITE_ACCEPTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_STARTED", async (data) => {
    try {
      const { raceId, raceName, creatorUserId, participantUserIds } = data;
      for (const participantUserId of participantUserIds) {
        if (participantUserId === creatorUserId) continue;
        await sendNotificationToUser({
          eventName: "RACE_STARTED",
          recipientUserId: participantUserId,
          actorUserId: creatorUserId,
          title: "Race Started",
          buildBody: () => `The race "${raceName}" has started! Go!`,
          payload: {
            type: "RACE_STARTED",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, participantUserId },
        });
      }
    } catch (error) {
      logger.error("RACE_STARTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_COMPLETED", async (data) => {
    try {
      const { raceId, winnerUserId, participantUserIds } = data;
      if (!participantUserIds || participantUserIds.length === 0) return;

      for (const participantUserId of participantUserIds) {
        await sendNotificationToUser({
          eventName: "RACE_COMPLETED",
          recipientUserId: participantUserId,
          actorUserId: winnerUserId,
          title: "Race Finished",
          buildBody: (winnerName) => `${winnerName} won the race!`,
          payload: {
            type: "RACE_COMPLETED",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, participantUserId },
        });
      }
    } catch (error) {
      logger.error("RACE_COMPLETED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_CANCELLED", async (data) => {
    try {
      const { raceId, raceName, creatorUserId, participantUserIds } = data;
      for (const participantUserId of participantUserIds) {
        await sendNotificationToUser({
          eventName: "RACE_CANCELLED",
          recipientUserId: participantUserId,
          actorUserId: creatorUserId,
          title: "Race Cancelled",
          buildBody: () => `The race "${raceName}" was cancelled`,
          payload: {
            type: "RACE_CANCELLED",
            route: "races",
          },
          logContext: { raceId, participantUserId },
        });
      }
    } catch (error) {
      logger.error("RACE_CANCELLED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("GLOBAL_EVENT_STARTED", async (data) => {
    try {
      const { multiplier, participantUserIds } = data || {};
      if (!participantUserIds || participantUserIds.length === 0) return;

      const mult = Number(multiplier) || 2;
      for (const recipientUserId of participantUserIds) {
        await sendNotificationToUser({
          eventName: "GLOBAL_EVENT_STARTED",
          recipientUserId,
          actorUserId: null,
          title: `${mult}x STEPS EVENT`,
          buildBody: () =>
            `Double steps are LIVE for 30 minutes — every step counts ${mult}x in your races! Go!`,
          payload: {
            type: "GLOBAL_EVENT_STARTED",
            route: "home",
          },
          logContext: { multiplier: mult, recipientUserId },
        });
      }
    } catch (error) {
      logger.error("GLOBAL_EVENT_STARTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const POWERUP_ATTACK_MESSAGES = {
    LEG_CRAMP: (attackerName) => `${attackerName} used Leg Cramp on you! Your steps are frozen for 2 hours.`,
    RED_CARD: (attackerName) => `${attackerName} used Red Card! You lost steps.`,
    SHORTCUT: (attackerName) => `${attackerName} stole steps from you with Shortcut!`,
    WRONG_TURN: (attackerName) => `${attackerName} sent you on a Wrong Turn! Your steps are reversed for 1 hour.`,
  };

  events.on("POWERUP_USED", async (data) => {
    try {
      const { raceId, userId, powerupType, targetUserId } = data;
      if (!targetUserId || !["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN"].includes(powerupType)) return;

      const buildBody = POWERUP_ATTACK_MESSAGES[powerupType];
      if (!buildBody) return;

      await sendNotificationToUser({
        eventName: "POWERUP_USED",
        recipientUserId: targetUserId,
        actorUserId: userId,
        title: "Powerup Attack!",
        buildBody,
        payload: {
          type: "POWERUP_USED",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, targetUserId, powerupType },
      });
    } catch (error) {
      logger.error("POWERUP_USED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_MESSAGE_SENT", async (data) => {
    try {
      const { raceId, messageId, senderId, body, senderName, raceName } = data;
      const recipients = await raceParticipantModel.findMany({
        where: {
          raceId,
          status: "ACCEPTED",
          userId: { not: senderId },
          chatMuted: false,
        },
      });
      if (recipients.length === 0) return;

      const now = new Date();
      const collapseId = `race_chat_${raceId}`;
      const senderLabel = senderName || "Someone";
      const previewBody = body && body.length > 120 ? `${body.slice(0, 117)}…` : body;
      const alertBody = `${senderLabel}: ${previewBody}`;

      for (const recipient of recipients) {
        const lastPush = recipient.lastChatPushAt;
        const onCooldown =
          lastPush &&
          now.getTime() - new Date(lastPush).getTime() < CHAT_PUSH_COOLDOWN_MS;

        const tokens = await deviceTokenModel.findByUserId(recipient.userId);
        if (!tokens || tokens.length === 0) continue;

        const payload = {
          type: "race_message",
          route: "race_detail",
          params: { raceId },
          raceId,
          messageId,
        };

        for (const tokenRecord of tokens) {
          try {
            const push = pushServiceFor(tokenRecord);
            const result = onCooldown
              ? await push.sendSilentNotification({
                  deviceToken: tokenRecord.token,
                  payload,
                })
              : await push.sendNotification({
                  deviceToken: tokenRecord.token,
                  title: raceName || "Race chat",
                  body: alertBody,
                  payload,
                  collapseId,
                  threadId: collapseId,
                });

            if (!result.success && !result.unregistered) {
              logger.warn("RACE_MESSAGE_SENT push failed", {
                raceId,
                recipientUserId: recipient.userId,
                deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
                statusCode: result.statusCode,
                reason: result.reason,
              });
            }
            if (result.unregistered) {
              await deviceTokenModel.deleteToken({
                userId: recipient.userId,
                token: tokenRecord.token,
              });
            }
          } catch (error) {
            logger.error("RACE_MESSAGE_SENT push threw", {
              raceId,
              recipientUserId: recipient.userId,
              deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (!onCooldown) {
          try {
            await raceParticipantModel.update({
              where: { id: recipient.id },
              data: { lastChatPushAt: now },
            });
          } catch (error) {
            logger.error("RACE_MESSAGE_SENT lastChatPushAt update failed", {
              raceId,
              recipientUserId: recipient.userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      logger.error("RACE_MESSAGE_SENT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

}

module.exports = { registerNotificationHandlers };
