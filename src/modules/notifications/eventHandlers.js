const { eventBus } = require("../../shared/events/eventBus");

function registerEventHandlers() {
  eventBus.on("USER_REGISTERED", (data) => {
    console.log(`[EVENT] New user registered: ${data.userId}`);
  });

  eventBus.on("USER_SIGNED_IN", (data) => {
    console.log(`[EVENT] User signed in: ${data.userId}`);
  });

  eventBus.on("STEPS_RECORDED", (data) => {
    console.log(`[EVENT] Steps recorded: ${data.steps} steps on ${data.date} for user ${data.userId}`);
  });

  eventBus.on("STEPS_UPDATED", (data) => {
    console.log(`[EVENT] Steps updated: ${data.steps} steps on ${data.date} for user ${data.userId}`);
  });

  eventBus.on("DISPLAY_NAME_SET", (data) => {
    console.log(`[EVENT] Display name set: "${data.displayName}" for user ${data.userId}`);
  });

  eventBus.on("FRIEND_REQUEST_SENT", (data) => {
    console.log(`[EVENT] Friend request sent from ${data.userId} to ${data.addresseeId}`);
  });

  eventBus.on("FRIEND_REQUEST_ACCEPTED", (data) => {
    console.log(`[EVENT] Friend request ${data.friendshipId} accepted by ${data.userId}`);
  });

  eventBus.on("FRIEND_REQUEST_DECLINED", (data) => {
    console.log(`[EVENT] Friend request ${data.friendshipId} declined by ${data.userId}`);
  });

  eventBus.on("RACE_CREATED", (data) => {
    console.log(`[EVENT] Race created: ${data.raceId} by ${data.creatorUserId}`);
  });

  eventBus.on("RACE_INVITE_SENT", (data) => {
    console.log(`[EVENT] Race invite sent: ${data.raceId} to ${data.inviteeUserId}`);
  });

  eventBus.on("RACE_INVITE_ACCEPTED", (data) => {
    console.log(`[EVENT] Race invite accepted: ${data.raceId} by ${data.userId}`);
  });

  eventBus.on("RACE_INVITE_DECLINED", (data) => {
    console.log(`[EVENT] Race invite declined: ${data.raceId} by ${data.userId}`);
  });

  eventBus.on("RACE_STARTED", (data) => {
    console.log(`[EVENT] Race started: ${data.raceId}`);
  });

  eventBus.on("RACE_COMPLETED", (data) => {
    console.log(`[EVENT] Race completed: ${data.raceId}, winner: ${data.winnerUserId || "none"}`);
  });

  eventBus.on("RACE_CANCELLED", (data) => {
    console.log(`[EVENT] Race cancelled: ${data.raceId}`);
  });

  eventBus.on("POWERUP_EARNED", (data) => {
    console.log(`[EVENT] Powerup earned: ${data.type} (${data.rarity}) by ${data.userId} in race ${data.raceId}`);
  });

  eventBus.on("POWERUP_USED", (data) => {
    console.log(`[EVENT] Powerup used: ${data.powerupType} by ${data.userId}${data.targetUserId ? ` on ${data.targetUserId}` : ""} in race ${data.raceId}`);
  });

  eventBus.on("POWERUP_BLOCKED", (data) => {
    console.log(`[EVENT] Powerup blocked: ${data.blockedType} from ${data.attackerUserId} blocked by ${data.defenderUserId} in race ${data.raceId}`);
  });

  eventBus.on("POWERUP_DISCARDED", () => {});

  eventBus.on("EFFECT_EXPIRED", (data) => {
    console.log(`[EVENT] Effect expired: ${data.type} on ${data.targetUserId} in race ${data.raceId}`);
  });
}

module.exports = { registerEventHandlers };
