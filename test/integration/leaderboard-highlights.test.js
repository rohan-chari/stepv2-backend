const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

let server;

async function createUser(displayName) {
  const { user, token } = await createTestUser({ displayName });
  return { userId: user.id, token, displayName };
}

async function seedStep(userId, steps, date) {
  await prisma.step.create({
    data: {
      userId,
      steps,
      date: new Date(date),
    },
  });
}

async function seedChallenge() {
  return prisma.challenge.create({
    data: {
      title: "Step Showdown",
      description: "Most steps wins",
      type: "HEAD_TO_HEAD",
      resolutionRule: "higher_total",
      active: true,
    },
  });
}

async function createCompletedChallengeInstance({
  challengeId,
  weekOf,
  userAId,
  userBId,
  winnerUserId,
}) {
  return prisma.challengeInstance.create({
    data: {
      challengeId,
      weekOf: new Date(weekOf),
      userAId,
      userBId,
      status: "COMPLETED",
      stakeStatus: "SKIPPED",
      winnerUserId,
      resolvedAt: new Date(`${weekOf}T12:00:00.000Z`),
      userATotalSteps: winnerUserId === userAId ? 12000 : 8000,
      userBTotalSteps: winnerUserId === userBId ? 12000 : 8000,
    },
  });
}

async function createChallengeRecord({
  challengeId,
  user,
  wins,
  losses,
  label,
}) {
  for (let i = 0; i < wins; i++) {
    const opponent = await createUser(`${label}WinOpp${i}`);
    await createCompletedChallengeInstance({
      challengeId,
      weekOf: `2026-01-${String(i + 1).padStart(2, "0")}`,
      userAId: user.userId,
      userBId: opponent.userId,
      winnerUserId: user.userId,
    });
  }

  for (let i = 0; i < losses; i++) {
    const opponent = await createUser(`${label}LossOpp${i}`);
    await createCompletedChallengeInstance({
      challengeId,
      weekOf: `2026-02-${String(i + 1).padStart(2, "0")}`,
      userAId: user.userId,
      userBId: opponent.userId,
      winnerUserId: opponent.userId,
    });
  }
}

async function createCompletedRace({
  name,
  winnerUserId,
  participants,
}) {
  const race = await prisma.race.create({
    data: {
      creatorId: participants[0].userId,
      name,
      targetSteps: 100000,
      status: "COMPLETED",
      startedAt: new Date("2026-03-01T00:00:00.000Z"),
      endsAt: new Date("2026-03-08T00:00:00.000Z"),
      completedAt: new Date("2026-03-02T12:00:00.000Z"),
      winnerUserId,
    },
  });

  await prisma.raceParticipant.createMany({
    data: participants.map((participant, index) => ({
      raceId: race.id,
      userId: participant.userId,
      status: "ACCEPTED",
      totalSteps: 100000 - index * 500,
      baselineSteps: 0,
      nextBoxAtSteps: 0,
      bonusSteps: 0,
      powerupSlots: 3,
      placement: participant.placement,
      finishedAt: participant.placement != null
          ? new Date(`2026-03-02T12:${String(index).padStart(2, "0")}:00.000Z`)
          : null,
      finishTotalSteps: participant.placement != null
          ? 100000 - index * 500
          : null,
    })),
  });

  return race;
}

describe("leaderboard highlights", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("falls back from all-time to month for steps and returns a monthly highlight card", async () => {
    const viewer = await createUser("TrailWalk");

    for (let i = 0; i < 25; i++) {
      const user = await createUser(`AllTimeTop${String(i).padStart(2, "0")}`);
      await seedStep(user.userId, 10000 + i * 100, "2025-12-15");
    }

    await seedStep(viewer.userId, 5000, "2026-04-07");

    const res = await request(server.baseUrl, "GET", "/leaderboard/highlights", {
      token: viewer.token,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      cards: [
        {
          id: "steps-month",
          leaderboardType: "steps",
          period: "month",
          title: "You're 1st this month in steps.",
          subtitle: "Everyone's chasing you.",
        },
      ],
    });
  });

  it("returns up to three cards sorted by strongest brag first across races, steps, and challenges", async () => {
    const viewer = await createUser("TrailWalk");
    const challenge = await seedChallenge();

    for (let i = 0; i < 4; i++) {
      const user = await createUser(`StepRank${String(i).padStart(2, "0")}`);
      await seedStep(user.userId, 9000 - i * 500, "2026-04-07");
    }
    await seedStep(viewer.userId, 7000, "2026-04-07");

    for (let i = 0; i < 7; i++) {
      const user = await createUser(`Challeng${String(i).padStart(2, "0")}`);
      await createChallengeRecord({
        challengeId: challenge.id,
        user,
        wins: 4,
        losses: 1,
        label: `ranker${i}`,
      });
    }
    await createChallengeRecord({
      challengeId: challenge.id,
      user: viewer,
      wins: 3,
      losses: 2,
      label: "viewer",
    });

    const raceLeader = await createUser("RaceLeadr");
    const raceExtraA = await createUser("RaceExtrA");
    const raceExtraB = await createUser("RaceExtrB");
    const raceExtraC = await createUser("RaceExtrC");
    const raceExtraD = await createUser("RaceExtrD");
    await createCompletedRace({
      name: "viewer-race",
      winnerUserId: viewer.userId,
      participants: [
        { userId: viewer.userId, placement: 1 },
        { userId: raceExtraA.userId, placement: 2 },
        { userId: raceExtraB.userId, placement: 3 },
      ],
    });
    await createCompletedRace({
      name: "leader-race",
      winnerUserId: raceLeader.userId,
      participants: [
        { userId: raceLeader.userId, placement: 1 },
        { userId: raceExtraA.userId, placement: 2 },
        { userId: raceExtraB.userId, placement: 3 },
      ],
    });
    await createCompletedRace({
      name: "leader-second",
      winnerUserId: raceExtraC.userId,
      participants: [
        { userId: raceExtraC.userId, placement: 1 },
        { userId: raceLeader.userId, placement: 2 },
        { userId: raceExtraD.userId, placement: 3 },
      ],
    });
    const res = await request(server.baseUrl, "GET", "/leaderboard/highlights", {
      token: viewer.token,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      cards: [
        {
          id: "races-allTime",
          leaderboardType: "races",
          period: "allTime",
          title: "You're 2nd all time in races. That's huge.",
          subtitle: "A win could move you up.",
        },
        {
          id: "steps-allTime",
          leaderboardType: "steps",
          period: "allTime",
          title: "You're 5th all time in steps. Keep climbing.",
          subtitle: "Only 501 steps from 4th.",
        },
        {
          id: "challenges-allTime",
          leaderboardType: "challenges",
          period: "allTime",
          title: "You're 8th all time in challenges. Keep climbing.",
          subtitle: "5 more wins could move you up.",
        },
      ],
    });
  });

  it("ignores challenge records when the user has fewer than 5 completed challenges", async () => {
    const viewer = await createUser("TrailWalk");
    const challenge = await seedChallenge();

    await createChallengeRecord({
      challengeId: challenge.id,
      user: viewer,
      wins: 4,
      losses: 0,
      label: "viewer",
    });

    const res = await request(server.baseUrl, "GET", "/leaderboard/highlights", {
      token: viewer.token,
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      cards: [],
    });
  });
});
