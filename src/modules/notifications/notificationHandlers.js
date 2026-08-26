const { eventBus } = require("../../shared/events/eventBus");
const { User } = require("../users");
const { DeviceToken } = require("../../shared/push/deviceToken");
const { apnsService } = require("../../shared/push/apns");
const { fcmService } = require("../../shared/push/fcm");
const { Notification } = require("./notification");
const { upgradedDuration, formatDuration } = require("../powerups/powerupUpgrades");
const { prisma } = require("../../db");
const {
  readPerformanceFlags,
} = require("../../shared/config/performanceFlags");
const { appSettings } = require("../../shared/config/appSettings");
const { createInboxAlert } = require("../inbox/services/inbox");
const { canonicalPushDeliveryKey } = require("./pushDeliveryAttribution");
const {
  buildNotificationIntentService,
} = require("./services/notificationDelivery");
const {
  buildSilentRefreshDelivery,
} = require("./services/silentRefreshDelivery");

const CHAT_PUSH_COOLDOWN_MS = 60_000;
const INBOX_VISIBLE_TYPES = new Set([
  "FRIEND_REQUEST_SENT", "FRIEND_REQUEST_ACCEPTED",
  "RACE_INVITE_SENT", "RACE_INVITE_ACCEPTED", "RACE_BUYIN_CHANGED",
  "TEAM_RACE_SCHEDULED_UNEVEN", "RACE_STARTED", "RACE_ENDING_SOON",
  "STEP_MILESTONE_REMINDER", "RACE_COMPLETED", "TEAM_LEAD_CHANGE",
  "TEAM_FINAL_STRETCH", "TEAM_SLACKER_NUDGE", "REFERRAL_REWARDED",
  "RACE_CANCELLED", "GLOBAL_EVENT_STARTED", "POWERUP_USED", "race_message",
  "PLACEMENT_CHANGED", "HIGH_MULTIPLIER_ALERT", "DAILY_MOVER",
  "TOURNAMENT_INVITE_SENT", "TOURNAMENT_STARTED", "TOURNAMENT_ROUND_STARTED",
  "TOURNAMENT_MATCHUP_WON", "TOURNAMENT_ELIMINATED", "TOURNAMENT_CHAMPION",
  "TOURNAMENT_COMPLETED", "TOURNAMENT_CANCELLED",
  "DAILY_REWARD_REMINDER_17", "DAILY_REWARD_REMINDER_21",
]);

