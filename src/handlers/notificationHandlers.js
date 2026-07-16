const { eventBus } = require("../events/eventBus");
const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("../services/apns");
const { fcmService } = require("../services/fcm");
const { Notification } = require("../models/notification");
const { prisma } = require("../db");

const CHAT_PUSH_COOLDOWN_MS = 60_000;

function registerNotificationHandlers(dependencies = {}) {
  const events = dependencies.eventBus || eventBus;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const fcm = dependencies.fcmService || fcmService;
  const raceParticipantModel = dependencies.RaceParticipant || prisma.raceParticipant;
  const raceModel = dependencies.Race || prisma.race;
  const notificationModel = dependencies.Notification || Notification;
  const logger = dependencies.logger || console;

  // Persist one row per user-facing (visible) notification we send, for audit /
  // debugging (a nightly job prunes rows older than a week). Best-effort: a
  // logging failure must never break the actual push, so it's swallowed.
  async function recordNotification({ userId, type, title, body, raceId }) {
    if (!userId || !type) return;
    try {
      await notificationModel.create({
        userId,
        type,
        title: title ?? null,
        body: body ?? null,
        raceId: raceId ?? null,
      });
    } catch (error) {
      logger.error("recordNotification failed", {
        userId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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

    const body = buildBody(actorName);

    for (const tokenRecord of tokens) {
      try {
        const result = await pushServiceFor(tokenRecord).sendNotification({
          deviceToken: tokenRecord.token,
          title,
          body,
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

    // One audit row per recipient (the user had tokens, so we dispatched).
    await recordNotification({
      userId: recipientUserId,
      type: (payload && payload.type) || eventName,
      title,
      body,
      raceId:
        (payload && payload.params && payload.params.raceId) ||
        (payload && payload.raceId) ||
        null,
    });
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

  // Issue 4: the owner changed a PENDING race's buy-in and coins were
  // re-charged/refunded. Notify each charged non-owner participant. Best-effort:
  // a failure here never affects the edit (the edit already committed).
  events.on("RACE_BUYIN_CHANGED", async (data) => {
    try {
      const { raceId, raceName, newBuyIn, affectedUserIds } = data;
      if (!Array.isArray(affectedUserIds) || affectedUserIds.length === 0) return;
      const label = raceName ? `${raceName}'s` : "The race's";
      const body =
        newBuyIn && newBuyIn > 0
          ? `${label} buy-in is now ${newBuyIn} coins.`
          : `${label} buy-in is now free.`;
      for (const recipientUserId of affectedUserIds) {
        await sendNotificationToUser({
          eventName: "RACE_BUYIN_CHANGED",
          recipientUserId,
          actorUserId: null,
          title: "Buy-in updated",
          buildBody: () => body,
          payload: {
            type: "RACE_BUYIN_CHANGED",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, recipientUserId },
        });
      }
    } catch (error) {
      logger.error("RACE_BUYIN_CHANGED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // TR-304: scheduled team race couldn't auto-start because teams were uneven.
  // The auto-start job pre-checks the Notification audit table and emits this at
  // most once per (creator, race); the audit row recordNotification writes below
  // is what makes the dedup stick.
  events.on("RACE_SCHEDULED_TEAMS_UNEVEN", async (data) => {
    try {
      const { raceId, creatorUserId } = data;
      await sendNotificationToUser({
        eventName: "RACE_SCHEDULED_TEAMS_UNEVEN",
        recipientUserId: creatorUserId,
        actorUserId: creatorUserId,
        title: "Teams are uneven",
        buildBody: () =>
          "Your race couldn't start — teams are uneven. Even them up and it'll start on the next check!",
        payload: {
          type: "TEAM_RACE_SCHEDULED_UNEVEN",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, creatorUserId },
      });
    } catch (error) {
      logger.error("RACE_SCHEDULED_TEAMS_UNEVEN handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_STARTED", async (data) => {
    try {
      const {
        raceId,
        raceName,
        creatorUserId,
        participantUserIds,
        isTeamRace,
        teamAName,
        teamBName,
      } = data;
      // TR-684: team races get team-framed start copy.
      const startBody =
        isTeamRace && teamAName && teamBName
          ? `The team race "${raceName}" has started — ${teamAName} vs ${teamBName}. Go!`
          : `The race "${raceName}" has started! Go!`;
      for (const participantUserId of participantUserIds) {
        if (participantUserId === creatorUserId) continue;
        await sendNotificationToUser({
          eventName: "RACE_STARTED",
          recipientUserId: participantUserId,
          actorUserId: creatorUserId,
          title: "Race Started",
          buildBody: () => startBody,
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
      const {
        raceId,
        winnerUserId,
        participantUserIds,
        winnerTeam,
        tie,
        winnerTeamName,
        loserTeamName,
        memberTeams,
      } = data;
      if (!participantUserIds || participantUserIds.length === 0) return;

      // TR-684/404: team races frame the result by team name; ties get the
      // dedicated refund copy. Individual races keep the existing copy.
      const isTeamResult = tie === true || (winnerTeam != null);
      for (const participantUserId of participantUserIds) {
        let buildBody;
        if (isTeamResult) {
          if (tie === true) {
            buildBody = () => `It's a tie — buy-ins refunded.`;
          } else {
            const recipientTeam = (memberTeams || {})[participantUserId] || null;
            const won = recipientTeam != null && recipientTeam === winnerTeam;
            buildBody = won
              ? () => `${winnerTeamName || "Your team"} win! Great racing.`
              : () =>
                  `${winnerTeamName || "The other team"} took it — better luck next time, ${loserTeamName || "team"}.`;
          }
        } else {
          buildBody = (winnerName) => `${winnerName} won the race!`;
        }
        await sendNotificationToUser({
          eventName: "RACE_COMPLETED",
          recipientUserId: participantUserId,
          actorUserId: winnerUserId,
          title: "Race Finished",
          buildBody,
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

  // ── Team-race pushes (TR-681/682/683) ─────────────────────────────────────

  // TR-681: team lead flip — one push per member of BOTH teams, throttled per
  // race with the same window as the individual placement alert (the
  // "overtake nudge" cooldown), so churny back-and-forth flips don't spam.
  const TEAM_LEAD_COOLDOWN_MS = 10 * 60 * 1000;
  const lastTeamLeadAlertAt = new Map(); // raceId -> epoch ms

  events.on("TEAM_LEAD_CHANGED", async (data) => {
    try {
      const {
        raceId,
        raceName,
        leadingTeamName,
        trailingTeamName,
        memberUserIds,
      } = data || {};
      if (!raceId || !memberUserIds || memberUserIds.length === 0) return;

      const nowMs = Date.now();
      if (nowMs - (lastTeamLeadAlertAt.get(raceId) || 0) < TEAM_LEAD_COOLDOWN_MS) {
        return;
      }
      lastTeamLeadAlertAt.set(raceId, nowMs);

      const body = `${leadingTeamName || "A team"} just took the lead over ${trailingTeamName || "the other team"} in ${raceName || "your race"}!`;
      for (const recipientUserId of memberUserIds) {
        await sendNotificationToUser({
          eventName: "TEAM_LEAD_CHANGED",
          recipientUserId,
          actorUserId: recipientUserId,
          title: "Team lead change!",
          buildBody: () => body,
          payload: {
            type: "TEAM_LEAD_CHANGED",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, recipientUserId },
        });
      }
    } catch (error) {
      logger.error("TEAM_LEAD_CHANGED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // TR-682: final-stretch team push. Copy has a leading and a trailing
  // variant; throttled 30 minutes per (race, member) — the same throttle the
  // final-stretch step-sync machinery uses.
  const TEAM_FINAL_STRETCH_MIN_INTERVAL_MS = 30 * 60 * 1000;
  const lastTeamStretchAt = new Map(); // `${raceId}:${userId}` -> epoch ms

  function formatTimeLeft(endsAt) {
    const msLeft = new Date(endsAt).getTime() - Date.now();
    if (!Number.isFinite(msLeft) || msLeft <= 0) return "Almost no time";
    const hours = Math.floor(msLeft / (60 * 60 * 1000));
    if (hours >= 1) return `${hours}h`;
    const minutes = Math.max(1, Math.round(msLeft / (60 * 1000)));
    return `${minutes}m`;
  }

  events.on("TEAM_FINAL_STRETCH", async (data) => {
    try {
      const {
        raceId,
        raceName,
        teamATotal,
        teamBTotal,
        endsAt,
        memberUserIds,
        memberTeams,
      } = data || {};
      if (!raceId || !memberUserIds || memberUserIds.length === 0) return;

      const diff = Math.abs((teamATotal || 0) - (teamBTotal || 0));
      const leading =
        (teamATotal || 0) === (teamBTotal || 0)
          ? null
          : (teamATotal || 0) > (teamBTotal || 0)
            ? "TEAM_A"
            : "TEAM_B";
      const timeLeft = formatTimeLeft(endsAt);
      const nowMs = Date.now();

      for (const recipientUserId of memberUserIds) {
        const throttleKey = `${raceId}:${recipientUserId}`;
        if (
          nowMs - (lastTeamStretchAt.get(throttleKey) || 0) <
          TEAM_FINAL_STRETCH_MIN_INTERVAL_MS
        ) {
          continue;
        }
        lastTeamStretchAt.set(throttleKey, nowMs);

        const recipientTeam = (memberTeams || {})[recipientUserId] || null;
        let body;
        if (leading == null) {
          body = `${timeLeft} left in ${raceName || "your race"} — it's dead even. Every step counts!`;
        } else if (recipientTeam === leading) {
          body = `${timeLeft} left — you're up ${diff.toLocaleString()}, hold the lead!`;
        } else {
          body = `${timeLeft} left — your team is down ${diff.toLocaleString()} steps. Rally!`;
        }

        await sendNotificationToUser({
          eventName: "TEAM_FINAL_STRETCH",
          recipientUserId,
          actorUserId: recipientUserId,
          title: "Final stretch!",
          buildBody: () => body,
          payload: {
            type: "TEAM_FINAL_STRETCH",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, recipientUserId },
        });
      }
    } catch (error) {
      logger.error("TEAM_FINAL_STRETCH handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // TR-683: gentle slacker nudge. The placementRecompute job enforces the
  // final-12h window and once-per-race dedup (via the Notification audit row
  // this handler records) — this handler just delivers playful, never-shaming
  // copy.
  events.on("TEAM_SLACKER_NUDGE", async (data) => {
    try {
      const { raceId, raceName, userId, teamName } = data || {};
      if (!raceId || !userId) return;
      await sendNotificationToUser({
        eventName: "TEAM_SLACKER_NUDGE",
        recipientUserId: userId,
        actorUserId: userId,
        title: "Your team believes in you!",
        buildBody: () =>
          `${teamName || "Your team"} could use a few more steps in ${raceName || "your race"} — even a quick stroll helps. You've got this!`,
        payload: {
          type: "TEAM_SLACKER_NUDGE",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, userId },
      });
    } catch (error) {
      logger.error("TEAM_SLACKER_NUDGE handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Referral payout (M2): tell the REFERRER their friend finished a first race
  // and they earned coins. The referee isn't pushed — they're actively in-app
  // (they just finished a race) and see their own +coins on the results screen.
  // The `type` is brand-new: already-shipped binaries show the alert but won't
  // deep-link it (their _routeFromType returns null for unknown types — the
  // PLACEMENT_CHANGED precedent); only updated apps that add the case navigate.
  events.on("REFERRAL_REWARDED", async (data) => {
    try {
      const { referrerId, refereeId, coins } = data || {};
      if (!referrerId) return;

      await sendNotificationToUser({
        eventName: "REFERRAL_REWARDED",
        recipientUserId: referrerId,
        actorUserId: refereeId,
        title: "You earned coins!",
        buildBody: (friendName) =>
          `${friendName} completed their first race — you earned ${coins} coins!`,
        payload: {
          type: "REFERRAL_REWARDED",
          route: "home",
        },
        logContext: { referrerId, refereeId, coins },
      });
    } catch (error) {
      logger.error("REFERRAL_REWARDED handler failed", {
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
    SIGNAL_JAMMER: (attackerName) => `${attackerName} jammed your powerups for 1 hour! 📵`,
  };

  events.on("POWERUP_USED", async (data) => {
    try {
      const { raceId, userId, powerupType, targetUserId } = data;
      if (!targetUserId || !["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "SIGNAL_JAMMER"].includes(powerupType)) return;

      // T9 safety net: suppress the attack push if the race is no longer live —
      // not ACTIVE, or already past endsAt (the expired-but-unsettled gap, where
      // status is still ACTIVE until raceExpiry settles it). usePowerup also gates
      // this at the source; this is best-effort, so on any lookup error we proceed
      // rather than drop a legitimate push.
      try {
        const race = await raceModel.findUnique({
          where: { id: raceId },
          select: { status: true, endsAt: true },
        });
        if (race) {
          const ended =
            race.endsAt && Date.now() >= new Date(race.endsAt).getTime();
          if (race.status !== "ACTIVE" || ended) return;
        }
      } catch {}

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

          // Only the visible alert (not the cooldown silent push) is recorded.
          await recordNotification({
            userId: recipient.userId,
            type: "race_message",
            title: raceName || "Race chat",
            body: alertBody,
            raceId,
          });
        }
      }
    } catch (error) {
      logger.error("RACE_MESSAGE_SENT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Live placement broadcast (Phase 0). The placementRecompute job emits this when
  // a participant's live rank changes (muted participants are filtered out at the
  // job, so nothing arrives here for them). Send a SILENT push on every change (so
  // an updated client can refresh quietly), and upgrade to a visible ALERT only on
  // a meaningful threshold crossing — taking or losing 1st, or dropping out of the
  // paid places — throttled per (race,user) so a user in many races isn't spammed.
  // The cooldown is in memory (single pm2 instance per env; shared store if scaled).
  // Old app versions don't know the PLACEMENT_CHANGED route: the alert still shows,
  // and tap routing is a harmless no-op (their _routeFromType returns null).
  const PLACEMENT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
  const lastPlacementAlertAt = new Map(); // `${raceId}:${userId}` -> epoch ms

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
  }

  events.on("PLACEMENT_CHANGED", async (data) => {
    try {
      const { raceId, raceName, userId, previousPlacement, placement, paidPlaces } =
        data || {};
      if (!userId || placement == null) return;

      const tokens = await deviceTokenModel.findByUserId(userId);
      if (!tokens || tokens.length === 0) return;

      // A visible alert fires only on a MEANINGFUL threshold crossing, not on
      // every one-spot slip (which, at a 5-min recompute cadence over a multi-day
      // race, was the source of the notification flood). The silent refresh below
      // still fires on every change for updated clients.
      const tookFirst = placement === 1 && previousPlacement !== 1;
      const lostFirst =
        typeof previousPlacement === "number" &&
        previousPlacement === 1 &&
        placement > 1;
      const droppedOutOfPaid =
        typeof previousPlacement === "number" &&
        typeof paidPlaces === "number" &&
        paidPlaces > 0 &&
        previousPlacement <= paidPlaces &&
        placement > paidPlaces;
      const meaningful = tookFirst || lostFirst || droppedOutOfPaid;

      const cooldownKey = `${raceId}:${userId}`;
      const nowMs = Date.now();
      const withinCooldown =
        nowMs - (lastPlacementAlertAt.get(cooldownKey) || 0) <
        PLACEMENT_ALERT_COOLDOWN_MS;
      const sendAlert = meaningful && !withinCooldown;
      if (sendAlert) lastPlacementAlertAt.set(cooldownKey, nowMs);

      const label = raceName || "your race";
      let title;
      let body;
      if (tookFirst) {
        title = "You're in the lead!";
        body = `You took 1st in ${label}.`;
      } else if (droppedOutOfPaid) {
        title = "Out of the payout";
        body = `You dropped to ${ordinal(placement)} in ${label} — out of the prize places.`;
      } else {
        // lostFirst
        title = "You lost the lead";
        body = `You slipped to ${ordinal(placement)} in ${label}.`;
      }
      const payload = {
        type: "PLACEMENT_CHANGED",
        route: "race_detail",
        params: { raceId },
        placement,
      };

      for (const tokenRecord of tokens) {
        try {
          const push = pushServiceFor(tokenRecord);
          const result = sendAlert
            ? await push.sendNotification({
                deviceToken: tokenRecord.token,
                title,
                body,
                payload,
                collapseId: `placement_${raceId}`,
              })
            : await push.sendSilentNotification({
                deviceToken: tokenRecord.token,
                payload,
              });

          if (!result.success && !result.unregistered) {
            logger.warn("PLACEMENT_CHANGED push failed", {
              raceId,
              recipientUserId: userId,
              deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
              statusCode: result.statusCode,
              reason: result.reason,
            });
          }
          if (result.unregistered) {
            await deviceTokenModel.deleteToken({
              userId,
              token: tokenRecord.token,
            });
          }
        } catch (error) {
          logger.error("PLACEMENT_CHANGED push threw", {
            raceId,
            recipientUserId: userId,
            deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Record only the visible alert; the silent refresh push is not user-facing.
      if (sendAlert) {
        await recordNotification({
          userId,
          type: "PLACEMENT_CHANGED",
          title,
          body,
          raceId,
        });
      }
    } catch (error) {
      logger.error("PLACEMENT_CHANGED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Daily biggest-mover digest (dailyMover job @4pm ET). One visible push for the
  // race a user moved the most in over the last 24h; copy adapts to up vs down.
  events.on("DAILY_MOVER", async (data) => {
    try {
      const { userId, raceId, raceName, movement, placement } = data || {};
      if (!userId || !movement || placement == null) return;

      const tokens = await deviceTokenModel.findByUserId(userId);
      if (!tokens || tokens.length === 0) return;

      const label = raceName || "your race";
      const spots = Math.abs(movement);
      const climbed = movement > 0;
      const title = climbed ? "You're climbing!" : "You slipped";
      const body = climbed
        ? `You moved up ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today — now ${ordinal(placement)}.`
        : `You dropped ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today — now ${ordinal(placement)}.`;

      const payload = {
        type: "DAILY_MOVER",
        route: "race_detail",
        params: { raceId },
        placement,
      };

      for (const tokenRecord of tokens) {
        try {
          const push = pushServiceFor(tokenRecord);
          const result = await push.sendNotification({
            deviceToken: tokenRecord.token,
            title,
            body,
            payload,
            collapseId: `daily_mover_${raceId}`,
          });

          if (!result.success && !result.unregistered) {
            logger.warn("DAILY_MOVER push failed", {
              raceId,
              recipientUserId: userId,
              deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
              statusCode: result.statusCode,
              reason: result.reason,
            });
          }
          if (result.unregistered) {
            await deviceTokenModel.deleteToken({ userId, token: tokenRecord.token });
          }
        } catch (error) {
          logger.error("DAILY_MOVER push threw", {
            raceId,
            recipientUserId: userId,
            deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await recordNotification({
        userId,
        type: "DAILY_MOVER",
        title,
        body,
        raceId,
      });
    } catch (error) {
      logger.error("DAILY_MOVER handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

}

module.exports = { registerNotificationHandlers };
