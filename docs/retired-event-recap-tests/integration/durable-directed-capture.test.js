const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");

let server;
async function fixture(amounts = [200, 500, 9000, 7000, 8000]) {
  const accounts = [];
  for (const amount of amounts) accounts.push(await createTestUser({ displayName: `Directed input ${amount}` }));
  const startsAt = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 3 * 3600000 + 600000);
  // Hitchhike v1/v2 clamp to the scoring cutoff's top of hour. End exactly
  // on that boundary so this fixture exercises accrued copies, not open-hour0.
  const endsAt = new Date(startsAt.getTime() + 50 * 60000);
  const localDate = startsAt.toISOString().slice(0, 10);
  const race = await prisma.race.create({ data: { creatorId: accounts[0].user.id, name: "Directed exact capture",
    status: "ACTIVE", targetSteps: 1000000, powerupsEnabled: true, timezone: "UTC",
    startedAt: new Date(startsAt.getTime() - 600000), endsAt: new Date(Date.now() + 3600000) } });
  const participants = [];
  for (const [index, account] of accounts.entries()) {
    participants.push(await prisma.raceParticipant.create({ data: { raceId: race.id,userId: account.user.id,
      status: "ACCEPTED",joinedAt: race.startedAt } }));
    await prisma.stepSample.create({ data: { userId: account.user.id,periodStart: startsAt,periodEnd: endsAt,steps: amounts[index] } });
    await prisma.step.create({ data: { userId: account.user.id,date: new Date(localDate),steps: amounts[index] } });
  }
  const event = await prisma.globalStepEvent.create({ data: { startsAt,endsAt,multiplier: 2,summaryAttributionVersion: 2 } });
  await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id,userId: accounts[0].user.id,
    timezone: "UTC",localDate,startsAt,endsAt,startOutcome: "ACTIVATED_ON_TIME",startProcessedAt: startsAt } });
  const work = await prisma.globalEventSummaryWork.create({ data: { eventId: event.id,userId: accounts[0].user.id,
    status: "WAITING_SYNC",expiresAt: new Date(Date.now() + 3600000),requiredRaceCount: 1 } });
  await prisma.globalEventRaceImpact.create({ data: { eventId: event.id,raceId: race.id,userId: accounts[0].user.id,
    status: "PENDING",attributionVersion: 2 } });
  return { accounts,participants,race,event,work,startsAt,endsAt,localDate,amounts };
}
async function effect(f, type, source, target, { offset = 0, metadata = {}, status = "EXPIRED" } = {}) {
  const powerup = await prisma.racePowerup.create({ data: { raceId: f.race.id,participantId: f.participants[source].id,
    userId: f.accounts[source].user.id,targetUserId: f.accounts[target].user.id,type,status: "USED" } });
  return prisma.raceActiveEffect.create({ data: { raceId: f.race.id,powerupId: powerup.id,type,status,
    sourceUserId: f.accounts[source].user.id,targetUserId: f.accounts[target].user.id,
    targetParticipantId: f.participants[target].id,startsAt: new Date(f.startsAt.getTime() + offset),expiresAt: f.endsAt,
    metadata: { ratio: 2,copyRatio: 1,...metadata } } });
}
async function intake(f) {
  const response = await request(server.baseUrl,"POST","/steps/sync-v2",{
    token: f.accounts[0].token,
    headers: { "Idempotency-Key": randomUUID(),"X-Timezone": "UTC","X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
    body: { date: f.localDate,steps: f.amounts[0],samples: [{ periodStart: f.startsAt.toISOString(),periodEnd: f.endsAt.toISOString(),steps: f.amounts[0] }] },
  });
  assert.equal(response.status,202,JSON.stringify(response.body));
  const [queued] = await prisma.$queryRawUnsafe("SELECT id,context FROM durable_global_event_capture_requests WHERE work_id=$1",f.work.id);
  assert.ok(queued,"qualifying HTTP intake persists directed capture work");
  return queued;
}
async function finish(f) {
  for (let tick = 0; tick < 160; tick += 1) {
    await buildGlobalEventSummaryTick({ prisma,now: () => new Date() })();
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({ where: { workId: f.work.id } });
    if (artifact) return artifact;
    const [state] = await prisma.$queryRawUnsafe("SELECT status,last_error_code FROM durable_global_event_capture_requests WHERE work_id=$1",f.work.id);
    assert.notEqual(state.status,"FAILED",JSON.stringify(state));
  }
  assert.fail("directed capture did not finish within bounded worker claims");
}
function assertPlan(f,queued,evaluated,facts) {
  const capture = queued.context.captures[0];
  assert.ok(capture.payload.scoringPlan,"intake must pin an explicit directed evaluation plan");
  assert.deepEqual(new Set(capture.payload.scoringPlan.evaluatedParticipantIds),new Set(evaluated.map((i) => f.participants[i].id)));
  assert.deepEqual(new Set(capture.userIds),new Set(facts.map((i) => f.accounts[i].user.id)));
  assert.deepEqual(new Set(queued.context.roots.map((root) => root.userId)),new Set(facts.map((i) => f.accounts[i].user.id)));
}

describe("exact directed capture dependency planning",() => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });
  it("an incoming leecher is a raw-fact leaf; its own incoming chain and disconnected history are irrelevant",async () => {
    const f = await fixture();
    await effect(f,"LEECH",1,0);
    await effect(f,"LEECH",2,1);
    await effect(f,"LEECH",3,4);
    await effect(f,"HITCHHIKE",2,3,{ metadata: { scoringVersion: 2 } });
    await prisma.stepSample.createMany({ data: Array.from({ length: 600 },(_,index) => ({
      userId: f.accounts[2].user.id,steps: 1000,
      periodStart: new Date(f.race.startedAt.getTime() + index * 100),periodEnd: new Date(f.race.startedAt.getTime() + (index + 1) * 100),
    })) });
    const queued = await intake(f);
    assertPlan(f,queued,[0],[0,1]);
    const artifact = await finish(f);
    // Uploader200; leecher500/2=250. Without boost max(0,200-250)=0;
    // with boost max(0,400-250)=150. Leaf's own credits never change raw500.
    assert.equal(artifact.payload.attributionDeltaSteps,150);
    const [physical] = await prisma.$queryRawUnsafe(`SELECT COALESCE(sum(r.source_sample_rows),0)::int AS n
      FROM durable_capture_fact_roots r JOIN durable_capture_fact_pins p ON p.root_id=r.id WHERE p.owner_id=$1::uuid`,queued.id);
    assert.ok(physical.n <= 8,`unrelated600-row history leaked into capture: ${physical.n}`);
  });
  it("competing drains and a victim's Hitchhike copy preserve exact uploader credit without evaluating leaf scores",async () => {
    const f = await fixture([200,50,600,9000]);
    await effect(f,"LEECH",2,1);
    await effect(f,"LEECH",0,1,{ offset: 1 });
    await effect(f,"HITCHHIKE",1,0,{ metadata: { scoringVersion: 2 } });
    await effect(f,"HITCHHIKE",2,3,{ metadata: { scoringVersion: 2 } });
    const queued = await intake(f);
    assertPlan(f,queued,[0,1],[0,1,2]);
    const artifact = await finish(f);
    // Victim50 + copyA:250->450. Earlier competitor drains300, so A's
    //100-step Leech earns0->100; A's own event earns200. Delta=300.
    assert.equal(artifact.payload.attributionDeltaSteps,300);
  });
  it("a frozen outgoing victim is not evaluated or loaded",async () => {
    const f = await fixture([200,10000,9000]);
    await effect(f,"LEECH",0,1);
    await effect(f,"HITCHHIKE",1,2,{ metadata: { scoringVersion: 2 } });
    await prisma.raceParticipant.update({ where: { id: f.participants[1].id },data: { finishedAt: new Date(f.startsAt.getTime() - 1) } });
    const queued = await intake(f);
    assertPlan(f,queued,[0],[0]);
    assert.equal((await finish(f)).payload.attributionDeltaSteps,200);
  });
  it("a departed competing leecher remains a raw leaf because its victim is still drained",async () => {
    const f = await fixture([200,500,9000]);
    await effect(f,"LEECH",1,0);
    await effect(f,"LEECH",2,1);
    await prisma.raceParticipant.update({ where: { id: f.participants[1].id },data: {
      status: "DECLINED",finishedAt: new Date(f.startsAt.getTime() - 1),
    } });
    const queued = await intake(f);
    assertPlan(f,queued,[0],[0,1]);
    assert.equal((await finish(f)).payload.attributionDeltaSteps,150);
  });
  it("a Hitchhike raw leaf retains its finish clamp even though its score is never evaluated",async () => {
    const f = await fixture([200,600,1400]);
    await effect(f,"HITCHHIKE",0,1,{ metadata: { scoringVersion: 2 } });
    await effect(f,"LEECH",2,0);
    const finishedAt = new Date(f.startsAt.getTime() + 25 * 60000);
    await prisma.raceParticipant.update({ where: { id: f.participants[1].id },data: { finishedAt } });
    const queued = await intake(f);
    assertPlan(f,queued,[0],[0,1,2]);
    assert.equal(queued.context.captures[0].payload.participants.find((p) => p.id === f.participants[1].id).finishedAt,finishedAt.toISOString());
    // Copy half of target600=300. A200+300→A400+300, then700 drain
    // floors both to0. Losing target metadata would copy600 and give delta200.
    assert.equal((await finish(f)).payload.attributionDeltaSteps,0);
  });
});