function registerNotificationHandlers(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const events = dependencies.eventBus || eventBus;
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const fcm = dependencies.fcmService || fcmService;
  const raceParticipantModel = dependencies.RaceParticipant || prisma.raceParticipant;
  const raceModel = dependencies.Race || prisma.race;
  const notificationModel = dependencies.Notification || Notification;
  const logger = dependencies.logger || console;
  const settings = dependencies.appSettings || appSettings;
  const createAlert = dependencies.createInboxAlert || createInboxAlert;
  const compatibilityProviderFallback = dependencies.compatibilityProviderFallback === true || (
    !dependencies.prisma &&
    !dependencies.createInboxAlert &&
    !dependencies.notificationIntentService &&
    (dependencies.apnsService || dependencies.fcmService)
  );
  const domainEventProjection = dependencies.domainEventProjection === true;
  const notificationService = dependencies.notificationIntentService ||
    buildNotificationIntentService({
      prisma: db,
      createInboxAlert: createAlert,
      ...(dependencies.createInboxAlert ? { transaction: async (work) => work({}) } : {}),
      publishWakeup: dependencies.publishWakeup,
      DeviceToken: deviceTokenModel,
      apnsService: apns,
      fcmService: fcm,
      logger,
    });
  const silentRefreshDelivery = dependencies.silentRefreshDelivery ||
    buildSilentRefreshDelivery({
      DeviceToken: deviceTokenModel,
      apnsService: apns,
      fcmService: fcm,
      logger,
    });
  const getPerformanceFlags = dependencies.getPerformanceFlags ||
    (() => readPerformanceFlags());

  // Persist one row per user-facing (visible) notification we send, for audit /
  // debugging (a nightly job prunes rows older than a week). Best-effort: a
  // logging failure must never break the actual push, so it's swallowed.
  async function recordNotification({ userId, type, title, body, raceId, deliveryKey = null }) {
    if (!userId || !type) return;
    try {
      await notificationModel.create({
        userId,
        type,
        title: title ?? null,
        body: body ?? null,
        raceId: raceId ?? null,
        ...(deliveryKey ? { deliveryKey } : {}),
      });
    } catch (error) {
      logger.error("recordNotification failed", {
        userId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function queueInboxDelivery({ recipientUserId, eventName, title, body, payload, sourceId, compatibilityMetrics = null }) {
    const raceId = payload?.raceId || payload?.params?.raceId || null;
    const tournamentId = payload?.tournamentId || payload?.params?.tournamentId || null;
    // Preserve the wire type used by shipped push clients. `eventName` is the
    // server event (for example RACE_MESSAGE_SENT), while `payload.type` is
    // sometimes its older public spelling (`race_message`).
    const type = String(payload?.type || eventName || "ALERT");
    if (!INBOX_VISIBLE_TYPES.has(type)) {
      logger.warn("Inbox alert skipped for unknown visible type", { eventName: type, userId: recipientUserId });
      return false;
    }
    const destination = raceId
      ? { route: "raceDetail", raceId: String(raceId) }
      : tournamentId
        ? { route: "tournamentDetail", tournamentId: String(tournamentId) }
        : /DAILY|REWARD|BOX/.test(type)
          ? { route: "dailyReward" }
          : /FRIEND|SOCIAL/.test(type)
            ? { route: "friends" }
            : { route: "home" };
    // Most domain events carry an immutable ID. Older writers that predate that
    // convention still funnel through the durable path using a stable digest of
    // the visible event (never a random retry key), so they cannot bypass Inbox
    // merely because the user has no device token.
    const domainId = sourceId || payload?.messageId || payload?.eventId || payload?.id ||
      payload?.deliveryKey || raceId || tournamentId;
    if (!domainId) {
      logger.warn("Inbox alert skipped without a durable source id", {
        eventName: type,
        userId: recipientUserId,
      });
      return false;
    }
    // Narrow legacy/injected callers do not expose the durable DB seam. Keep
    // their established provider behavior through the shared compatibility
    // adapter; production startup does not select this branch.
    if (compatibilityProviderFallback) {
      try {
        const result = await notificationService.legacyImmediate({
          recipientUserId,
          title: title || "BARA",
          body,
          payload,
          metrics: compatibilityMetrics,
        });
        return result?.sent === true;
      } catch (error) {
        logger.error("legacy visible notification failed", {
          eventName: type,
          userId: recipientUserId,
          error: error?.message || String(error),
        });
        return false;
      }
    }
    try {
      await notificationService.submit({
        recipientUserId,
        type,
        title: title || "BARA",
        body,
        payload,
        deliveryKey: canonicalPushDeliveryKey(type, recipientUserId, domainId),
        availableAt: payload?.availableAt || new Date(),
        ...(payload?.expiresAt ? { expiresAt: payload.expiresAt } : {}),
      });
      return true;
    } catch (error) {
      logger.error("Inbox alert creation failed", { eventName: type, userId: recipientUserId, error: error?.message || String(error) });
      // Preserve the long-shipped immediate push on an Inbox write failure.
      // This compatibility seam also covers callers that intentionally run
      // without the Inbox capability during a mixed-version rollout.
      if (!compatibilityProviderFallback) return false;
      try {
        const result = await notificationService.legacyImmediate({
          recipientUserId,
          title: title || "BARA",
          body,
          payload,
          metrics: compatibilityMetrics,
        });
        return result?.sent === true;
      } catch (legacyError) {
        logger.error("legacy visible notification failed", {
          eventName: type,
          userId: recipientUserId,
          error: legacyError?.message || String(legacyError),
        });
        return false;
      }
    }
  }

  // Rolling-deploy compatibility for cron notifications. New schedulers claim
  // before emitting and set notificationClaimed=true. If an old scheduler emits
  // without that flag into this new handler, claim here before delivery. The
  // unique deliveryKey makes concurrent new processes exactly-once.
  async function claimCronNotification({
    userId,
    type,
    raceId,
    notificationClaimed,
  }) {
    if (notificationClaimed === true) {
      return { send: true, skipAudit: true };
    }
    if (typeof notificationModel.claimDelivery !== "function") {
      return { send: true, skipAudit: false };
    }
    try {
      const claimed = await notificationModel.claimDelivery({
        userId,
        type,
        raceId,
        deliveryKey: `cron:${type}:${raceId}:${userId}`,
      });
      return { send: claimed, skipAudit: claimed };
    } catch (error) {
      logger.error(`${type} notification claim failed`, {
        raceId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { send: false, skipAudit: false };
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
    sourceId,
    // §7: when the caller already wrote the audit row (e.g. the daily-reward
    // scheduler's INSERT-FIRST deliveryKey claim IS the audit row), skip the
    // second recordNotification so there's exactly one row.
    skipAudit = false,
  }) {
    const actorName = await findActorName(actorUserId);
    const body = buildBody(actorName);
    const contextSource = sourceId || payload?.messageId || payload?.eventId ||
      payload?.deliveryKey || payload?.raceId || payload?.params?.raceId ||
      payload?.tournamentId || payload?.params?.tournamentId;
    if (!contextSource) {
      logger.error("Visible notification missing durable intent id", {
        eventName,
        recipientUserId,
      });
      return;
    }
    const queued = await queueInboxDelivery({
      recipientUserId, eventName, title, body, payload, sourceId: contextSource,
    });
    if (!queued) {
      logger.error(`${eventName} notification intent was not persisted`, logContext);
      return;
    }

    // One audit row per recipient (the user had tokens, so we dispatched) —
    // unless the caller already recorded it (skipAudit).
    if (!skipAudit) {
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
        sourceId: `${userId}:${addresseeId}`,
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
        sourceId: friendshipId || `${requesterId}:${userId}`,
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
      const { raceId, raceName, newBuyIn, affectedUserIds, notificationIntentId } = data;
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
          sourceId: notificationIntentId,
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
          "Your race couldn't start. Teams are uneven. Even them up and it'll start on the next check!",
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
      // Suppress for tournament matchup races — the TOURNAMENT_* pushes replace
      // the generic race start/finish alerts (§6.5). (Matchups don't emit this
      // event today; this is a defensive backstop.)
      if (data && data.tournamentId) return;
      const {
        raceId,
        raceName,
        creatorUserId,
        participantUserIds,
        isTeamRace,
        teamAName,
        teamBName,
        isSeededBucket,
      } = data;
      // Device capabilities are not tracked per token. A private seeded bucket
      // must therefore never send its account-wide start notification with a
      // deep-link race ID: an older device sharing this account would receive
      // an unusable/private route. The capable app discovers its assigned card
      // through the authenticated bucket-aware reads instead.
      if (isSeededBucket === true) return;
      // TR-684: team races get team-framed start copy.
      const startBody =
        isTeamRace && teamAName && teamBName
          ? `The team race "${raceName}" has started. ${teamAName} vs ${teamBName}. Go!`
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

  // §8: race-ending-soon reminder. The placementRecompute job claims each new
  // delivery before emitting; the handler's rolling-deploy fallback claims an
  // event from an older scheduler before delivering it.
  // `formatTimeLeft` is defined below in the team-push block; declared with a
  // function statement so it's hoisted and usable here.
  events.on("RACE_ENDING_SOON", async (data) => {
    try {
      const {
        raceId,
        raceName,
        endsAt,
        userId,
        notificationClaimed,
      } = data || {};
      if (!raceId || !userId) return;
      const claim = await claimCronNotification({
        userId,
        type: "RACE_ENDING_SOON",
        raceId,
        notificationClaimed,
      });
      if (!claim.send) return;
      const label = raceName || "Your race";
      // "about N hours" — round to the nearest hour so a fire at ~1h55m left
      // reads "2 hours" (floor-based formatTimeLeft would say "1h"). The reminder
      // fires on the first tick within 2h of the end, so this is ~2 in practice.
      const msLeft = new Date(endsAt).getTime() - Date.now();
      const hoursLeft = Math.max(1, Math.round(msLeft / (60 * 60 * 1000)));
      const hoursText = hoursLeft === 1 ? "1 hour" : `${hoursLeft} hours`;
      await sendNotificationToUser({
        eventName: "RACE_ENDING_SOON",
        recipientUserId: userId,
        actorUserId: null,
        title: "Race ending soon",
        buildBody: () =>
          `${label} ends in about ${hoursText}. Time for a final push.`,
        payload: {
          type: "RACE_ENDING_SOON",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, userId },
        skipAudit: claim.skipAudit,
      });
    } catch (error) {
      logger.error("RACE_ENDING_SOON handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // §7: daily-reward reminder. The dailyRewardReminder job emits ONE event per
  // user it has ALREADY claimed (INSERT-FIRST deliveryKey) and audited, so this
  // handler only delivers the push — skipAudit:true avoids a duplicate row. The
  // payload deep-links to the daily-reward screen and carries no extra-spin CTA.
  events.on("DAILY_REWARD_REMINDER", async (data) => {
    try {
      const { userId, slot, title, body, localDate } = data || {};
      if (!userId || (slot !== 17 && slot !== 21)) return;
      await sendNotificationToUser({
        eventName: `DAILY_REWARD_REMINDER_${slot}`,
        recipientUserId: userId,
        actorUserId: null,
        title: title || "Your daily box is waiting",
        buildBody: () => body || "Your mystery box has been sitting here all day. Awkward.",
        payload: {
          type: `DAILY_REWARD_REMINDER_${slot}`,
          route: "daily_reward",
          params: {},
        },
        logContext: { userId, slot },
        sourceId: localDate ? `${userId}:${localDate}:${slot}` : `${userId}:${slot}`,
        skipAudit: true,
      });
    } catch (error) {
      logger.error("DAILY_REWARD_REMINDER handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Batch 2026-08-08 item 3: step-milestone evening reminder. Like the
  // daily-reward reminder, the job has ALREADY written the audit row via its
  // INSERT-FIRST deliveryKey claim, so skipAudit:true avoids a duplicate.
  // Old clients don't know this payload type and fall back to a plain alert
  // with no deep link (notification_service.dart:439).
  events.on("STEP_MILESTONE_REMINDER", async (data) => {
    try {
      const { userId, title, body, localDate } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "STEP_MILESTONE_REMINDER",
        recipientUserId: userId,
        actorUserId: null,
        title: title || "Coins waiting! 🪙",
        buildBody: () =>
          body ||
          "You crossed a step milestone today. Collect your coins before midnight.",
        payload: {
          type: "STEP_MILESTONE_REMINDER",
          route: "home",
          params: {},
        },
        logContext: { userId },
        sourceId: localDate ? `${userId}:${localDate}` : userId,
        skipAudit: true,
      });
    } catch (error) {
      logger.error("STEP_MILESTONE_REMINDER handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("RACE_COMPLETED", async (data) => {
    try {
      // Suppress for tournament matchup races (see RACE_STARTED note).
      if (data && data.tournamentId) return;
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
            buildBody = () => `It's a tie. Buy-ins refunded.`;
          } else {
            const recipientTeam = (memberTeams || {})[participantUserId] || null;
            const won = recipientTeam != null && recipientTeam === winnerTeam;
            buildBody = won
              ? () => `${winnerTeamName || "Your team"} win! Great racing.`
              : () =>
                  `${winnerTeamName || "The other team"} took it. Better luck next time, ${loserTeamName || "team"}.`;
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
        notificationIntentId,
      } = data || {};
      if (!raceId || !memberUserIds || memberUserIds.length === 0) return;

      const nowMs = Date.now();
      if (!domainEventProjection &&
          nowMs - (lastTeamLeadAlertAt.get(raceId) || 0) < TEAM_LEAD_COOLDOWN_MS) {
        return;
      }
      if (!domainEventProjection) lastTeamLeadAlertAt.set(raceId, nowMs);

      const body = `${leadingTeamName || "A team"} just took the lead over ${trailingTeamName || "the other team"} in ${raceName || "your race"}!`;
      for (const recipientUserId of memberUserIds) {
        await sendNotificationToUser({
          eventName: "TEAM_LEAD_CHANGED",
          recipientUserId,
          actorUserId: recipientUserId,
          title: "Team lead change!",
          buildBody: () => body,
          payload: {
            // NOT a typo, and NOT the event-bus name. Every shipped client's
            // route switch matches 'TEAM_LEAD_CHANGE' (no trailing D), so the
            // D-suffixed string we used to send fell through to the default
            // case and the push never deep-linked. Sending the D-less spelling
            // repairs deep-linking for 100% of deployed binaries on deploy,
            // with no App Store wait. The internal event name
            // (events.emit/on "TEAM_LEAD_CHANGED") is unchanged.
            type: "TEAM_LEAD_CHANGE",
            route: "race_detail",
            params: { raceId },
          },
          logContext: { raceId, recipientUserId },
          sourceId: notificationIntentId,
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
        notificationIntentId,
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
          !domainEventProjection &&
          nowMs - (lastTeamStretchAt.get(throttleKey) || 0) <
          TEAM_FINAL_STRETCH_MIN_INTERVAL_MS
        ) {
          continue;
        }
        if (!domainEventProjection) lastTeamStretchAt.set(throttleKey, nowMs);

        const recipientTeam = (memberTeams || {})[recipientUserId] || null;
        let body;
        if (leading == null) {
          body = `${timeLeft} left in ${raceName || "your race"} and it's dead even. Every step counts!`;
        } else if (recipientTeam === leading) {
          body = `${timeLeft} left. You're up ${diff.toLocaleString()}, hold the lead!`;
        } else {
          body = `${timeLeft} left. Your team is down ${diff.toLocaleString()} steps. Rally!`;
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
          sourceId: notificationIntentId,
        });
      }
    } catch (error) {
      logger.error("TEAM_FINAL_STRETCH handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // TR-683: gentle slacker nudge. The placementRecompute job enforces the
  // final-12h window and claims the once-per-race audit row before emitting.
  // This handler just delivers playful, never-shaming copy.
  events.on("TEAM_SLACKER_NUDGE", async (data) => {
    try {
      const {
        raceId,
        raceName,
        userId,
        teamName,
        notificationClaimed,
      } = data || {};
      if (!raceId || !userId) return;
      const claim = await claimCronNotification({
        userId,
        type: "TEAM_SLACKER_NUDGE",
        raceId,
        notificationClaimed,
      });
      if (!claim.send) return;
      await sendNotificationToUser({
        eventName: "TEAM_SLACKER_NUDGE",
        recipientUserId: userId,
        actorUserId: userId,
        title: "Your team believes in you!",
        buildBody: () =>
          `${teamName || "Your team"} could use a few more steps in ${raceName || "your race"} . Even a quick stroll helps. You've got this!`,
        payload: {
          type: "TEAM_SLACKER_NUDGE",
          route: "race_detail",
          params: { raceId },
        },
        logContext: { raceId, userId },
        skipAudit: claim.skipAudit,
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
          // Batch 2026-08-09 item 2: "with friends" is now load-bearing, not
          // flavour — a seeded daily/weekly no longer qualifies, so the payout
          // really did come from a race with other real people.
          `${friendName} finished their first race with friends. You earned ${coins} coins!`,
        payload: {
          type: "REFERRAL_REWARDED",
          route: "home",
        },
        logContext: { referrerId, refereeId, coins },
        sourceId: `${referrerId}:${refereeId}`,
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
          sourceId: raceId,
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
      const { eventId, entitlementId, multiplier, participantUserIds } = data || {};
      if (!participantUserIds || participantUserIds.length === 0) return;

      const mult = Number(multiplier) || 2;
      for (const recipientUserId of participantUserIds) {
        await sendNotificationToUser({
          eventName: "GLOBAL_EVENT_STARTED",
          recipientUserId,
          actorUserId: null,
          title: `${mult}x STEPS EVENT`,
          buildBody: () =>
            `Double steps are LIVE for 30 minutes. Every step counts ${mult}x in your races! Go!`,
          payload: {
            type: "GLOBAL_EVENT_STARTED",
            route: "home",
            eventId,
            multiplier: mult,
            ...(entitlementId ? { entitlementId } : {}),
          },
          logContext: { multiplier: mult, recipientUserId },
          sourceId: eventId,
        });
      }
    } catch (error) {
      logger.error("GLOBAL_EVENT_STARTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Durations are computed from the same ladder that stamps the effect row
  // (§3.4 standardization: 1/2/3/4h by upgrade level), so the push can never
  // drift from what the effect actually does again. upgradeLevel rides on the
  // POWERUP_USED emit; a missing/invalid level falls back to base.
  // Batch 2026-08-09 item 1: the string itself now comes from the ONE shared
  // formatter (powerupUpgrades.formatDuration), which the race feed also uses.
  // This function used to own a second, different implementation whose
  // non-integer branch rendered the new 1h15m ladder as "75 minutes" — so the
  // push and the feed line about the same cast disagreed. Only the
  // level-lookup-with-fallback belongs here now.
  function attackWindowText(type, upgradeLevel) {
    let ms;
    try {
      ms = upgradedDuration(type, upgradeLevel || 0);
    } catch {
      ms = upgradedDuration(type, 0);
    }
    return formatDuration(ms);
  }

  const POWERUP_ATTACK_MESSAGES = {
    LEG_CRAMP: (attackerName, upgradeLevel) =>
      `${attackerName} used Leg Cramp on you! Your steps are frozen for ${attackWindowText("LEG_CRAMP", upgradeLevel)}.`,
    RED_CARD: (attackerName) => `${attackerName} used Red Card! You lost steps.`,
    SHORTCUT: (attackerName) => `${attackerName} stole steps from you with Shortcut!`,
    WRONG_TURN: (attackerName, upgradeLevel) =>
      `${attackerName} sent you on a Wrong Turn! Your steps are reversed for ${attackWindowText("WRONG_TURN", upgradeLevel)}.`,
    SIGNAL_JAMMER: (attackerName) => `${attackerName} jammed your powerups for 1 hour! 📵`,
    // Leech is deliberately NOT stealthy — the victim is told who's draining them
    // so their steps dropping never becomes a "why?" mystery (Item 2).
    LEECH: (attackerName) => `🩸 ${attackerName} is leeching your steps! Keep moving.`,
    // §9.3 — GENERIC copy for EVERY recipient build. Device tokens don't carry
    // per-build capabilities and User.clientFeatures is a sticky union across all
    // of a user's devices, so the server cannot safely pick version-specific
    // wording per token. The powerup's NAME is therefore never interpolated: a
    // frozen binary can't render the type, and naming it would be the one thing
    // that turns an unexplained score change into an incomprehensible one.
    HITCHHIKE: (attackerName) =>
      `🎒 ${attackerName} linked to your steps! Whatever you walk, they copy. You keep every step.`,
    // §3.4: Quicksand standardizes to a 1h freeze window (was 2h); it is never
    // upgradeable, so the window is fixed.
    QUICKSAND: (attackerName) => `${attackerName} froze your steps for 1 hour!`,
  };

  events.on("POWERUP_USED", async (data) => {
    try {
      const { raceId, userId, powerupType, targetUserId, upgradeLevel, notificationIntentId } = data;
      // Batch 2026-08-09 item 11. The in-app feed, race messages and the
      // leaderboard have always redacted a stealthed attacker to "???"; this
      // push did not, so Stealth Mode leaked the one thing it sells.
      //
      // DEFAULT FALSE IS DELIBERATE and is the safe side: an emit site that
      // forgets to thread `stealthed` shows the real name (today's behavior),
      // never a silent anonymization. Anonymizing by accident would be a
      // GAMEPLAY change — victims would stop learning who is attacking them —
      // whereas failing to anonymize is the status quo bug, caught by tests.
      const stealthed = data?.stealthed === true;
      // B2: after a Mirror reflect, usePowerup emits POWERUP_USED with
      // targetUserId === userId (both the original attacker). Suppress the
      // self-push here — one guard that covers every reflectable offensive type
      // and any future emit site. The in-race POWERUP_REFLECTED feed event
      // already tells both players what happened.
      if (!targetUserId || targetUserId === userId) return;
      if (!["LEG_CRAMP", "RED_CARD", "SHORTCUT", "WRONG_TURN", "SIGNAL_JAMMER", "LEECH", "HITCHHIKE", "QUICKSAND"].includes(powerupType)) return;

      // T9 safety net: suppress the attack push if the race is no longer live —
      // not ACTIVE, or already past endsAt (the expired-but-unsettled gap, where
      // status is still ACTIVE until raceExpiry settles it). usePowerup also gates
      // this at the source; this is best-effort, so on any lookup error we proceed
      // rather than drop a legitimate push.
      let raceForPush = null;
      try {
        const race = await raceModel.findUnique({
          where: { id: raceId },
          select: { status: true, endsAt: true, name: true },
        });
        raceForPush = race;
        if (race) {
          const ended =
            race.endsAt && Date.now() >= new Date(race.endsAt).getTime();
          if (race.status !== "ACTIVE" || ended) return;
        }
      } catch {}

      const baseBuildBody = POWERUP_ATTACK_MESSAGES[powerupType];
      const cleanRaceName = (value) => {
        if (typeof value !== "string") return null;
        const cleaned = [...value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, 60).join("");
        return cleaned || null;
      };
      const raceName = cleanRaceName(raceForPush?.name);
      // "???" is the feed convention (getRaceFeed / getRaceMessages /
      // raceIllusions), so a victim sees the same redaction in the push as in
      // the app. Powerup name and duration text are untouched: the victim still
      // learns WHAT hit them and for how long — only WHO is hidden.
      const buildBody = baseBuildBody && ((attackerName) => {
        const sentence = baseBuildBody(
          stealthed ? "???" : attackerName,
          upgradeLevel
        );
        return raceName ? `${sentence} Race: ${raceName}.` : sentence;
      });
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
        sourceId: notificationIntentId,
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
      const recipients = domainEventProjection
        ? (data.recipientUserIds || []).map((userId) => ({ userId }))
        : await raceParticipantModel.findMany({
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
        const onCooldown = !domainEventProjection &&
          lastPush &&
          now.getTime() - new Date(lastPush).getTime() < CHAT_PUSH_COOLDOWN_MS;

        const payload = {
          type: "race_message",
          route: "race_detail",
          params: { raceId },
          raceId,
          messageId,
          collapseId,
          threadId: collapseId,
        };

        // A chat alert that is not on its cooldown is user-visible. Persist it
        // before attempting any provider delivery; otherwise users without a
        // currently registered device lose both the alert and its deep link.
        if (!onCooldown) {
          const queued = await queueInboxDelivery({
            recipientUserId: recipient.userId,
            eventName: "RACE_MESSAGE_SENT",
            title: raceName || "Race chat",
            body: alertBody,
            payload,
            sourceId: messageId,
          });
          if (queued && !domainEventProjection) {
            try {
              await raceParticipantModel.update({
                where: { id: recipient.id }, data: { lastChatPushAt: now },
              });
            } catch (error) {
              logger.error("RACE_MESSAGE_SENT lastChatPushAt update failed", {
                raceId, recipientUserId: recipient.userId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (queued) await recordNotification({
            userId: recipient.userId, type: "race_message",
            title: raceName || "Race chat", body: alertBody, raceId,
          });
          if (!queued) logger.error("RACE_MESSAGE_SENT visible intent was not persisted", { raceId, recipientUserId: recipient.userId });
          continue;
        }

        await silentRefreshDelivery({
          recipientUserId: recipient.userId,
          payload,
          transportKey: `silent:RACE_MESSAGE_SENT:${messageId}:${recipient.userId}`,
        });

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

  // Batch 2026-08-10 item 3 — the payout-drop alert is only actionable near the
  // end of a race. At 7am on a daily challenge with 17h to go, totals churn off
  // tiny step counts as devices sync and "you're out of the prize places" is
  // pure noise. Read PER EVENT so the knob can be retuned with a pm2 restart
  // (no deploy) — the whole point of it being an env var.
  const DEFAULT_PAYOUT_DROP_WINDOW_HOURS = 3;
  function payoutDropWindowMs() {
    const hours = Number(process.env.PAYOUT_DROP_WINDOW_HOURS);
    const safe =
      Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_PAYOUT_DROP_WINDOW_HOURS;
    return safe * 60 * 60 * 1000;
  }

  // `endsAt` rides in on the emitted change (placementRecompute.js). NULL is
  // NOT "suppress": step-target races legitimately have no end instant and can
  // still carry a pot, so they keep today's timing (meaningful crossing +
  // cooldown) and gain only the once-per-race cap. A malformed value is treated
  // the same way — never silently mute a race forever.
  function withinPayoutDropWindow(endsAt, nowMs) {
    if (endsAt == null) return true;
    const endsAtMs = new Date(endsAt).getTime();
    if (!Number.isFinite(endsAtMs)) return true;
    return endsAtMs - nowMs <= payoutDropWindowMs();
  }

  // INSERT-FIRST durable claim for the once-per-(race,user) payout-drop cap.
  // Deliberately NOT recordNotification: that wrapper swallows every create
  // error by design, so a unique violation would be invisible and the push
  // would re-send on every 5-minute tick. Mirrors dailyRewardReminder.js's
  // claim. The row IS the audit row — the caller skips the trailing
  // recordNotification so exactly one row exists per sent alert.
  //
  // Returns true only when THIS process won the claim. P2002 = another tick /
  // cluster worker already sent it. Any other error is also treated as "don't
  // send": an unclaimable alert downgrades to the silent refresh rather than
  // becoming an un-capped every-10-minutes push, which is the spam this item
  // exists to kill. A claimed-but-unsent alert is an accepted permanent loss.
  async function claimPayoutDrop({ userId, raceId, title, body }) {
    try {
      await notificationModel.create({
        userId,
        type: "PLACEMENT_CHANGED",
        title,
        body,
        raceId,
        deliveryKey: `payout-drop:${raceId}:${userId}`,
      });
      return true;
    } catch (error) {
      if (error && error.code === "P2002") return false; // already sent
      logger.error("payout-drop claim failed", {
        raceId,
        recipientUserId: userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
  }

  events.on("PLACEMENT_CHANGED", async (data) => {
    const perfStartedAt = process.hrtime.bigint();
    let perfOutcome = "ignored";
    let perfTokenReads = 0;
    let perfPushAttempts = 0;
    let perfPushSuccesses = 0;
    let perfUnregistered = 0;
    let perfFailures = 0;
    try {
      const {
        raceId,
        raceName,
        userId,
        previousPlacement,
        placement,
        paidPlaces,
        endsAt,
        notificationIntentId,
      } = data || {};
      if (!userId || placement == null) return;

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
      // Pure visibility classification belongs before token lookup. A payout
      // cutoff crossing outside its configured time window is just as inert as
      // any mid-pack movement on every shipped client. took/lost-first remain
      // visible regardless of that window.
      const nowMs = Date.now();
      const payoutDropWithinWindow =
        droppedOutOfPaid &&
        !tookFirst &&
        withinPayoutDropWindow(endsAt, nowMs);
      if (
        getPerformanceFlags().placementInertPushSuppressionEnabled &&
        !tookFirst &&
        !lostFirst &&
        !payoutDropWithinWindow
      ) {
        perfOutcome = "skipped-inert";
        return;
      }

      // A visible alert fires only on a MEANINGFUL threshold crossing, not on
      // every one-spot slip (which, at a 5-min recompute cadence over a multi-day
      // race, was the source of the notification flood). The silent refresh below
      // still fires on every change for updated clients.
      // The payout-drop VARIANT is the one whose copy says "out of the payout"
      // — i.e. a drop out of the money that isn't also a take-1st. It alone is
      // time-gated and capped. Evaluation order is pinned (item 3): variant ->
      // time gate -> shared cooldown -> durable claim (last gate before send).
      //
      // A 1st -> out-of-the-money drop is BOTH lostFirst and droppedOutOfPaid.
      // Whenever the payout-drop variant is refused — by the time gate here, or
      // by the durable claim below — we fall back to the lost-lead alert rather
      // than swallowing it: this item promises tookFirst/lostFirst are
      // unchanged, and neither the window nor a spent claim has anything to say
      // about losing 1st place.
      let payoutDrop = payoutDropWithinWindow;

      const meaningful = tookFirst || lostFirst || payoutDrop;

      const cooldownKey = `${raceId}:${userId}`;
      let withinCooldown = false;
      const hasPersistedRaceCooldown =
        typeof notificationModel.findFirstByUserTypeRaceSince === "function";
      const hasLegacyPersistedCooldown =
        typeof notificationModel.findFirstByUserTypeSince === "function";
      if (meaningful && domainEventProjection) {
        withinCooldown = false;
      } else if (meaningful && hasPersistedRaceCooldown) {
        const recentAlert = await notificationModel.findFirstByUserTypeRaceSince(
          userId,
          "PLACEMENT_CHANGED",
          raceId,
          new Date(nowMs - PLACEMENT_ALERT_COOLDOWN_MS),
        );
        // Preserve the existing payout-cap behavior: when the only recent row
        // is the insert-first payout claim, a later transition that also loses
        // first may still downgrade to the ordinary lost-lead alert after the
        // payout claim loses. The durable payout row was never shared cooldown
        // state in the legacy multi-worker path.
        const isPayoutClaimOnly =
          recentAlert?.deliveryKey === `payout-drop:${raceId}:${userId}`;
        withinCooldown = Boolean(recentAlert) &&
          !(lostFirst && payoutDrop && isPayoutClaimOnly);
      } else if (meaningful && hasLegacyPersistedCooldown) {
        // Compatibility for existing injected notification-model doubles.
        withinCooldown = Boolean(await notificationModel.findFirstByUserTypeSince(
          userId,
          "PLACEMENT_CHANGED",
          new Date(nowMs - PLACEMENT_ALERT_COOLDOWN_MS),
        ));
      } else {
        // Compatibility-only fallback for old narrow test doubles. Production
        // cooldown state is persisted in the notification audit table.
        withinCooldown = nowMs - (lastPlacementAlertAt.get(cooldownKey) || 0) <
          PLACEMENT_ALERT_COOLDOWN_MS;
      }
      let sendAlert = meaningful && !withinCooldown;

      const label = raceName || "your race";
      const lostLeadTitle = "You lost the lead";
      const lostLeadBody = `You slipped to ${ordinal(placement)} in ${label}.`;
      let title;
      let body;
      if (tookFirst) {
        title = "You're in the lead!";
        body = `You took 1st in ${label}.`;
      } else if (payoutDrop) {
        title = "Out of the payout";
        body = `You dropped to ${ordinal(placement)} in ${label}. You're out of the prize places.`;
      } else {
        // lostFirst
        title = lostLeadTitle;
        body = lostLeadBody;
      }

      // LAST gate before sending. Claiming any earlier (e.g. before the
      // cooldown check) would let an unrelated lostFirst alert three minutes
      // ago burn this user's one-and-only payout-drop claim on a push that
      // never went out.
      if (sendAlert && payoutDrop && !domainEventProjection) {
        const claimed = await claimPayoutDrop({ userId, raceId, title, body });
        if (!claimed) {
          // The payout-drop alert is spent for this race. Clearing the flag
          // (rather than just muting the send) is what re-arms the normal
          // audit write below for the downgraded alert.
          payoutDrop = false;
          if (lostFirst) {
            title = lostLeadTitle;
            body = lostLeadBody;
          } else {
            sendAlert = false;
          }
        }
      }

      // A SUPPRESSED alert must not stamp the shared Map, or the gate would
      // start silencing tookFirst/lostFirst too.
      if (sendAlert && !hasPersistedRaceCooldown && !hasLegacyPersistedCooldown) {
        lastPlacementAlertAt.set(cooldownKey, nowMs);
      }

      const payload = {
        type: "PLACEMENT_CHANGED",
        route: "race_detail",
        params: { raceId },
        placement,
        collapseId: `placement_${raceId}`,
      };

      // Visible placement changes use the shared durable intent path. Silent
      // refreshes remain immediate and are intentionally outside this workflow.
      if (sendAlert) {
        const queuedVisible = await queueInboxDelivery({
          recipientUserId: userId,
          eventName: "PLACEMENT_CHANGED",
          title,
          body,
          payload,
          sourceId: payoutDrop
            ? `payout-drop:${raceId}:${userId}`
            : notificationIntentId,
        });
        if (compatibilityProviderFallback) {
          perfTokenReads += 1;
          if (queuedVisible) {
            perfPushAttempts += 1;
            perfPushSuccesses += 1;
          }
        }
        if (queuedVisible && (!payoutDrop || domainEventProjection)) {
          await recordNotification({ userId, type: "PLACEMENT_CHANGED", title, body, raceId });
        }
        perfOutcome = queuedVisible
          ? (compatibilityProviderFallback ? "alert-sent" : "alert-queued")
          : "intent-failed";
      } else {
        perfTokenReads += 1;
        perfPushAttempts += 1;
        const outcome = await silentRefreshDelivery({
          recipientUserId: userId,
          payload,
          transportKey: `silent:PLACEMENT_CHANGED:${notificationIntentId}:${userId}`,
        });
        perfPushSuccesses += outcome.accepted || 0;
        perfUnregistered += outcome.unregistered || 0;
        perfOutcome = outcome.outcome === "NO_DEVICE_TOKEN" ? "no-tokens" : "silent-sent";
      }
    } catch (error) {
      perfOutcome = "handler-error";
      logger.error("PLACEMENT_CHANGED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      logger.log?.("[PERF] placement notification", {
        outcome: perfOutcome,
        tokenReads: perfTokenReads,
        pushAttempts: perfPushAttempts,
        pushSuccesses: perfPushSuccesses,
        unregisteredTokens: perfUnregistered,
        failedPushes: perfFailures,
        durationMs:
          Number(process.hrtime.bigint() - perfStartedAt) / 1e6,
      });
    }
  });

  // §6b — HIGH_MULTIPLIER_ALERT. When a racer's stacked (event-inclusive)
  // multiplier crosses above the threshold, the evaluator emits ONE event
  // carrying every OTHER active racer as a recipient. We send each a visible
  // alert. Title/body are always populated so ANY app version renders it; the
  // deep-link route is a no-op on clients that don't know the type (their
  // _routeFromType returns null), exactly like PLACEMENT_CHANGED.
  events.on("HIGH_MULTIPLIER_ALERT", async (data) => {
    try {
      const {
        raceId,
        raceName,
        actorUserId,
        actorName,
        multiplier,
        recipientUserIds,
        notificationIntentId,
      } = data || {};
      if (!Array.isArray(recipientUserIds) || recipientUserIds.length === 0) return;
      if (!notificationIntentId) {
        logger.error("HIGH_MULTIPLIER_ALERT missing durable crossing intent id", {
          raceId,
          actorUserId,
        });
        return;
      }

      // The SECOND leak (batch 2026-08-09 item 11, architect REQUIRED). This
      // push names the actor to every rival, so a stealthed player who
      // self-buffs into a high multiplier announced themselves — arguably worse
      // than the attack push, since stacking a multiplier is exactly what a
      // stealthed player is hiding. Same fail-safe default as above.
      const stealthed = data?.stealthed === true;
      const name = stealthed
        ? "???"
        : actorName || (await findActorName(actorUserId));
      const mult = Number.isFinite(Number(multiplier)) ? Number(multiplier) : null;
      const title = "🔥 Someone's heating up";
      const body =
        `${name}'s multiplier is stacked at ${mult != null ? `${mult}x` : "a high multiplier"}` +
        `. Slow them down or catch up!`;
      const payload = {
        type: "HIGH_MULTIPLIER_ALERT",
        route: "race_detail",
        params: { raceId },
        multiplier: mult,
        collapseId: `himult_${String(raceId).slice(0, 8)}_${String(actorUserId).slice(0, 8)}`,
      };

      // Once-per-day recipient cap: at most ONE of these pushes per rolling
      // 24h per recipient, across ALL races and actors — whichever spike
      // happens first that day wins. Keyed off the recorded notification row
      // (written only when we actually notify), so it holds across pm2
      // cluster workers. Capped recipients skip the record too, or the
      // in-app notification list would still spam.
      const capCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

      for (const recipientUserId of recipientUserIds) {
        if (!recipientUserId || recipientUserId === actorUserId) continue;
        const recentAlert = await notificationModel.findFirstByUserTypeSince(
          recipientUserId,
          "HIGH_MULTIPLIER_ALERT",
          capCutoff
        );
        if (recentAlert) continue;
        const deliverySourceId = data?.recipientDeliverySourceIds?.[recipientUserId] ||
          notificationIntentId;
        const deliveryKey = canonicalPushDeliveryKey(
          "HIGH_MULTIPLIER_ALERT",
          recipientUserId,
          deliverySourceId,
        );
        const queued = await queueInboxDelivery({
          recipientUserId,
          eventName: "HIGH_MULTIPLIER_ALERT",
          title,
          body,
          payload,
          sourceId: deliverySourceId,
        });
        if (queued) {
          await recordNotification({
            userId: recipientUserId,
            type: "HIGH_MULTIPLIER_ALERT",
            title,
            body,
            raceId,
            deliveryKey,
          });
        }
        if (!queued) logger.error("HIGH_MULTIPLIER_ALERT visible intent was not persisted", { raceId, recipientUserId });
      }
    } catch (error) {
      logger.error("HIGH_MULTIPLIER_ALERT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ── Tournament (bracket) pushes (§8) ──────────────────────────────────────
  // All additive TOURNAMENT_* types. Old apps show the alert and no-op the deep
  // link (their route resolver returns null for unknown types). Each event is
  // already per-recipient (carries `userId`), so the handler sends to one user.

  events.on("TOURNAMENT_INVITE_SENT", async (data) => {
    try {
      const { tournamentId, tournamentName, creatorUserId, userId, bracketSize, potCoins } =
        data || {};
      if (!userId) return;
      const prize =
        potCoins && potCoins > 0
          ? `winner takes ${potCoins}!`
          : "winner takes the crown!";
      await sendNotificationToUser({
        eventName: "TOURNAMENT_INVITE_SENT",
        recipientUserId: userId,
        actorUserId: creatorUserId,
        title: "Tournament invite",
        buildBody: (creatorName) =>
          `${creatorName} invited you to ${tournamentName}. ${bracketSize} racers, ${prize}`,
        payload: {
          type: "TOURNAMENT_INVITE_SENT",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_INVITE_SENT handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_STARTED", async (data) => {
    try {
      const { tournamentId, userId, raceId, opponentName, days } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_STARTED",
        recipientUserId: userId,
        actorUserId: null,
        title: "The bracket is set!",
        buildBody: () =>
          `Round 1: you vs ${opponentName}. ${days}d. Go!`,
        payload: {
          type: "TOURNAMENT_STARTED",
          route: "race_detail",
          params: { raceId, tournamentId },
        },
        logContext: { tournamentId, userId, raceId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_STARTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_ROUND_STARTED", async (data) => {
    try {
      const { tournamentId, userId, raceId, label, opponentName, days } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_ROUND_STARTED",
        recipientUserId: userId,
        actorUserId: null,
        title: `${label}!`,
        buildBody: () => `You drew ${opponentName}. ${days}d on the clock.`,
        payload: {
          type: "TOURNAMENT_ROUND_STARTED",
          route: "race_detail",
          params: { raceId, tournamentId },
        },
        logContext: { tournamentId, userId, raceId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_ROUND_STARTED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_MATCHUP_WON", async (data) => {
    try {
      const { tournamentId, userId, nextLabel } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_MATCHUP_WON",
        recipientUserId: userId,
        actorUserId: null,
        title: "You won your matchup!",
        buildBody: () => `${nextLabel} is next.`,
        payload: {
          type: "TOURNAMENT_MATCHUP_WON",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_MATCHUP_WON handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_ELIMINATED", async (data) => {
    try {
      const { tournamentId, userId, label, opponentName } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_ELIMINATED",
        recipientUserId: userId,
        actorUserId: null,
        title: "Knocked out",
        buildBody: () =>
          `Knocked out in the ${label} by ${opponentName}. Follow the bracket to the end!`,
        payload: {
          type: "TOURNAMENT_ELIMINATED",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_ELIMINATED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_CHAMPION", async (data) => {
    try {
      const { tournamentId, tournamentName, userId, prizeCoins } = data || {};
      if (!userId) return;
      const tail =
        prizeCoins && prizeCoins > 0
          ? `and won ${prizeCoins} coins!`
          : "and took the crown!";
      await sendNotificationToUser({
        eventName: "TOURNAMENT_CHAMPION",
        recipientUserId: userId,
        actorUserId: null,
        title: "CHAMPION!",
        buildBody: () => `You swept ${tournamentName} ${tail}`,
        payload: {
          type: "TOURNAMENT_CHAMPION",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_CHAMPION handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_COMPLETED", async (data) => {
    try {
      const { tournamentId, tournamentName, userId, championName } = data || {};
      if (!userId) return;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_COMPLETED",
        recipientUserId: userId,
        actorUserId: null,
        title: "Tournament over",
        buildBody: () => `${championName} took the crown in ${tournamentName}.`,
        payload: {
          type: "TOURNAMENT_COMPLETED",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_COMPLETED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  events.on("TOURNAMENT_CANCELLED", async (data) => {
    try {
      const { tournamentId, tournamentName, userId, buyInAmount } = data || {};
      if (!userId) return;
      const body =
        buyInAmount && buyInAmount > 0
          ? `${tournamentName} was called off. Your ${buyInAmount} coins are back.`
          : `${tournamentName} was called off.`;
      await sendNotificationToUser({
        eventName: "TOURNAMENT_CANCELLED",
        recipientUserId: userId,
        actorUserId: null,
        title: "Tournament cancelled",
        buildBody: () => body,
        payload: {
          type: "TOURNAMENT_CANCELLED",
          route: "tournament_detail",
          params: { tournamentId },
        },
        logContext: { tournamentId, userId },
      });
    } catch (error) {
      logger.error("TOURNAMENT_CANCELLED handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Daily biggest-mover digest (dailyMover job @4pm ET). One visible push for the
  // race a user moved the most in over the last 24h; copy adapts to up vs down.
  events.on("DAILY_MOVER", async (data) => {
    try {
      const { userId, raceId, raceName, movement, placement, notificationIntentId } = data || {};
      if (!userId || !movement || placement == null) return;

      const label = raceName || "your race";
      const spots = Math.abs(movement);
      const climbed = movement > 0;
      const title = climbed ? "You're climbing!" : "You slipped";
      const body = climbed
        ? `You moved up ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today. Now ${ordinal(placement)}.`
        : `You dropped ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today. Now ${ordinal(placement)}.`;

      const payload = {
        type: "DAILY_MOVER",
        route: "race_detail",
        params: { raceId },
        placement,
        collapseId: `daily_mover_${raceId}`,
      };

      const queued = await queueInboxDelivery({
        recipientUserId: userId,
        eventName: "DAILY_MOVER",
        title,
        body,
        payload,
        sourceId: notificationIntentId || `${raceId}:${new Date().toISOString().slice(0, 10)}`,
      });
      if (queued) {
        await recordNotification({ userId, type: "DAILY_MOVER", title, body, raceId });
      }
      if (!queued) logger.error("DAILY_MOVER visible intent was not persisted", { raceId, recipientUserId: userId });
    } catch (error) {
      logger.error("DAILY_MOVER handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

}

module.exports = { registerNotificationHandlers };
