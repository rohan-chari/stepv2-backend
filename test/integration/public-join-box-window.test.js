const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Regression test for the public-race mystery-box OVER-GRANT incident.
//
// A user who JOINS a public/featured powerup race that started earlier must earn
// box-progress ONLY from steps walked AFTER they join. The bug: the live
// step-sync path (recordSteps/recordStepSamples -> resolveRaceState ->
// calculateBaseAdjusted -> getEffectiveStart) read participants via
// Race.findActiveForUser, whose lean select omitted `joinedAt`. With joinedAt
// undefined, getEffectiveStart silently fell back to race.startedAt, so the box
// window started at RACE START and summed the joiner's PRE-join steps, minting a
// burst of milestone mystery boxes the instant they synced.
//
// Real incident: joined a 3-day-old public race, ~7978 steps since race start,
// got milestone boxes at 2000/4000/6000/8000 while the (correctly join-clamped)
// leaderboard total was ~708.
//
// Fix: add `joinedAt: true` to the lean select so the window clamps to the real
// join everywhere. This test fails (milestone boxes minted) without that fix.

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-pjbw-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

const INTERVAL = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Box milestones are minted at earned_at_steps that are positive multiples of the
// interval. Onboarding welcome boxes use earned_at_steps 0/1/2, so filtering to
// earned_at_steps >= INTERVAL isolates the milestone over-grant regardless of
// whether the joiner also received first-race onboarding boxes.
function milestoneBoxes(rows) {
  return rows.filter(
    (p) => p.earnedAtSteps != null && p.earnedAtSteps >= INTERVAL
  );
}

describe("public-race join clamps box window to join time (over-grant regression)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("a mid-race public joiner earns NO milestone boxes from pre-join steps", async () => {
    const creator = await createUser("CreatorPJBW");
    const joiner = await createUser("JoinerPJBWW");

    // Creator makes a public powerup race, then we force it ACTIVE, started 3
    // days ago, ending well in the FUTURE (so the new endsAt guard does not
    // short-circuit resolveRaceState), with a 2000-step box interval.
    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Walk It Public",
        targetSteps: 0,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: INTERVAL,
        isPublic: true,
      },
      token: creator.token,
    });
    assert.ok(
      createRes.status >= 200 && createRes.status < 300,
      `create race failed: ${createRes.status}`
    );
    const raceId = (await createRes.json()).race.id;

    const now = new Date();
    const startedAt = new Date(now.getTime() - 3 * DAY_MS);
    const endsAt = new Date(now.getTime() + 4 * DAY_MS);
    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        timeBased: true,
        startedAt,
        endsAt,
        isPublic: true,
        powerupsEnabled: true,
        powerupStepInterval: INTERVAL,
      },
    });

    // Seed the joiner's PRE-join step history: ~12000 steps spread across the 3
    // days BEFORE they join. If the box window wrongly starts at race start this
    // is enough to cross the 2000 interval six times.
    for (let d = 1; d <= 3; d++) {
      const dayStart = new Date(now.getTime() - d * DAY_MS);
      const date = new Date(
        Date.UTC(
          dayStart.getUTCFullYear(),
          dayStart.getUTCMonth(),
          dayStart.getUTCDate()
        )
      );
      await prisma.step.create({
        data: { userId: joiner.userId, steps: 4000, date },
      });
      await prisma.stepSample.create({
        data: {
          userId: joiner.userId,
          periodStart: new Date(dayStart.getTime() - 60 * 60 * 1000),
          periodEnd: dayStart,
          steps: 4000,
        },
      });
    }

    // Joiner joins the public race NOW (joinedAt defaults to now()).
    const joinRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join`,
      { token: joiner.token }
    );
    assert.ok(
      joinRes.status >= 200 && joinRes.status < 300,
      `join failed: ${joinRes.status} ${await joinRes.text?.()}`
    );

    const participantAfterJoin = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: joiner.userId },
    });
    assert.ok(participantAfterJoin, "joiner should have a participant row");
    assert.ok(
      participantAfterJoin.joinedAt.getTime() > startedAt.getTime(),
      "joiner joined after the race started"
    );

    // Read progress (arms the box gate join-clamped) then record a SMALL
    // post-join sample, exercising the recordStepSamples -> resolveRaceState
    // path that minted the burst in the incident.
    await request(server.baseUrl, "GET", `/races/${raceId}`, {
      token: joiner.token,
    });
    const postJoin = new Date(Date.now() - 60 * 1000);
    await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: postJoin.toISOString(),
            periodEnd: new Date().toISOString(),
            steps: 120,
          },
        ],
      },
      token: joiner.token,
    });
    await request(server.baseUrl, "GET", `/races/${raceId}`, {
      token: joiner.token,
    });

    const boxes = await prisma.racePowerup.findMany({
      where: { raceId, userId: joiner.userId },
    });
    const milestones = milestoneBoxes(boxes);

    assert.equal(
      milestones.length,
      0,
      `mid-race joiner must earn 0 milestone boxes from pre-join steps, got ${milestones.length} at earned_at_steps [${milestones
        .map((b) => b.earnedAtSteps)
        .join(", ")}]`
    );

    // And the gate must be armed forward of the joiner's (near-zero) post-join
    // box progress — i.e. to the first interval, never to a multiple reflecting
    // the full pre-join history.
    const refreshed = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: joiner.userId },
    });
    assert.ok(
      refreshed.nextBoxAtSteps <= INTERVAL,
      `next_box_at_steps should be clamped near the first interval, got ${refreshed.nextBoxAtSteps}`
    );
  });
});
