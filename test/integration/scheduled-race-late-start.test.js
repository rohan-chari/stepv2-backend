const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
} = require("./setup");
const {
  autoStartScheduledRaces,
} = require("../../src/jobs/autoStartScheduledRaces");

// Regression for the "@rohitrohit / Fam Steps" bug (2026-06-30): a user-created
// scheduled race sat PENDING for days because it lacked 2 accepted participants
// at its scheduledStartAt. When it finally became eligible and auto-started, the
// job anchored startedAt to the long-past scheduledStartAt — backdating the race
// ~5 days. That instantly back-scored every prior step (44k appeared at once),
// blew past ~14 powerup milestones in the first sync (forfeit-spam in the feed),
// and fired a "Race Started! Go!" push for a race that "already had 2 days left".
//
// The fix: only anchor to scheduledStartAt within a small grace window; a race
// that starts late anchors to NOW so no pre-race steps are counted.

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-late-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

// Build a PENDING, non-seeded race with 2 accepted participants and a
// scheduledStartAt placed `scheduledAgoMs` in the past. We create it via the
// real API (creator auto-accepts), accept the invitee, then force it back to
// PENDING with the desired stale schedule — createRace normalizes
// scheduledStartAt to the future, so the past value has to be set directly.
async function buildPendingScheduledRace({ scheduledAgoMs, interval = 3000 }) {
  const alice = await createUser("LateAlice");
  const bob = await createUser("LateBob");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Fam Steps",
      targetSteps: 0,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: interval,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });

  const scheduledStartAt = new Date(Date.now() - scheduledAgoMs);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      status: "PENDING",
      startedAt: null,
      endsAt: null,
      scheduledStartAt,
    },
  });

  return { alice, bob, raceId, scheduledStartAt };
}

describe("scheduled race auto-start anchoring", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("does NOT backdate a race that auto-starts days after its scheduledStartAt", async () => {
    const { alice, raceId } = await buildPendingScheduledRace({
      scheduledAgoMs: 5 * DAY,
      interval: 3000,
    });

    // Alice walked 44,000 steps three days ago — BEFORE any honest start. These
    // must not be back-scored into the race.
    const threeDaysAgo = new Date(Date.now() - 3 * DAY);
    await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: new Date(threeDaysAgo.getTime() - 60 * MINUTE).toISOString(),
            periodEnd: threeDaysAgo.toISOString(),
            steps: 44000,
          },
        ],
      },
      token: alice.token,
    });

    const before = Date.now();
    await autoStartScheduledRaces();
    const after = Date.now();

    const race = await prisma.race.findUnique({ where: { id: raceId } });

    // A1: started now, not backdated to the 5-day-old scheduledStartAt.
    assert.equal(race.status, "ACTIVE");
    assert.ok(
      race.startedAt.getTime() >= before - MINUTE &&
        race.startedAt.getTime() <= after + MINUTE,
      `startedAt should be ~now, got ${race.startedAt.toISOString()}`
    );
    assert.ok(
      race.startedAt.getTime() > Date.now() - DAY,
      "startedAt must not be backdated days into the past"
    );

    // A2: full duration remains (~7 days left), not ~2.
    const expectedEnds = race.startedAt.getTime() + 7 * DAY;
    assert.ok(
      Math.abs(race.endsAt.getTime() - expectedEnds) < MINUTE,
      "endsAt should anchor to the real start + 7d"
    );

    // A3: participants joined "now", not backdated.
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
    });
    for (const p of participants) {
      assert.ok(
        p.joinedAt.getTime() > Date.now() - DAY,
        "participant joinedAt must not be backdated"
      );
    }

    // A4: prior steps are NOT back-scored — the race total is ~0.
    const progRes = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: alice.token }
    );
    const prog = (await progRes.json()).progress;
    const mine = prog.participants.find((p) => p.userId === alice.userId);
    assert.ok(mine, "alice should be in the leaderboard");
    assert.ok(
      (mine.totalSteps || 0) < 3000,
      `pre-race steps must not count, got ${mine.totalSteps}`
    );

    // A5: no milestone burst — no forfeits at start, threshold freshly initialized.
    const forfeits = await prisma.racePowerupEvent.count({
      where: { raceId, eventType: "POWERUP_FORFEITED" },
    });
    assert.equal(forfeits, 0, "no boxes should be forfeited at start");
    const aliceP = participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.nextBoxAtSteps, 3000, "threshold should start at one interval");
  });

  it("still anchors to scheduledStartAt when started within the grace window", async () => {
    // A6: a race that starts only ~2 min late keeps the clean scheduled-minute
    // anchor (covers normal cron lag) — the clamp must not over-correct.
    const { raceId, scheduledStartAt } = await buildPendingScheduledRace({
      scheduledAgoMs: 2 * MINUTE,
      interval: 3000,
    });

    await autoStartScheduledRaces();

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "ACTIVE");
    assert.ok(
      Math.abs(race.startedAt.getTime() - scheduledStartAt.getTime()) < MINUTE,
      `within grace, startedAt should anchor to scheduledStartAt, got ${race.startedAt.toISOString()}`
    );
  });
});
