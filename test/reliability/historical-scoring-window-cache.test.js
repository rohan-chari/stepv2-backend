process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");


let server;
let nextAppleId = 0;

const FEAT = {
  "X-Client-Features": "characters,powerups2,powerups3,team_races",
};
const HEADERS = { ...FEAT, "X-Timezone": "UTC" };
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-parity-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  // TR-706: any authed request carrying the header records the user's last-seen
  // capability tokens. Without this an invite to a team race is rejected with
  // INVITEE_NEEDS_UPDATE, because the invitee has nothing recorded.
  await request(server.baseUrl, "GET", "/auth/me", {
    token: body.sessionToken,
    headers: HEADERS,
  });
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

function hourFloor(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function giveHeld(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
    },
  });
}

async function totalsViaApi(raceId, viewer) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: viewer.token,
    headers: HEADERS,
  });
  const body = await res.json();
  const totals = {};
  for (const p of body.progress.participants) totals[p.userId] = p.totalSteps;
  return { status: body.progress.status, totals };
}


const { processHistoricalScoringWindowCache } = require("../../src/modules/races/services/historicalScoringWindowCache");
describe("Historical scoring window cache — HTTP", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); processHistoricalScoringWindowCache.clear(); });
  it("reuses historical calculations after a recent sync and invalidates corrected or moved historical samples", async () => {
    const owner = await createUser("Cache walker");
    const other = await createUser("Cache opponent");
    await makeFriends(owner, other);
    const created = await request(server.baseUrl, "POST", "/races", {
      token: owner.token, headers: HEADERS,
      body: { name: "Historical cache", targetSteps: 500000, maxDurationDays: 7,
        powerupsEnabled: true, powerupStepInterval: 50000 },
    });
    assert.equal(created.status, 201);
    const raceId = (await created.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      token: owner.token, headers: HEADERS, body: { inviteeIds: [other.userId] },
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: other.token, headers: HEADERS, body: { accept: true },
    });
    const start = new Date(hourFloor(144).toISOString().slice(0, 10));
    await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, timezone: "UTC" } });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
    const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: owner.userId } });
    const oldStart = hourFloor(96);
    const oldMiddle = new Date(oldStart.getTime() + HOUR_MS / 2);
    const oldEnd = new Date(oldStart.getTime() + HOUR_MS);
    const held = await giveHeld(raceId, owner.userId, "RUNNERS_HIGH");
    await prisma.raceActiveEffect.create({ data: {
      raceId, targetParticipantId: participant.id, targetUserId: owner.userId,
      sourceUserId: owner.userId, powerupId: held.id, type: "RUNNERS_HIGH", status: "EXPIRED",
      startsAt: oldStart, expiresAt: oldMiddle, metadata: { stepsAtBuffStart: 0, stepsAtExpiry: 500 },
    } });
    // A heavy historical workload makes memoization cheaper than rebuilding
    // proofs for just a few windows. Quiet zero-step buckets are real inputs;
    // the public uploads below supply all scored steps.
    const zeroRows = [];
    for (const daysAgo of [2, 3, 5]) {
      const midnight = new Date(hourFloor(daysAgo * 24).toISOString().slice(0, 10)).getTime();
      for (let minute = 0; minute < 1440; minute += 5) zeroRows.push({
        userId: owner.userId, periodStart: new Date(midnight + minute * 60000),
        periodEnd: new Date(midnight + (minute + 5) * 60000), steps: 0,
      });
    }
    await prisma.stepSample.createMany({ data: zeroRows });
    const boostDay = new Date(hourFloor(72).toISOString().slice(0, 10)).getTime();
    const boostIds = Array.from({ length: 64 }, () => randomUUID());
    await prisma.racePowerup.createMany({ data: boostIds.map(id => ({
      id, raceId, participantId: participant.id, userId: owner.userId,
      type: "RUNNERS_HIGH", status: "USED", rarity: "COMMON",
    })) });
    await prisma.raceActiveEffect.createMany({ data: Array.from({ length: 64 }, (_, index) => ({
      raceId, targetParticipantId: participant.id, targetUserId: owner.userId,
      sourceUserId: owner.userId, type: "RUNNERS_HIGH", status: "EXPIRED",
      powerupId: boostIds[index],
      startsAt: new Date(boostDay + index * 15 * 60000),
      expiresAt: new Date(boostDay + (index * 15 + 5) * 60000),
      metadata: { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    })) });
    const upload = async (periodStart, periodEnd, steps) => {
      const res = await request(server.baseUrl, "POST", "/steps/samples", {
        token: owner.token, headers: HEADERS,
        body: { samples: Array.isArray(periodStart) ? periodStart : [{ periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), steps }] },
      });
      assert.equal(res.status, 200, JSON.stringify(await res.json()));
    };
    const uploadOld = (first, second) => upload([
      { periodStart: oldStart.toISOString(), periodEnd: oldMiddle.toISOString(), steps: first },
      { periodStart: oldMiddle.toISOString(), periodEnd: oldEnd.toISOString(), steps: second },
    ]);
    await uploadOld(500, 500);
    await upload(hourFloor(1), hourFloor(0), 100);
    processHistoricalScoringWindowCache.clear();
    assert.equal((await totalsViaApi(raceId, owner)).totals[owner.userId], 1600);
    const before = processHistoricalScoringWindowCache.snapshot();
    await upload(hourFloor(1), hourFloor(0), 200);
    assert.equal((await totalsViaApi(raceId, owner)).totals[owner.userId], 1700);
    assert.ok(processHistoricalScoringWindowCache.snapshot().hits > before.hits,
      "the real scoring path reused unchanged historical window results after a new sync");
    await uploadOld(250, 250);
    assert.equal((await totalsViaApi(raceId, owner)).totals[owner.userId], 950);
    // Same count and total, moved entirely outside the boost window.
    await uploadOld(0, 500);
    assert.equal((await totalsViaApi(raceId, owner)).totals[owner.userId], 700);
  });
});
