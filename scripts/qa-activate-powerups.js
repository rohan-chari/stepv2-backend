require("dotenv").config();

if (!process.env.STAGING_DATABASE_URL) {
  console.error("STAGING_DATABASE_URL not set in .env");
  process.exit(1);
}
process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;

const { prisma } = require("../src/db");
const { grantPowerupToUser } = require("../src/modules/powerups/commands/grantPowerupToUser");
const { redeemPowerupToRace } = require("../src/modules/powerups/commands/redeemPowerupToRace");
const { usePowerup } = require("../src/modules/powerups/commands/usePowerup");

const DISPLAY_NAME = "rohan";
const RACE_NAME_CONTAINS = "daily 10k sprint";
const TYPES = ["GHOST_PEPPER", "RUNNERS_HIGH"];

async function main() {
  const user = await prisma.user.findFirst({
    where: { displayName: { equals: DISPLAY_NAME, mode: "insensitive" } },
  });
  if (!user) throw new Error(`No user found with displayName "${DISPLAY_NAME}"`);

  const race = await prisma.race.findFirst({
    where: {
      name: { contains: RACE_NAME_CONTAINS, mode: "insensitive" },
      status: "ACTIVE",
    },
    select: { id: true, name: true, status: true },
  });
  if (!race) throw new Error(`No ACTIVE race found matching "${RACE_NAME_CONTAINS}"`);

  console.log(`User: ${user.displayName} (${user.id})`);
  console.log(`Race: ${race.name} (${race.id})`);

  for (const type of TYPES) {
    console.log(`\n-- ${type} --`);
    await grantPowerupToUser(user.id, type, { db: prisma });
    console.log(`granted to inventory`);

    const { powerup } = await redeemPowerupToRace({
      userId: user.id,
      raceId: race.id,
      powerupType: type,
    });
    console.log(`redeemed to race as RacePowerup ${powerup.id}`);

    const result = await usePowerup({
      userId: user.id,
      raceId: race.id,
      powerupId: powerup.id,
      timeZone: "America/New_York",
      clientFeatures: new Set(["powerups5", "powerups4", "powerups3", "hitchhike_effective_steps"]),
    });
    console.log(`activated`, JSON.stringify(result?.effect ?? result, null, 2));
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("qa-activate-powerups failed:", err);
      process.exit(1);
    });
}
