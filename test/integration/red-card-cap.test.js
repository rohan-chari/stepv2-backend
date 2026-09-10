const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");

let server;
const MODERN = { "X-Client-Features": "characters,team_races,powerups5,resolved_impact_events_v2" };
const LEGACY = { "X-Client-Features": "characters" };

async function fixture(scores, { team = false } = {}) {
  const users = [];
  for (let i = 0; i < scores.length; i++) users.push(await createTestUser({ displayName: `CapRunner${i}` }));
  const startedAt = new Date(Date.now() - 3600000);
  const race = await prisma.race.create({ data: {
    creatorId: users[0].user.id, name: "Red Card cap", status: "ACTIVE",
    targetSteps: 1000000, startedAt, endsAt: new Date(Date.now() + 86400000),
    powerupsEnabled: true, isTeamRace: team, ...(team ? { teamSize: 2, teamAName: "A", teamBName: "B" } : {}),
  } });
  await prisma.raceParticipant.createMany({ data: users.map(({ user }, i) => ({
    raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: startedAt,
    totalSteps: scores[i], bonusSteps: scores[i], ...(team ? { team: i < 2 ? "TEAM_A" : "TEAM_B" } : {}),
  })) });
  let earned = 900000;
  async function held(i, type = "RED_CARD") {
    const p = await prisma.raceParticipant.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: users[i].user.id } } });
    return prisma.racePowerup.create({ data: { raceId: race.id, userId: p.userId, participantId: p.id, type, rarity: "RARE", status: "HELD", earnedAtSteps: ++earned } });
  }
  async function use(i, card, headers = MODERN) {
    return request(server.baseUrl, "POST", `/races/${race.id}/powerups/${card.id}/use`, { token: users[i].token, body: {}, headers });
  }
  async function defend(i, type) {
    const card = await held(i, type);
    const res = await use(i, card);
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    return card;
  }
  async function checkLoss(i, loss, headers = MODERN) {
    const p = await prisma.raceParticipant.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: users[i].user.id } } });
    assert.equal(p.totalSteps, scores[i] - loss);
    assert.equal(p.bonusSteps, scores[i] - loss);
    const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: users[i].token, headers });
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.participants.find(p => p.userId === users[i].user.id).totalSteps, scores[i] - loss);
    return progress;
  }
  async function checkEvent(i, penalty) {
    const events = await prisma.racePowerupEvent.findMany({ where: { raceId: race.id, powerupType: "RED_CARD", eventType: "POWERUP_USED", targetUserId: users[i].user.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.penalty, penalty);
    const impacts = await prisma.raceImpactEvent.findMany({ where: { raceId: race.id, recipientUserId: users[i].user.id, powerupType: "RED_CARD" } });
    if (penalty > 0) {
      assert.equal(impacts.length, 1);
      assert.equal(impacts[0].deltaSteps, -penalty);
    }
    const feed = await request(server.baseUrl, "GET", `/races/${race.id}/feed`, { token: users[i].token, headers: MODERN });
    assert.equal(feed.status, 200);
    const event = (await feed.json()).events.find(e => e.id === events[0].id);
    assert.ok(event);
    assert.ok(event.description.includes(`${penalty.toLocaleString()} steps`));
  }
  return { users, race, held, use, defend, checkLoss, checkEvent };
}

describe("Red Card 10,000 step cap through real HTTP", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  for (const [score, penalty] of [[4, 0], [5, 1], [1555, 156], [50000, 5000], [99994, 9999], [99995, 10000], [100000, 10000], [100004, 10000], [100005, 10000], [200000, 10000]]) {
    it(`score ${score} loses ${penalty}, matching durable state and public feed`, async () => {
      const f = await fixture([0, score]);
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(1, penalty);
      await f.checkEvent(1, penalty);
    });
  }

  it("legacy request keeps the result envelope and capped penalty without any new parameter", async () => {
    const f = await fixture([500, 200000]);
    const res = await f.use(0, await f.held(0), LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["result"]);
    assert.equal(body.result.outcome, "APPLIED");
    assert.equal(body.result.penalty, 10000);
    await f.checkLoss(1, 10000, LEGACY);
    await f.checkEvent(1, 10000);
  });

  for (const score of [0, 50000, 150000]) {
    it(`Mirror calculates against the final recipient's ${score} steps`, async () => {
      const f = await fixture([score, 200000]);
      await f.defend(1, "MIRROR");
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      const penalty = Math.min(10000, Math.round(score * 0.1));
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(0, penalty);
      await f.checkLoss(1, 0);
      await f.checkEvent(0, penalty);
    });
  }

  for (const score of [50000, 150000]) {
    it(`Decoy calculates against redirected recipient's ${score} steps`, async () => {
      const f = await fixture([500, 200000, score]);
      await f.defend(1, "DECOY");
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      const penalty = Math.min(10000, Math.round(score * 0.1));
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(1, 0);
      await f.checkLoss(2, penalty);
      await f.checkEvent(2, penalty);
    });
  }

  for (const defense of ["COMPRESSION_SOCKS", "DECOY"]) {
    it(`${defense} still blocks a high-score attack without deducting steps`, async () => {
      const f = await fixture([500, 200000]);
      await f.defend(1, defense);
      const card = await f.held(0);
      const res = await f.use(0, card);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.blocked, true);
      await f.checkLoss(1, 0);
      assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: card.id } })).status, "USED");
    });
  }

  it("distinct cards each cap at 10k and concurrent duplicate retries consume one card once", async () => {
    const f = await fixture([500, 200000]);
    const card = await f.held(0);
    const responses = await Promise.all([f.use(0, card), f.use(0, card)]);
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.some(r => r.status >= 400 && r.status < 500));
    const successful = await responses.find(r => r.status === 200).json();
    assert.equal(successful.result.penalty, 10000);
    await f.checkLoss(1, 10000);
    await f.checkEvent(1, 10000);
    const second = await f.use(0, await f.held(0));
    assert.equal(second.status, 200);
    assert.equal((await second.json()).result.penalty, 10000);
    await f.checkLoss(1, 20000);
  });

  it("concurrent distinct cards preserve nonnegative low scores and actual-loss conservation", async () => {
    const f = await fixture([0, 5, 0]);
    const cards = [await f.held(0), await f.held(2)];
    const responses = await Promise.all([f.use(0, cards[0]), f.use(2, cards[1])]);
    let loss = 0;
    for (const response of responses) {
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.result.penalty >= 0 && body.result.penalty <= 1);
      loss += body.result.penalty;
    }
    assert.ok(loss <= 5);
    await f.checkLoss(1, loss);
  });

  it("team mode subtracts one capped individual loss from only the enemy team", async () => {
    const f = await fixture([500, 1000, 200000, 150000], { team: true });
    const res = await f.use(0, await f.held(0));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.penalty, 10000);
    const progress = await f.checkLoss(2, 10000);
    await f.checkLoss(3, 0);
    await f.checkEvent(2, 10000);
    assert.equal(progress.teams.teamB.totalSteps, 340000);
    assert.equal(progress.teams.teamA.totalSteps, 1500);
  });
  it("the deployment copy sync exposes the cap through the current and legacy catalog", async () => {
    execFileSync(process.execPath, ["scripts/powerup-copy-sync.js", "--apply"], { env: process.env, stdio: "pipe" });
    for (const headers of [MODERN, LEGACY]) {
      const res = await request(server.baseUrl, "GET", "/powerups/catalog", { headers });
      assert.equal(res.status, 200);
      const body = await res.json();
      const redCard = body.powerups.find(p => p.type === "RED_CARD");
      assert.equal(redCard.description, "Remove 10% of the leader's steps, up to 10,000 steps.");
    }
  });

  it("a real queued worker replays a historical 20k penalty unchanged alongside a new capped attack", async () => {
    const f = await fixture([500, 180000]);
    const t = f.race.startedAt.getTime();
    await prisma.racePowerupEvent.createMany({ data: [
      { raceId: f.race.id, actorUserId: f.users[1].user.id, eventType: "POWERUP_USED", powerupType: "PROTEIN_SHAKE", description: "Historical bonus", metadata: { bonus: 200000 }, createdAt: new Date(t + 1000) },
      { raceId: f.race.id, actorUserId: f.users[0].user.id, targetUserId: f.users[1].user.id, eventType: "POWERUP_USED", powerupType: "RED_CARD", description: "Historical Red Card: lost 20,000 steps.", metadata: { penalty: 20000 }, createdAt: new Date(t + 2000) },
    ] });
    const response = await f.use(0, await f.held(0));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.penalty, 10000);
    const env = { ...process.env, RACE_QUEUE_V2_QUIET_PERIOD_MS: "0" };
    delete env.NODE_TEST_CONTEXT;
    const worker = await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, "../../scripts/test-race-resolution-worker-once.js"), [], { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let result;
      child.on("message", value => { result = value; });
      child.on("error", reject);
      child.on("exit", code => code === 0 && !result?.error ? resolve(result) : reject(new Error(result?.error || `worker exit ${code}`)));
    });
    assert.equal(worker.claimed, true);
    await f.checkLoss(1, 10000);
    const feed = await request(server.baseUrl, "GET", `/races/${f.race.id}/feed`, { token: f.users[1].token, headers: LEGACY });
    assert.equal(feed.status, 200);
    assert.ok((await feed.json()).events.some(e => e.description === "Historical Red Card: lost 20,000 steps."));
    const oldEvent = await prisma.racePowerupEvent.findFirstOrThrow({ where: { raceId: f.race.id, powerupType: "RED_CARD", createdAt: new Date(t + 2000) } });
    assert.equal(oldEvent.metadata.penalty, 20000);
  });

});
