const crypto = require("node:crypto");
const {
  canonicalPushDeliveryKey,
} = require("../../notifications/pushDeliveryAttribution");

const ROWS = [
  ["FRIEND_REQUEST_SENT_V1", "FRIEND_REQUEST_SENT", "social/commands/sendFriendRequest", "FRIENDSHIP"],
  ["FRIEND_REQUEST_ACCEPTED_V1", "FRIEND_REQUEST_ACCEPTED", "social/commands/sendFriendRequest", "FRIENDSHIP"],
  ["RACE_INVITE_SENT_V1", "RACE_INVITE_SENT", "races/commands/inviteToRace", "RACE"],
  ["RACE_INVITE_ACCEPTED_V1", "RACE_INVITE_ACCEPTED", "races/commands/respondToRaceInvite", "RACE"],
  ["RACE_BUYIN_CHANGED_V1", "RACE_BUYIN_CHANGED", null, "RACE", {
    producerStatus: "DORMANT_COMPATIBILITY_ONLY",
    durableSource: null,
  }],
  ["RACE_SCHEDULED_TEAMS_UNEVEN_V1", "RACE_SCHEDULED_TEAMS_UNEVEN", "races/jobs/autoStartScheduledRaces", "RACE"],
  ["RACE_STARTED_V1", "RACE_STARTED", "races/commands/startRace", "RACE"],
  ["RACE_ENDING_SOON_V1", "RACE_ENDING_SOON", "races/jobs/placementRecompute", "RACE"],
  // Producer retired in favor of UNCLAIMED_REWARD_REMINDER_V1. Keep this row
  // replay-only so durable events written by an older worker can still finish.
  ["DAILY_REWARD_REMINDER_V1", "DAILY_REWARD_REMINDER", null, "USER", {
    producerStatus: "DORMANT_COMPATIBILITY_ONLY",
    durableSource: null,
  }],
  ["UNCLAIMED_REWARD_REMINDER_V1", null, "notifications/dailyRewardReminder", "USER"],
  ["STEP_MILESTONE_REMINDER_V1", "STEP_MILESTONE_REMINDER", "notifications/stepMilestoneReminder", "USER"],
  ["RACE_COMPLETED_V1", "RACE_COMPLETED", "races/commands/completeRace", "RACE"],
  ["TEAM_LEAD_CHANGED_V1", "TEAM_LEAD_CHANGED", "races/jobs/racePlacementTransitionWorker", "RACE"],
  ["TEAM_FINAL_STRETCH_V1", "TEAM_FINAL_STRETCH", "races/jobs/placementRecompute", "RACE"],
  ["TEAM_SLACKER_NUDGE_V1", "TEAM_SLACKER_NUDGE", "races/jobs/placementRecompute", "RACE"],
  ["REFERRAL_REWARDED_V1", "REFERRAL_REWARDED", "races/commands/completeRace", "REFERRAL"],
  ["RACE_CANCELLED_V1", "RACE_CANCELLED", "races/commands/cancelRace", "RACE"],
  ["GLOBAL_STEP_EVENT_ACTIVATED_V1", "GLOBAL_EVENT_STARTED", "steps/global-event-boundary", "GLOBAL_STEP_EVENT"],
  ["GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1", null, "steps/global-event-entitlement", "GLOBAL_STEP_EVENT_ENTITLEMENT"],
  ["POWERUP_USED_V1", "POWERUP_USED", "powerups/commands/usePowerup", "POWERUP"],
  ["DECOY_CONSUMED_V1", "DECOY_CONSUMED", "powerups/commands/usePowerup", "POWERUP"],
  ["RACE_MESSAGE_SENT_V1", "RACE_MESSAGE_SENT", "social/commands/sendRaceMessage", "RACE_MESSAGE"],
  ["PLACEMENT_CHANGED_V1", "PLACEMENT_CHANGED", "races/jobs/racePlacementTransitionWorker", "RACE"],
  ["HIGH_MULTIPLIER_ALERT_V1", "HIGH_MULTIPLIER_ALERT", "races/services/raceResolutionDeliveryIntents", "RACE"],
  ["TOURNAMENT_INVITE_SENT_V1", "TOURNAMENT_INVITE_SENT", "tournaments/commands/inviteToTournament", "TOURNAMENT"],
  ["TOURNAMENT_STARTED_V1", "TOURNAMENT_STARTED", "tournaments/commands/startTournament", "TOURNAMENT"],
  ["TOURNAMENT_ROUND_STARTED_V1", "TOURNAMENT_ROUND_STARTED", "tournaments/commands/advanceTournament", "TOURNAMENT"],
  ["TOURNAMENT_MATCHUP_WON_V1", "TOURNAMENT_MATCHUP_WON", "tournaments/commands/advanceTournament", "TOURNAMENT"],
  ["TOURNAMENT_ELIMINATED_V1", "TOURNAMENT_ELIMINATED", "tournaments/commands/advanceTournament", "TOURNAMENT"],
  ["TOURNAMENT_CHAMPION_V1", "TOURNAMENT_CHAMPION", "tournaments/commands/advanceTournament", "TOURNAMENT"],
  ["TOURNAMENT_COMPLETED_V1", "TOURNAMENT_COMPLETED", null, "TOURNAMENT", {
    producerStatus: "DORMANT_COMPATIBILITY_ONLY",
    durableSource: null,
  }],
  ["TOURNAMENT_CANCELLED_V1", "TOURNAMENT_CANCELLED", "tournaments/commands/cancelTournament", "TOURNAMENT"],
  ["DAILY_MOVER_V1", "DAILY_MOVER", "notifications/dailyMover", "USER"],
  ["SUPPORT_REPLY_CREATED_V1", null, "feedback/commands/sendStaffReply", "FEEDBACK_THREAD"],
].map(([eventType, legacyHandler, owner, aggregateType, options = {}]) => ({
  eventType,
  schemaVersion: 1,
  legacyHandler,
  owner,
  aggregateType,
  producerStatus: options.producerStatus || "ACTIVE",
  durableSource: Object.hasOwn(options, "durableSource")
    ? options.durableSource
    : "DomainEventOutbox",
  projectionKinds: ["VISIBLE", ...(eventType === "RACE_MESSAGE_SENT_V1" || eventType === "PLACEMENT_CHANGED_V1" ? ["SILENT_REFRESH"] : [])],
}));

