// Remediation for "runners hi" race (bdec7e3f-ddc0-4d70-8d34-4637293705e7):
// emersonz's Lvl 3 Pinecone Toss on DrAmogh (2026-08-12T00:05:23.561Z) was
// redirected by DrAmogh's active Decoy to avanish24, who lost 2,250 steps.
// Per explicit user decision (Rohan, 2026-08-11): since it was the upgraded
// (Lvl 3, 2,250-step) toss, refund avanish24's 2,250 steps and instead apply
// the full 2,250 penalty to DrAmogh, using the same bonusSteps write path
// PINECONE_TOSS itself uses, then re-resolving race state exactly as
// usePowerup does after every use.
const fs = require("fs");
const prodUrl = fs.readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
process.env.DATABASE_URL = prodUrl;

const { prisma } = require("../src/db");
const { RaceParticipant } = require("../src/modules/races/models/raceParticipant");
const { RacePowerupEvent } = require("../src/modules/powerups/models/racePowerupEvent");
const { invalidateRaceProgress } = require("../src/modules/races/services/raceProgressSnapshot");
const { enqueueRaceResolution } = require("../src/modules/races/services/enqueueRaceResolution");
const { resolveRaceState } = require("../src/modules/races/services/raceStateResolution");

const RACE_ID = "bdec7e3f-ddc0-4d70-8d34-4637293705e7";
const PENALTY = 2250;

(async () => {
  const participants = await prisma.$queryRawUnsafe(
    `SELECT rp.id, rp.user_id AS "userId", u.display_name AS "displayName", rp.total_steps AS "totalSteps", rp.bonus_steps AS "bonusSteps"
       FROM race_participants rp JOIN users u ON u.id = rp.user_id
      WHERE rp.race_id = $1 AND u.display_name IN ('DrAmogh','avanish24')`,
    RACE_ID
  );
  const drAmogh = participants.find((p) => p.displayName === "DrAmogh");
  const avanish = participants.find((p) => p.displayName === "avanish24");
  if (!drAmogh || !avanish) throw new Error("participant not found: " + JSON.stringify(participants));

  console.log("BEFORE:", participants);

  await RaceParticipant.addBonusSteps(avanish.id, PENALTY);
  await RaceParticipant.subtractBonusSteps(drAmogh.id, PENALTY);

  await RacePowerupEvent.create({
    raceId: RACE_ID,
    actorUserId: drAmogh.userId,
    eventType: "ADMIN_CORRECTION",
    powerupType: "PINECONE_TOSS",
    targetUserId: avanish.userId,
    description:
      "Manual correction: emersonz's Lvl 3 Pinecone Toss (redirected by DrAmogh's Decoy to avanish24) is now scored against DrAmogh directly. avanish24 refunded 2,250 steps; DrAmogh charged 2,250 steps.",
    metadata: { penalty: PENALTY, correctedBy: "admin", reason: "decoy_redirect_score_correction" },
  });

  await invalidateRaceProgress(RACE_ID);
  await enqueueRaceResolution({ raceId: RACE_ID, userId: drAmogh.userId, timeZone: "America/New_York" });
  await resolveRaceState({ raceId: RACE_ID, timeZone: "America/New_York" });

  const after = await prisma.$queryRawUnsafe(
    `SELECT rp.id, u.display_name AS "displayName", rp.total_steps AS "totalSteps", rp.bonus_steps AS "bonusSteps"
       FROM race_participants rp JOIN users u ON u.id = rp.user_id
      WHERE rp.race_id = $1 AND u.display_name IN ('DrAmogh','avanish24')`,
    RACE_ID
  );
  console.log("AFTER:", after);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
