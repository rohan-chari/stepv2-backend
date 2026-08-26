const { prisma: defaultPrisma } = require("../../../db");
const {
  notificationIntentService: defaultNotificationIntentService,
} = require("./notificationDelivery");
const {
  upgradedDuration,
  formatDuration,
} = require("../../powerups/powerupUpgrades");

const V1_PROJECTOR_HANDLER_NAMES = Object.freeze({
  FRIEND_REQUEST_SENT_V1: "FRIEND_REQUEST_SENT",
  FRIEND_REQUEST_ACCEPTED_V1: "FRIEND_REQUEST_ACCEPTED",
  RACE_INVITE_SENT_V1: "RACE_INVITE_SENT",
  RACE_INVITE_ACCEPTED_V1: "RACE_INVITE_ACCEPTED",
  RACE_BUYIN_CHANGED_V1: "RACE_BUYIN_CHANGED",
  RACE_SCHEDULED_TEAMS_UNEVEN_V1: "RACE_SCHEDULED_TEAMS_UNEVEN",
  RACE_STARTED_V1: "RACE_STARTED",
  RACE_ENDING_SOON_V1: "RACE_ENDING_SOON",
  DAILY_REWARD_REMINDER_V1: "DAILY_REWARD_REMINDER",
  STEP_MILESTONE_REMINDER_V1: "STEP_MILESTONE_REMINDER",
  RACE_COMPLETED_V1: "RACE_COMPLETED",
  TEAM_LEAD_CHANGED_V1: "TEAM_LEAD_CHANGED",
  TEAM_FINAL_STRETCH_V1: "TEAM_FINAL_STRETCH",
  TEAM_SLACKER_NUDGE_V1: "TEAM_SLACKER_NUDGE",
  REFERRAL_REWARDED_V1: "REFERRAL_REWARDED",
  RACE_CANCELLED_V1: "RACE_CANCELLED",
  GLOBAL_STEP_EVENT_ACTIVATED_V1: "GLOBAL_EVENT_STARTED",
  POWERUP_USED_V1: "POWERUP_USED",
  RACE_MESSAGE_SENT_V1: "RACE_MESSAGE_SENT",
  PLACEMENT_CHANGED_V1: "PLACEMENT_CHANGED",
  HIGH_MULTIPLIER_ALERT_V1: "HIGH_MULTIPLIER_ALERT",
  TOURNAMENT_INVITE_SENT_V1: "TOURNAMENT_INVITE_SENT",
  TOURNAMENT_STARTED_V1: "TOURNAMENT_STARTED",
  TOURNAMENT_ROUND_STARTED_V1: "TOURNAMENT_ROUND_STARTED",
  TOURNAMENT_MATCHUP_WON_V1: "TOURNAMENT_MATCHUP_WON",
  TOURNAMENT_ELIMINATED_V1: "TOURNAMENT_ELIMINATED",
  TOURNAMENT_CHAMPION_V1: "TOURNAMENT_CHAMPION",
  TOURNAMENT_COMPLETED_V1: "TOURNAMENT_COMPLETED",
  TOURNAMENT_CANCELLED_V1: "TOURNAMENT_CANCELLED",
  DAILY_MOVER_V1: "DAILY_MOVER",
});

function ordinal(value) {
  const suffixes = ["th", "st", "nd", "rd"];
  const remainder = value % 100;
  return `${value}${suffixes[(remainder - 20) % 10] || suffixes[remainder] || suffixes[0]}`;
}

