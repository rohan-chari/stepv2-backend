require("dotenv").config();
const { prisma } = require("../src/db");
const crypto = require("crypto");

const FAKE_USERS = [
  "TrailBlazer9",
  "MountainGoat",
  "StepMaster42",
  "WalkingDead1",
  "PeakPerform",
  "SoleSurvivor",
  "StrideQueen",
  "PathFinder99",
  "BootCamper88",
  "HikingHero55",
  "TrekLegend3",
  "WanderLust77",
  "DailyMiler10",
  "MarathonMom4",
  "UrbanHiker22",
];

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dateStr(date) {
  return date.toISOString().slice(0, 10);
}

async function seed() {
  // Clean up previous seed data
  const existing = await prisma.user.findMany({
    where: { appleId: { startsWith: "fake-leaderboard-" } },
    select: { id: true },
  });

  if (existing.length > 0) {
    const ids = existing.map((u) => u.id);
    await prisma.step.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    console.log(`Cleaned up ${existing.length} previous fake users`);
  }

  const now = new Date();
  const today = dateStr(now);

  // Generate dates for the past 60 days
  const dates = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(dateStr(d));
  }

  console.log("Creating fake users with steps...");

  for (let i = 0; i < FAKE_USERS.length; i++) {
    const displayName = FAKE_USERS[i];
    const user = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        appleId: `fake-leaderboard-${i}`,
        email: `${displayName.toLowerCase()}@fake.test`,
        displayName,
      },
    });

    // Each user gets steps for today + random past days
    // Higher-ranked users get more steps overall
    const baseSteps = randomBetween(3000, 15000);
    const stepRecords = [];

    for (const date of dates) {
      // ~70% chance of having steps on any given day
      if (Math.random() < 0.3 && date !== today) continue;

      const dailySteps =
        date === today
          ? randomBetween(2000, 20000)
          : randomBetween(baseSteps - 2000, baseSteps + 5000);

      stepRecords.push({
        userId: user.id,
        steps: Math.max(dailySteps, 500),
        date: new Date(date),
      });
    }

    await prisma.step.createMany({ data: stepRecords });
    console.log(
      `  ${displayName}: ${stepRecords.length} days of steps`
    );
  }

  console.log("\nLeaderboard seed complete!");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
