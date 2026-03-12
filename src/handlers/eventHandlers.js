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
}

module.exports = { registerEventHandlers };
