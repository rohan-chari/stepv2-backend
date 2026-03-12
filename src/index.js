require("dotenv").config();

const { createApp } = require("./app");
const { registerEventHandlers } = require("./handlers/eventHandlers");

const app = createApp();
const PORT = process.env.PORT || 3000;

// Register event handlers
registerEventHandlers();

app.listen(PORT, () => {
  console.log(`Steps Tracker API running on port ${PORT}`);
});