const PRODUCER_MATRIX = Object.freeze(Object.fromEntries(ROWS.map((row) => [row.eventType, Object.freeze(row)])));
const EVENT_TYPES = Object.freeze(Object.keys(PRODUCER_MATRIX));

function highMultiplierSource(payload, recipientUserId) {
  const source = `race-resolution:${payload.raceId}:${payload.sourceGeneration}:${payload.actorUserId}:${recipientUserId}`;
  const secret = process.env.SESSION_TOKEN_SECRET;
  if (!secret) throw new Error("SESSION_TOKEN_SECRET is required for high-multiplier delivery keys");
  return crypto.createHmac("sha256", secret).update(source).digest("hex");
}

function publicTypeAndSource(event, audience) {
  const p = event.payload || {};
  const userId = audience.recipientId;
  switch (event.eventType) {
    case "FRIEND_REQUEST_SENT_V1": return ["FRIEND_REQUEST_SENT", `${p.requesterId}:${p.addresseeId}`];
    case "FRIEND_REQUEST_ACCEPTED_V1": return ["FRIEND_REQUEST_ACCEPTED", p.friendshipId || `${p.requesterId}:${p.accepterId}`];
    case "RACE_INVITE_SENT_V1": return ["RACE_INVITE_SENT", p.raceId];
    case "RACE_INVITE_ACCEPTED_V1": return ["RACE_INVITE_ACCEPTED", p.raceId];
    case "RACE_BUYIN_CHANGED_V1": return ["RACE_BUYIN_CHANGED", `race-buyin:${p.changeId}`];
    case "RACE_SCHEDULED_TEAMS_UNEVEN_V1": return ["TEAM_RACE_SCHEDULED_UNEVEN", p.raceId];
    case "RACE_STARTED_V1": return ["RACE_STARTED", p.raceId];
    case "RACE_ENDING_SOON_V1": return ["RACE_ENDING_SOON", p.raceId];
    case "DAILY_REWARD_REMINDER_V1": return [`DAILY_REWARD_REMINDER_${p.slot}`, `${p.userId}:${p.localDate}:${p.slot}`];
    case "UNCLAIMED_REWARD_REMINDER_V1": return ["UNCLAIMED_REWARD", `${p.userId}:${p.localDate}`];
    case "STEP_MILESTONE_REMINDER_V1": return ["STEP_MILESTONE_REMINDER", `${p.userId}:${p.localDate}`];
    case "RACE_COMPLETED_V1": return ["RACE_COMPLETED", p.raceId];
    case "TEAM_LEAD_CHANGED_V1": return ["TEAM_LEAD_CHANGE", p.transitionId];
    case "TEAM_FINAL_STRETCH_V1": return ["TEAM_FINAL_STRETCH", p.transitionId];
    case "TEAM_SLACKER_NUDGE_V1": return ["TEAM_SLACKER_NUDGE", p.raceId];
    case "REFERRAL_REWARDED_V1": return ["REFERRAL_REWARDED", `${p.referrerId}:${p.refereeId}`];
    case "RACE_CANCELLED_V1": return ["RACE_CANCELLED", p.raceId];
    case "GLOBAL_STEP_EVENT_ACTIVATED_V1": return ["GLOBAL_EVENT_STARTED", p.eventId];
    case "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1": return ["GLOBAL_EVENT_STARTED", p.eventId];
    case "POWERUP_USED_V1": return ["POWERUP_USED", p.notificationIntentId || `powerup:${p.powerupId}${p.targetUserId ? `:${p.targetUserId}` : ""}`];
    case "DECOY_CONSUMED_V1": return ["POWERUP_USED", `decoy-consumed:${p.decoyEffectId}`];
    case "RACE_MESSAGE_SENT_V1": return ["race_message", p.messageId];
    case "PLACEMENT_CHANGED_V1": return ["PLACEMENT_CHANGED", audience.facts?.payoutDrop === true ? `payout-drop:${p.raceId}:${userId}` : p.transitionId];
    case "HIGH_MULTIPLIER_ALERT_V1": return ["HIGH_MULTIPLIER_ALERT", highMultiplierSource(p, userId)];
    case "TOURNAMENT_INVITE_SENT_V1": return ["TOURNAMENT_INVITE_SENT", p.tournamentId];
    case "TOURNAMENT_STARTED_V1": return ["TOURNAMENT_STARTED", p.raceId];
    case "TOURNAMENT_ROUND_STARTED_V1": return ["TOURNAMENT_ROUND_STARTED", p.raceId];
    case "TOURNAMENT_MATCHUP_WON_V1": return ["TOURNAMENT_MATCHUP_WON", p.tournamentId];
    case "TOURNAMENT_ELIMINATED_V1": return ["TOURNAMENT_ELIMINATED", p.tournamentId];
    case "TOURNAMENT_CHAMPION_V1": return ["TOURNAMENT_CHAMPION", p.tournamentId];
    case "TOURNAMENT_COMPLETED_V1": return ["TOURNAMENT_COMPLETED", p.tournamentId];
    case "TOURNAMENT_CANCELLED_V1": return ["TOURNAMENT_CANCELLED", p.tournamentId];
    case "DAILY_MOVER_V1": return ["DAILY_MOVER", p.digestId];
    case "SUPPORT_REPLY_CREATED_V1": return ["SUPPORT_REPLY", p.messageId];
    default: throw Object.assign(new Error(`unknown domain event ${event.eventType}`), { code: "UNKNOWN_DOMAIN_EVENT" });
  }
}

