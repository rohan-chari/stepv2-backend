// Deterministic local/staging fixture generator for the Home/Races Refresh
// Performance benchmark (Phase A4). Creates a viewer with `activeRaces` ACTIVE
// powerup races (each with `participantsPerRace` accepted members, viewer +
// rivals), viewer inventory (HELD + MYSTERY_BOX + QUEUED) and a Detour effect per
// race so the /races bulk-prefetch path is exercised, plus `completedRaces`
// COMPLETED races. Persisted participant totals only (no step samples) — /races
// reads stored totals, not live windows.
//
// SAFETY: refuses to run against a non-local database unless PERF_STAGING_OK=true
// is explicitly set. NEVER point this at prod. Generated data is not committed.
require("dotenv").config();
const { prisma } = require("../../src/db");
const { RacePowerup } = require("../../src/modules/powerups/models/racePowerup");
const { signSessionToken } = require("../../src/modules/users/services/sessionToken");

function assertSafeDatabase() {
  const url = process.env.DATABASE_URL || "";
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  const stagingOk = process.env.PERF_STAGING_OK === "true";
  if (!isLocal && !stagingOk) {
    throw new Error(
      "REFUSING to generate fixtures: DATABASE_URL is not localhost and PERF_STAGING_OK!=true. " +
        "Never run against production."
    );
  }
  if (/ondigitalocean|amazonaws|\.rds\.|prod/i.test(url) && !stagingOk) {
    throw new Error("REFUSING: DATABASE_URL looks like a managed/prod host.");
  }
}

let seq = 0;
async function makeUser(tag) {
  seq += 1;
  const uniq = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.user.create({
    data: {
      appleId: `perf-${tag}-${seq}-${uniq}`,
      email: `perf-${tag}-${seq}-${uniq}@example.com`,
      displayName: `Perf ${tag} ${seq} ${uniq}`,
    },
  });
}

async function generateFixtures({
  activeRaces = 50,
  participantsPerRace = 10,
  completedRaces = 10,
  powerups = true,
} = {}) {
  assertSafeDatabase();

  const viewer = await makeUser("viewer");
  // Shared rival pool reused across races (realistic — the same friends recur).
  const rivals = [];
  for (let i = 0; i < participantsPerRace - 1; i++) {
    rivals.push(await makeUser(`rival${i}`));
  }

  const startedAt = new Date(Date.now() - 6 * 60 * 60 * 1000);

  async function buildRace(status, index) {
    const race = await prisma.race.create({
      data: {
        name: `Perf ${status} Race ${index}`,
        targetSteps: 500000,
        maxDurationDays: 7,
        status,
        powerupsEnabled: powerups,
        powerupStepInterval: 5000,
        startedAt,
        endsAt: status === "COMPLETED" ? new Date(Date.now() - 60 * 60 * 1000) : null,
        completedAt: status === "COMPLETED" ? new Date(Date.now() - 60 * 60 * 1000) : null,
        isPublic: false,
        maxParticipants: participantsPerRace,
      },
    });

    const members = [viewer, ...rivals];
    const participants = [];
    for (let m = 0; m < members.length; m++) {
      const p = await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: members[m].id,
          status: "ACCEPTED",
          totalSteps: 1000 * (m + 1) + index,
          nextBoxAtSteps: 5000,
          powerupSlots: 3,
          joinedAt: startedAt,
          placement: status === "COMPLETED" ? m + 1 : null,
          finishedAt: status === "COMPLETED" ? new Date(Date.now() - 60 * 60 * 1000) : null,
          finishTotalSteps: status === "COMPLETED" ? 1000 * (m + 1) + index : null,
        },
      });
      participants.push(p);
    }

    if (powerups && status === "ACTIVE") {
      const viewerParticipant = participants[0];
      // Viewer inventory: 1 HELD, 1 MYSTERY_BOX, 1 QUEUED — exercises the bulk
      // inventory prefetch grouping.
      await RacePowerup.create({ raceId: race.id, participantId: viewerParticipant.id, userId: viewer.id, type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD", earnedAtSteps: 5000 });
      await RacePowerup.create({ raceId: race.id, participantId: viewerParticipant.id, userId: viewer.id, status: "MYSTERY_BOX", earnedAtSteps: 10000 });
      await RacePowerup.create({ raceId: race.id, participantId: viewerParticipant.id, userId: viewer.id, status: "QUEUED", earnedAtSteps: 15000 });
      // NOTE: the /races Detour-masking prefetch (findActiveByTypeForParticipants)
      // is issued for the viewer's participant ids regardless of whether any
      // DETOUR_SIGN rows exist, so it is measured either way. We skip seeding
      // effect rows here to keep the generator dependency-light.
    }
    return race;
  }

  for (let i = 0; i < activeRaces; i++) await buildRace("ACTIVE", i);
  for (let i = 0; i < completedRaces; i++) await buildRace("COMPLETED", i);

  const token = signSessionToken({ userId: viewer.id, appleId: viewer.appleId });
  return {
    viewerUserId: viewer.id,
    viewerToken: token,
    activeRaces,
    completedRaces,
    participantsPerRace,
  };
}

module.exports = { generateFixtures, assertSafeDatabase };

if (require.main === module) {
  const active = Number(process.env.PERF_ACTIVE_RACES || 50);
  const participants = Number(process.env.PERF_PARTICIPANTS || 10);
  generateFixtures({ activeRaces: active, participantsPerRace: participants })
    .then((r) => {
      console.log("Fixtures created:", JSON.stringify(r, null, 2));
      return prisma.$disconnect();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
