const { eventBus } = require("../events/eventBus");

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

  eventBus.on("STEP_GOAL_SET", (data) => {
    console.log(`[EVENT] Step goal set: ${data.stepGoal} for user ${data.userId}`);
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
}

module.exports = { registerEventHandlers };