function deliveryKeyFor(event, audience, projectionKind = "VISIBLE") {
  const recipient = audience.recipientId;
  if (projectionKind === "SILENT_REFRESH") {
    if (event.eventType === "RACE_MESSAGE_SENT_V1") {
      return `silent:RACE_MESSAGE_SENT:${event.payload.messageId}:${recipient}`;
    }
    if (event.eventType === "PLACEMENT_CHANGED_V1") {
      return `silent:PLACEMENT_CHANGED:${event.payload.transitionId}:${recipient}`;
    }
    throw new Error(`silent projection is not supported for ${event.eventType}`);
  }
  if (event.eventType === "SUPPORT_REPLY_CREATED_V1") return `support-reply:${event.payload.messageId}`;
  const [publicType, source] = publicTypeAndSource(event, audience);
  return canonicalPushDeliveryKey(publicType, recipient, source);
}

function projectionKindFor(event, audience) {
  // The final kind is classified and durably stored by notification projection.
  // Producer facts are intentionally ignored: replay routes only from the
  // immutable DomainEventNotificationProjection.projectionKind.
  return "VISIBLE";
}

function legacyPayloadForRecipient(event, audience) {
  const p = { ...(event.payload || {}) };
  const recipient = audience.recipientId;
  const facts = audience.facts || {};
  switch (event.eventType) {
    case "FRIEND_REQUEST_SENT_V1": return { ...p, userId: p.requesterId, addresseeId: recipient };
    case "FRIEND_REQUEST_ACCEPTED_V1": return { ...p, userId: p.accepterId, requesterId: recipient };
    case "RACE_INVITE_SENT_V1": return { ...p, inviteeUserId: recipient };
    case "RACE_INVITE_ACCEPTED_V1": return { ...p, userId: p.userId, creatorUserId: recipient };
    case "RACE_BUYIN_CHANGED_V1": return { ...p, affectedUserIds: [recipient], notificationIntentId: `race-buyin:${p.changeId}` };
    case "RACE_SCHEDULED_TEAMS_UNEVEN_V1": return { ...p, creatorUserId: recipient, notificationClaimed: true };
    case "RACE_STARTED_V1": return { ...p, participantUserIds: [recipient] };
    case "RACE_ENDING_SOON_V1": return { ...p, userId: recipient, notificationClaimed: true };
    case "DAILY_REWARD_REMINDER_V1":
    case "UNCLAIMED_REWARD_REMINDER_V1":
    case "STEP_MILESTONE_REMINDER_V1": return { ...p, userId: recipient };
    case "RACE_COMPLETED_V1": return { ...p, participantUserIds: [recipient], memberTeams: { [recipient]: facts.memberTeam ?? null } };
    case "TEAM_LEAD_CHANGED_V1": return { ...p, memberUserIds: [recipient], notificationIntentId: p.transitionId };
    case "TEAM_FINAL_STRETCH_V1": return { ...p, memberUserIds: [recipient], memberTeams: { [recipient]: facts.memberTeam ?? null }, notificationIntentId: p.transitionId };
    case "TEAM_SLACKER_NUDGE_V1": return { ...p, userId: recipient, notificationClaimed: true };
    case "REFERRAL_REWARDED_V1": return { ...p, userId: recipient };
    case "RACE_CANCELLED_V1": return { ...p, participantUserIds: [recipient] };
    case "GLOBAL_STEP_EVENT_ACTIVATED_V1": return { ...p, participantUserIds: [recipient] };
    case "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1": return { ...p, participantUserIds: [recipient] };
    case "POWERUP_USED_V1": return { ...p, userId: p.actorUserId, targetUserId: recipient, notificationIntentId: publicTypeAndSource(event, audience)[1] };
    case "DECOY_CONSUMED_V1": return {
      ...p,
      userId: p.attackerUserId,
      targetUserId: recipient,
      powerupType: p.attackPowerupType,
      notificationIntentId: publicTypeAndSource(event, audience)[1],
    };
    case "RACE_MESSAGE_SENT_V1": return {
      ...p,
      body: facts.body || p.body,
      recipientUserIds: [recipient],
    };
    case "PLACEMENT_CHANGED_V1": return { ...p, userId: recipient, notificationIntentId: p.transitionId };
    case "HIGH_MULTIPLIER_ALERT_V1": return { ...p, recipientUserIds: [recipient], notificationIntentId: highMultiplierSource(p, recipient) };
    case "TOURNAMENT_INVITE_SENT_V1": return { ...p, userId: recipient };
    case "TOURNAMENT_STARTED_V1":
    case "TOURNAMENT_ROUND_STARTED_V1":
    case "TOURNAMENT_MATCHUP_WON_V1":
    case "TOURNAMENT_ELIMINATED_V1":
    case "TOURNAMENT_CHAMPION_V1":
    case "TOURNAMENT_COMPLETED_V1":
    case "TOURNAMENT_CANCELLED_V1":
    case "DAILY_MOVER_V1": return { ...p, ...facts, userId: recipient, notificationIntentId: p.digestId };
    default: return p;
  }
}

module.exports = {
  PRODUCER_MATRIX,
  EVENT_TYPES,
  deliveryKeyFor,
  projectionKindFor,
  legacyPayloadForRecipient,
};
