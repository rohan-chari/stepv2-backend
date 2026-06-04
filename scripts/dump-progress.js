require("dotenv").config();
process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
const { getRaceProgress } = require("../src/queries/getRaceProgress");
const [,, userId, raceId] = process.argv;
(async () => {
  const r = await getRaceProgress(userId, raceId, "America/New_York");
  const frac = [];
  const scan = (obj, path) => {
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === "number" && !Number.isInteger(v)) frac.push(`${path}.${k} = ${v}`);
      else if (v && typeof v === "object") scan(v, `${path}.${k}`);
    }
  };
  scan(r, "result");
  console.log("Non-integer numbers in response:");
  console.log(frac.length ? frac.join("\n") : "  (none)");
  console.log("\nLeaderboard totalSteps:", r.participants.map(p => p.totalSteps).join(", "));
  process.exit(0);
})();