function timeLeft(endsAt, current) {
  const remaining = new Date(endsAt).getTime() - current.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return "Almost no time";
  const hours = Math.floor(remaining / (60 * 60_000));
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.round(remaining / 60_000))}m`;
}

function attackWindowText(type, upgradeLevel) {
  try {
    return formatDuration(upgradedDuration(type, upgradeLevel || 0));
  } catch {
    return formatDuration(upgradedDuration(type, 0));
  }
}

const POWERUP_ATTACK_MESSAGES = Object.freeze({
  LEG_CRAMP: (name, level) =>
    `${name} used Leg Cramp on you! Your steps are frozen for ${attackWindowText("LEG_CRAMP", level)}.`,
  RED_CARD: (name) => `${name} used Red Card! You lost steps.`,
  SHORTCUT: (name) => `${name} stole steps from you with Shortcut!`,
  WRONG_TURN: (name, level) =>
    `${name} sent you on a Wrong Turn! Your steps are reversed for ${attackWindowText("WRONG_TURN", level)}.`,
  SIGNAL_JAMMER: (name) => `${name} jammed your powerups for 1 hour! 📵`,
  LEECH: (name) => `🩸 ${name} is leeching your steps! Keep moving.`,
  HITCHHIKE: (name) =>
    `🎒 ${name} linked to your steps! Whatever you walk, they copy. You keep every step.`,
  QUICKSAND: (name) => `${name} froze your steps for 1 hour!`,
});

function intent(type, title, body, payload, { audit = true } = {}) {
  return { type, title, body, payload, audit };
}

function projectionHandler(eventType) {
  const handler = V1_PROJECTOR_HANDLERS[eventType];
  if (!handler) {
    const error = new Error(`event ${eventType} has no typed V1 projection handler`);
    error.code = "MISSING_TYPED_V1_HANDLER";
    throw error;
  }
  return handler;
}

const V1_PROJECTOR_HANDLERS = Object.freeze({
  async FRIEND_REQUEST_SENT_V1({ p, actorName }) {
    return intent("FRIEND_REQUEST_SENT", "New Friend Request",
      `${await actorName(p.requesterId)} sent you a friend request`,
      { type: "FRIEND_REQUEST_SENT", route: "friends" });
  },
  async FRIEND_REQUEST_ACCEPTED_V1({ p, actorName }) {
    return intent("FRIEND_REQUEST_ACCEPTED", "Friend Request Accepted",
      `${await actorName(p.accepterId)} accepted your friend request`,
      { type: "FRIEND_REQUEST_ACCEPTED", route: "friends" });
  },
  async RACE_INVITE_SENT_V1({ p, actorName }) {
    return intent("RACE_INVITE_SENT", "Race Invite",
      `${await actorName(p.creatorUserId)} invited you to a race: ${p.raceName}`,
      { type: "RACE_INVITE_SENT", route: "race_detail", params: { raceId: p.raceId } });
  },
  async RACE_INVITE_ACCEPTED_V1({ p, actorName }) {
    return intent("RACE_INVITE_ACCEPTED", "Race Update",
      `${await actorName(p.userId)} joined your race: ${p.raceName}`,
      { type: "RACE_INVITE_ACCEPTED", route: "race_detail", params: { raceId: p.raceId } });
  },
  async RACE_BUYIN_CHANGED_V1({ p }) {
    const label = p.raceName ? `${p.raceName}'s` : "The race's";
    const body = p.newBuyIn > 0
      ? `${label} buy-in is now ${p.newBuyIn} coins.`
      : `${label} buy-in is now free.`;
    return intent("RACE_BUYIN_CHANGED", "Buy-in updated", body,
      { type: "RACE_BUYIN_CHANGED", route: "race_detail", params: { raceId: p.raceId } });
  },
  async RACE_SCHEDULED_TEAMS_UNEVEN_V1({ p }) {
    return intent("TEAM_RACE_SCHEDULED_UNEVEN", "Teams are uneven",
      "Your race couldn't start. Teams are uneven. Even them up and it'll start on the next check!",
      { type: "TEAM_RACE_SCHEDULED_UNEVEN", route: "race_detail", params: { raceId: p.raceId } },
      { audit: false });
  },
  async RACE_STARTED_V1({ p, recipientUserId }) {
    if (p.tournamentId || p.isSeededBucket === true || recipientUserId === p.creatorUserId) {
      return { suppressed: "HANDLER_INELIGIBLE" };
    }
    const body = p.isTeamRace && p.teamAName && p.teamBName
      ? `The team race "${p.raceName}" has started. ${p.teamAName} vs ${p.teamBName}. Go!`
      : `The race "${p.raceName}" has started! Go!`;
    return intent("RACE_STARTED", "Race Started", body,
      { type: "RACE_STARTED", route: "race_detail", params: { raceId: p.raceId } });
  },
  async RACE_ENDING_SOON_V1({ p, copyAt }) {
    const remaining = new Date(p.endsAt).getTime() - copyAt.getTime();
    const hours = Math.max(1, Math.round(remaining / (60 * 60_000)));
    return intent("RACE_ENDING_SOON", "Race ending soon",
      `${p.raceName || "Your race"} ends in about ${hours === 1 ? "1 hour" : `${hours} hours`}. Time for a final push.`,
      { type: "RACE_ENDING_SOON", route: "race_detail", params: { raceId: p.raceId } },
      { audit: false });
  },
  async DAILY_REWARD_REMINDER_V1({ p }) {
    return intent(`DAILY_REWARD_REMINDER_${p.slot}`,
      p.title || "Your daily box is waiting",
      p.body || "Your mystery box has been sitting here all day. Awkward.",
      { type: `DAILY_REWARD_REMINDER_${p.slot}`, route: "daily_reward", params: {} },
      { audit: false });
  },
  async STEP_MILESTONE_REMINDER_V1({ p }) {
    return intent("STEP_MILESTONE_REMINDER", p.title || "Coins waiting! 🪙",
      p.body || "You crossed a step milestone today. Collect your coins before midnight.",
      { type: "STEP_MILESTONE_REMINDER", route: "home", params: {} },
      { audit: false });
  },
  async RACE_COMPLETED_V1({ p, audience, actorName }) {
    if (p.tournamentId) return { suppressed: "HANDLER_INELIGIBLE" };
    let body;
    if (p.tie === true) {
      body = "It's a tie. Buy-ins refunded.";
    } else if (p.winnerTeam != null) {
      const won = audience.facts?.memberTeam === p.winnerTeam;
      body = won
        ? `${p.winnerTeamName || "Your team"} win! Great racing.`
        : `${p.winnerTeamName || "The other team"} took it. Better luck next time, ${p.loserTeamName || "team"}.`;
    } else {
      body = `${await actorName(p.winnerUserId)} won the race!`;
    }
    return intent("RACE_COMPLETED", "Race Finished", body,
      { type: "RACE_COMPLETED", route: "race_detail", params: { raceId: p.raceId } });
  },
  async TEAM_LEAD_CHANGED_V1({ p }) {
    return intent("TEAM_LEAD_CHANGE", "Team lead change!",
      `${p.leadingTeamName || "A team"} just took the lead over ${p.trailingTeamName || "the other team"} in ${p.raceName || "your race"}!`,
      { type: "TEAM_LEAD_CHANGE", route: "race_detail", params: { raceId: p.raceId } });
  },
  async TEAM_FINAL_STRETCH_V1({ p, audience, copyAt }) {
    const difference = Math.abs((p.teamATotal || 0) - (p.teamBTotal || 0));
    const leading = p.teamATotal === p.teamBTotal
      ? null
      : p.teamATotal > p.teamBTotal ? "TEAM_A" : "TEAM_B";
    const left = timeLeft(p.endsAt, copyAt);
    const body = leading == null
      ? `${left} left in ${p.raceName || "your race"} and it's dead even. Every step counts!`
      : audience.facts?.memberTeam === leading
        ? `${left} left. You're up ${difference.toLocaleString()}, hold the lead!`
        : `${left} left. Your team is down ${difference.toLocaleString()} steps. Rally!`;
    return intent("TEAM_FINAL_STRETCH", "Final stretch!", body,
      { type: "TEAM_FINAL_STRETCH", route: "race_detail", params: { raceId: p.raceId } });
  },
  async TEAM_SLACKER_NUDGE_V1({ p }) {
    return intent("TEAM_SLACKER_NUDGE", "Your team believes in you!",
      `${p.teamName || "Your team"} could use a few more steps in ${p.raceName || "your race"} . Even a quick stroll helps. You've got this!`,
      { type: "TEAM_SLACKER_NUDGE", route: "race_detail", params: { raceId: p.raceId } },
      { audit: false });
  },
  async REFERRAL_REWARDED_V1({ p, actorName }) {
    return intent("REFERRAL_REWARDED", "You earned coins!",
      `${await actorName(p.refereeId)} finished their first race with friends. You earned ${p.coins} coins!`,
      { type: "REFERRAL_REWARDED", route: "home" });
  },
  async RACE_CANCELLED_V1({ p }) {
    return intent("RACE_CANCELLED", "Race Cancelled",
      `The race "${p.raceName}" was cancelled`,
      { type: "RACE_CANCELLED", route: "races" });
  },
  async GLOBAL_STEP_EVENT_ACTIVATED_V1({ p }) {
    const multiplier = Number(p.multiplier) || 2;
    return intent("GLOBAL_EVENT_STARTED", `${multiplier}x STEPS EVENT`,
      `Double steps are LIVE for 30 minutes. Every step counts ${multiplier}x in your races! Go!`,
      {
        type: "GLOBAL_EVENT_STARTED", route: "home", eventId: p.eventId, multiplier,
        ...(p.entitlementId ? { entitlementId: p.entitlementId } : {}),
      });
  },
  async POWERUP_USED_V1({ p, actorName, loadRace, current }) {
    if (!p.targetUserId || p.targetUserId === p.actorUserId || !POWERUP_ATTACK_MESSAGES[p.powerupType]) {
      return { suppressed: "HANDLER_INELIGIBLE" };
    }
    const race = await loadRace(p.raceId);
    if (race && (race.status !== "ACTIVE" || (race.endsAt && new Date(race.endsAt) <= current))) {
      return { suppressed: "RACE_NOT_ACTIVE" };
    }
    const name = p.stealthed === true ? "???" : await actorName(p.actorUserId);
    let body = POWERUP_ATTACK_MESSAGES[p.powerupType](name, p.upgradeLevel);
    const raceName = typeof race?.name === "string" ? race.name.trim().slice(0, 60) : "";
    if (raceName) body += ` Race: ${raceName}.`;
    return intent("POWERUP_USED", "Powerup Attack!", body,
      { type: "POWERUP_USED", route: "race_detail", params: { raceId: p.raceId } });
  },
  async RACE_MESSAGE_SENT_V1({ p }) {
    const preview = p.body?.length > 120 ? `${p.body.slice(0, 117)}…` : p.body;
    return intent("race_message", p.raceName || "Race chat",
      `${p.senderName || "Someone"}: ${preview}`,
      {
        type: "race_message", route: "race_detail", params: { raceId: p.raceId },
        raceId: p.raceId, messageId: p.messageId,
        collapseId: `race_chat_${p.raceId}`, threadId: `race_chat_${p.raceId}`,
      });
  },
  async PLACEMENT_CHANGED_V1({ p, projection }) {
    const tookFirst = p.placement === 1 && p.previousPlacement !== 1;
    const payoutDrop = projection.deliveryKey.includes(":payout-drop:");
    const title = tookFirst ? "You're in the lead!" : payoutDrop ? "Out of the payout" : "You lost the lead";
    const label = p.raceName || "your race";
    const body = tookFirst
      ? `You took 1st in ${label}.`
      : payoutDrop
        ? `You dropped to ${ordinal(p.placement)} in ${label}. You're out of the prize places.`
        : `You slipped to ${ordinal(p.placement)} in ${label}.`;
    return intent("PLACEMENT_CHANGED", title, body,
      {
        type: "PLACEMENT_CHANGED", route: "race_detail", params: { raceId: p.raceId },
        placement: p.placement, collapseId: `placement_${p.raceId}`,
      });
  },
  async HIGH_MULTIPLIER_ALERT_V1({ p }) {
    const name = p.stealthed === true ? "???" : p.actorName || "Someone";
    const multiplier = Number.isFinite(Number(p.multiplier)) ? Number(p.multiplier) : null;
    return intent("HIGH_MULTIPLIER_ALERT", "🔥 Someone's heating up",
      `${name}'s multiplier is stacked at ${multiplier == null ? "a high multiplier" : `${multiplier}x`}. Slow them down or catch up!`,
      {
        type: "HIGH_MULTIPLIER_ALERT", route: "race_detail", params: { raceId: p.raceId },
        multiplier,
        collapseId: `himult_${String(p.raceId).slice(0, 8)}_${String(p.actorUserId).slice(0, 8)}`,
      });
  },
  async TOURNAMENT_INVITE_SENT_V1({ p, actorName }) {
    const prize = p.potCoins > 0 ? `winner takes ${p.potCoins}!` : "winner takes the crown!";
    return intent("TOURNAMENT_INVITE_SENT", "Tournament invite",
      `${await actorName(p.creatorUserId)} invited you to ${p.tournamentName}. ${p.bracketSize} racers, ${prize}`,
      { type: "TOURNAMENT_INVITE_SENT", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_STARTED_V1({ p, audience }) {
    return intent("TOURNAMENT_STARTED", "The bracket is set!",
      `Round 1: you vs ${audience.facts?.opponentName ?? p.opponentName}. ${p.days}d. Go!`,
      { type: "TOURNAMENT_STARTED", route: "race_detail", params: { raceId: p.raceId, tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_ROUND_STARTED_V1({ p, audience }) {
    const label = audience.facts?.label ?? p.label;
    return intent("TOURNAMENT_ROUND_STARTED", `${label}!`,
      `You drew ${audience.facts?.opponentName ?? p.opponentName}. ${p.days}d on the clock.`,
      { type: "TOURNAMENT_ROUND_STARTED", route: "race_detail", params: { raceId: p.raceId, tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_MATCHUP_WON_V1({ p, audience }) {
    return intent("TOURNAMENT_MATCHUP_WON", "You won your matchup!",
      `${audience.facts?.nextLabel ?? p.nextLabel} is next.`,
      { type: "TOURNAMENT_MATCHUP_WON", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_ELIMINATED_V1({ p, audience }) {
    return intent("TOURNAMENT_ELIMINATED", "Knocked out",
      `Knocked out in the ${audience.facts?.label ?? p.label} by ${audience.facts?.opponentName ?? p.opponentName}. Follow the bracket to the end!`,
      { type: "TOURNAMENT_ELIMINATED", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_CHAMPION_V1({ p }) {
    const tail = p.prizeCoins > 0 ? `and won ${p.prizeCoins} coins!` : "and took the crown!";
    return intent("TOURNAMENT_CHAMPION", "CHAMPION!", `You swept ${p.tournamentName} ${tail}`,
      { type: "TOURNAMENT_CHAMPION", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_COMPLETED_V1({ p }) {
    return intent("TOURNAMENT_COMPLETED", "Tournament over",
      `${p.championName} took the crown in ${p.tournamentName}.`,
      { type: "TOURNAMENT_COMPLETED", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async TOURNAMENT_CANCELLED_V1({ p, audience }) {
    const buyIn = audience.facts?.buyInAmount ?? p.buyInAmount;
    const body = buyIn > 0
      ? `${p.tournamentName} was called off. Your ${buyIn} coins are back.`
      : `${p.tournamentName} was called off.`;
    return intent("TOURNAMENT_CANCELLED", "Tournament cancelled", body,
      { type: "TOURNAMENT_CANCELLED", route: "tournament_detail", params: { tournamentId: p.tournamentId } });
  },
  async DAILY_MOVER_V1({ p }) {
    const spots = Math.abs(p.movement);
    const climbed = p.movement > 0;
    const label = p.raceName || "your race";
    const body = climbed
      ? `You moved up ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today. Now ${ordinal(p.placement)}.`
      : `You dropped ${spots} ${spots === 1 ? "spot" : "spots"} in ${label} today. Now ${ordinal(p.placement)}.`;
    return intent("DAILY_MOVER", climbed ? "You're climbing!" : "You slipped", body,
      {
        type: "DAILY_MOVER", route: "race_detail", params: { raceId: p.raceId },
        placement: p.placement, collapseId: `daily_mover_${p.raceId}`,
      });
  },
});

function buildTypedV1Projection(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const notificationService = dependencies.notificationIntentService || defaultNotificationIntentService;
  const userModel = dependencies.User || null;
  const raceModel = dependencies.Race || prisma.race;
  const notificationModel = dependencies.Notification || null;
  const now = dependencies.now || (() => new Date());

  async function actorName(userId) {
    if (!userId) return "Someone";
    try {
      const user = userModel?.findById
        ? await userModel.findById(userId)
        : await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
      return user?.displayName || "Someone";
    } catch {
      // Display-name decoration has always been best-effort. The durable Inbox
      // submit below remains the required infrastructure boundary and errors
      // from it propagate to projection retry.
      return "Someone";
    }
  }

  async function loadRace(raceId) {
    if (!raceId) return null;
    return raceModel.findUnique({
      where: { id: raceId },
      select: { status: true, endsAt: true, name: true },
    });
  }

  async function createAudit(result, recipientUserId, p, projection) {
    if (result.audit === false) return;
    const data = {
      userId: recipientUserId,
      type: result.type,
      title: result.title,
      body: result.body,
      raceId: result.payload?.params?.raceId || null,
      deliveryKey: `audit:${projection.deliveryKey}`,
    };
    if (notificationModel?.create) {
      try {
        await notificationModel.create(data);
      } catch (error) {
        if (error?.code !== "P2002") throw error;
      }
    } else if (prisma.notification) {
      await prisma.notification.upsert({
        where: { deliveryKey: data.deliveryKey },
        update: {},
        create: data,
      });
    }
  }

  return async function projectTypedV1({ event, audience, projection }) {
    const handler = projectionHandler(event.eventType);
    const current = now();
    const copyAt = event.occurredAt ? new Date(event.occurredAt) : current;
    const p = event.payload || {};
    let result;
    try {
      result = await handler({
        event, p, audience, recipientUserId: audience.recipientId,
        projection, current, copyAt, actorName, loadRace,
      });
    } catch (error) {
      if (!error.code) error.code = "TYPED_V1_HANDLER_FAILED";
      throw error;
    }
    if (result.suppressed) return { status: "SUPPRESSED", reason: result.suppressed };
    const availableAt = event.availableAt || event.occurredAt || current;
    const endsAt = p.endsAt ? new Date(p.endsAt) : null;
    await notificationService.submit({
      recipientUserId: audience.recipientId,
      type: result.type,
      title: result.title,
      body: result.body,
      payload: result.payload,
      deliveryKey: projection.deliveryKey,
      availableAt,
      ...(endsAt && endsAt > new Date(availableAt) ? { expiresAt: endsAt } : {}),
    });
    await createAudit(result, audience.recipientId, p, projection);
    return { status: "COMPLETED" };
  };
}

module.exports = {
  V1_PROJECTOR_HANDLER_NAMES,
  V1_PROJECTOR_HANDLERS,
  buildTypedV1Projection,
};
