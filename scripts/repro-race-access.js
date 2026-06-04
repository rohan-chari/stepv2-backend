// Repro every race-screen endpoint against PROD to find which one 500s.
// Usage: node scripts/repro-race-access.js <userId> <raceId> [timeZone]
require("dotenv").config();
process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;

const { getRaceDetails } = require("../src/queries/getRaceDetails");
const { getRaceProgress } = require("../src/queries/getRaceProgress");
const { getRaceInventory } = require("../src/queries/getRaceInventory");
const { getRaceFeed } = require("../src/queries/getRaceFeed");
const { getRaceMessages } = require("../src/queries/getRaceMessages");

const [, , userId, raceId, tz = "America/New_York"] = process.argv;

const calls = [
  ["getRaceDetails", () => getRaceDetails(userId, raceId)],
  ["getRaceProgress", () => getRaceProgress(userId, raceId, tz)],
  ["getRaceInventory", () => getRaceInventory(userId, raceId)],
  ["getRaceFeed", () => getRaceFeed(userId, raceId, {})],
  ["getRaceMessages", () => getRaceMessages(userId, raceId, { limit: 50 })],
];

(async () => {
  for (const [name, fn] of calls) {
    try {
      await fn();
      console.log(`  OK   ${name}`);
    } catch (e) {
      console.log(`  FAIL ${name}: ${e.name} ${e.code || ""} ${e.statusCode || ""} — ${e.message}`);
      console.log(e.stack?.split("\n").slice(0, 6).join("\n"));
    }
  }
  process.exit(0);
})();
