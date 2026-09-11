const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");
const { inspectArtifact } = require("./helpers/durableCaptureAssertions");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { coordinatedOptimizationMetrics: metrics } = require("../../src/shared/observability/coordinatedOptimizationMetrics");
const { buildGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");
const captureService = require("../../src/modules/steps/services/globalEventSummaryCapture");

const CAPABILITIES = "impact_summaries,impact_summary_expiry_v1";
const SAMPLE_ROWS = "global_summary_capture_sample_db_rows";
const DAILY_ROWS = "global_summary_capture_daily_db_rows";
let server;

function measured(name) {
  const histogram = metrics.snapshot().histograms[name];
  assert.ok(histogram, name + " must be emitted at the actual SQL candidate boundary");
  return histogram.sum;
}
function physicalRows() { return measured(SAMPLE_ROWS) + measured(DAILY_ROWS); }
function sourceSnapshot() {
  return { samples: measured(SAMPLE_ROWS), daily: measured(DAILY_ROWS) };
}
// Manual dependency expectation for THIS fixture: uploader i's victim i-1 is
// evaluated, its own attacker i+1 is a raw leaf; that leaf's attacker is irrelevant.
// This is not derived from the production planner or from returned user IDs.
function chainIds(f, i) {
  const indices = i === 0 ? [0, 1] : [i - 1, i, i + 1].filter((n) => n < f.accounts.length);
  return indices.map((index) => f.accounts[index].user.id);
}
function factIds(result) { return new Set(result.captureContext.userIds); }

async function assertPhysicalAccounting() {
  const [row] = await prisma.$queryRawUnsafe(
    "SELECT COALESCE(sum(source_sample_rows),0)::int AS samples,COALESCE(sum(source_daily_rows),0)::int AS daily FROM durable_capture_fact_roots");
  assert.deepEqual(sourceSnapshot(), row,
    "physical metrics count every source candidate, including candidates later rejected by day membership");
}
async function rootCounters() {
  return prisma.$queryRawUnsafe("SELECT id,user_id,day::text,revision::text,prepared_at,source_sample_rows,source_daily_rows FROM durable_capture_fact_roots ORDER BY id");
}
function assertOldRootsNotReadAgain(before, after) {
  const current = new Map(after.map((row) => [row.id, row]));
  for (const old of before.filter((row) => row.prepared_at)) assert.deepEqual(current.get(old.id), old,
    "a prepared immutable root must not read its source candidates again");
}
async function assertNewRootCandidateBudget(before) {
  const existing = new Set(before.map((root) => root.id));
  for (const root of (await rootCounters()).filter((row) => row.prepared_at && !existing.has(row.id))) {
    const [expected] = await prisma.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM step_samples WHERE user_id=$1 AND
        (($2::date=DATE '0001-01-01' AND period_end::date-period_start::date>=32) OR
         ($2::date<>DATE '0001-01-01' AND period_start>=$2::date-INTERVAL '32 days'
          AND period_start<$2::date+INTERVAL '1 day'))) AS samples,
      (SELECT count(*)::int FROM steps WHERE user_id=$1 AND date=$2::date) AS daily`, root.user_id, root.day);
    assert.deepEqual([root.source_sample_rows,root.source_daily_rows],[expected.samples,expected.daily],
      "each newly prepared user/day may examine its source candidate set exactly once, including filtered candidates");
  }
}


async function assertCommitted(result, expectedUserIds) {
  assert.deepEqual(factIds(result), new Set(expectedUserIds), "exact manually enumerated directed dependency set");
  const c = result.captureContext;
  const samples = await prisma.stepSample.findMany({ where: { userId: { in: expectedUserIds },
    periodEnd: { gt: new Date(c.payload.race.startedAt) }, periodStart: { lt: new Date(c.payload.cutoffAt) } },
  select: { userId:true,periodStart:true,periodEnd:true,steps:true }, orderBy:[{userId:"asc"},{periodStart:"asc"}] });
  const daily = await prisma.step.findMany({ where: { userId: { in: expectedUserIds },
    date: { gte:new Date(c.rangeStart),lte:new Date(c.rangeEnd) } },
  select:{userId:true,date:true,steps:true},orderBy:[{userId:"asc"},{date:"asc"}] });
  assert.deepEqual(result.pinnedFacts.samples, samples.map((row) => ({...row,
    periodStart:row.periodStart.toISOString(),periodEnd:row.periodEnd.toISOString()})));
  assert.deepEqual(result.pinnedFacts.dailySteps,daily.map((row)=>({...row,date:row.date.toISOString()})));
}
async function createConnectedCaptureFixture({
  participantCount = 6,
  workIndexes = [0, 1],
  fixturePrefix = randomUUID().slice(0, 8),
} = {}) {
  const accounts = await Promise.all(Array.from(
    { length: participantCount },
    (_, index) => createTestUser({ displayName: `Fact reuse ${fixturePrefix} ${index}` }),
  ));
  const now = new Date();
  const anchor = Math.floor(now.getTime() / (3 * 3600000)) * (3 * 3600000);
  const raceStartedAt = new Date(anchor - 30 * 60_000);
  const startsAt = new Date(anchor - 20 * 60_000);
  const endsAt = new Date(anchor - 10 * 60_000);
  const race = await prisma.race.create({ data: {
    creatorId: accounts[0].user.id,
    name: "Connected capture fact reuse",
    targetSteps: 100_000,
    status: "ACTIVE",
    startedAt: raceStartedAt,
    endsAt: new Date(now.getTime() + 60 * 60_000),
    powerupsEnabled: true,
  } });
  const participants = [];
  for (const account of accounts) {
    participants.push(await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: raceStartedAt,
    } }));
  }
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt,
    endsAt,
    multiplier: 2,
    summaryAttributionVersion: 2,
  } });
  const localDate = startsAt.toISOString().slice(0, 10);
  await prisma.globalStepEventEntitlement.createMany({
    data: accounts.map((account) => ({
      eventId: event.id,
      userId: account.user.id,
      timezone: "UTC",
      localDate,
      startsAt,
      endsAt,
      startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: startsAt,
    })),
  });
  for (const index of workIndexes) {
    await prisma.globalEventSummaryWork.create({ data: {
      eventId: event.id,
      userId: accounts[index].user.id,
      status: "WAITING_SYNC",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      requiredRaceCount: 1,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id,
      raceId: race.id,
      userId: accounts[index].user.id,
      status: "PENDING",
      attributionVersion: 2,
    } });
  }
  await prisma.userScoringInputVersion.createMany({
    data: accounts.map((account) => ({ userId: account.user.id, generation: 1n })),
  });
  await prisma.stepSample.createMany({
    data: accounts.flatMap((account, index) => [0, 1, 2].map((part) => ({
      userId: account.user.id,
      periodStart: new Date(startsAt.getTime() + part * 2 * 60_000),
      periodEnd: new Date(startsAt.getTime() + (part + 1) * 2 * 60_000),
      steps: 100 + index * 10 + part,
    }))),
  });
  await prisma.step.createMany({
    data: accounts.map((account, index) => ({
      userId: account.user.id,
      date: new Date(`${localDate}T00:00:00.000Z`),
      steps: 1_000 + index,
    })),
  });
  for (let index = 1; index < accounts.length; index += 1) {
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participants[index].id,
      userId: accounts[index].user.id,
      targetUserId: accounts[index - 1].user.id,
      type: "LEECH",
      status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participants[index - 1].id,
      targetUserId: accounts[index - 1].user.id,
      sourceUserId: accounts[index].user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: index % 2 === 0 ? "EXPIRED" : "ACTIVE",
      startsAt,
      expiresAt: endsAt,
      metadata: { ratio: 2, stepsAtExpiry: 500 + index },
    } });
  }
  return { accounts, participants, event, race, startsAt, endsAt, localDate };
}

async function addConnectedRace(fixture, {
  name,
  startedAt,
  endsAt,
  impactIndexes,
  participantIndexes = fixture.accounts.map((_account, index) => index),
}) {
  const race = await prisma.race.create({ data: {
    creatorId: fixture.accounts[participantIndexes[0]].user.id,
    name,
    targetSteps: 100_000,
    status: "ACTIVE",
    startedAt,
    endsAt,
    powerupsEnabled: true,
  } });
  const participants = [];
  for (const index of participantIndexes) {
    const account = fixture.accounts[index];
    participants.push(await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: startedAt,
    } }));
  }
  for (let position = 1; position < participantIndexes.length; position += 1) {
    const sourceIndex = participantIndexes[position];
    const targetIndex = participantIndexes[position - 1];
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participants[position].id,
      userId: fixture.accounts[sourceIndex].user.id,
      targetUserId: fixture.accounts[targetIndex].user.id,
      type: "LEECH",
      status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participants[position - 1].id,
      targetUserId: fixture.accounts[targetIndex].user.id,
      sourceUserId: fixture.accounts[sourceIndex].user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: position % 2 === 0 ? "EXPIRED" : "ACTIVE",
      startsAt: fixture.startsAt,
      expiresAt: fixture.endsAt,
      metadata: { ratio: 2, stepsAtExpiry: 500 + position },
    } });
  }
  await prisma.globalEventRaceImpact.createMany({
    data: impactIndexes.map((index) => ({
      eventId: fixture.event.id,
      raceId: race.id,
      userId: fixture.accounts[index].user.id,
      status: "PENDING",
      attributionVersion: 2,
    })),
  });
  return { race, participants };
}


async function intake(f, index, { steps = 2000, idempotencyKey = randomUUID(), baseUrl = server.baseUrl,
  startsAt = new Date(f.startsAt.getTime() + 6 * 60000), endsAt = f.endsAt,
  date = f.localDate } = {}) {
  return request(baseUrl, "POST", "/steps/sync-v2", {
    token:f.accounts[index].token,
    headers:{"Idempotency-Key":idempotencyKey,"X-Timezone":"UTC","X-Client-Features":CAPABILITIES},
    body:{date,steps,samples:[{periodStart:startsAt.toISOString(),periodEnd:endsAt.toISOString(),
      steps,recordingMethod:"automatic"}]},
  });
}
async function finish(f, index) {
  for (let claim = 0; claim < 120; claim++) {
    const artifact = await prisma.globalEventCaptureArtifact.findFirst({where:{
      eventId:f.event.id,raceId:f.race.id,userId:f.accounts[index].user.id}});
    if (artifact) return inspectArtifact(artifact);
    // Recreate the real worker closure for each claim; no process-local reuse
    // object survives by construction of this test driver.
    await buildGlobalEventSummaryTick({prisma,now:()=>new Date()})();
  }
  assert.fail("capture did not finish within 120 bounded real worker claims");
}
async function capture(f,index,options) {
  const existing = await prisma.globalEventCaptureArtifact.findFirst({where:{
    eventId:f.event.id,raceId:f.race.id,userId:f.accounts[index].user.id}});
  const response = await intake(f,index,options);
  assert.equal(response.status,202);
  if (!existing) {
    assert.equal(await prisma.globalEventCaptureArtifact.count({where:{
      eventId:f.event.id,userId:f.accounts[index].user.id}}),0,
    "HTTP acceptance must not synchronously publish artifacts");
    const [pending] = await prisma.$queryRawUnsafe(
      "SELECT status FROM durable_global_event_capture_requests WHERE work_id=(SELECT id FROM global_event_summary_work WHERE event_id=$1 AND user_id=$2)",
      f.event.id,f.accounts[index].user.id);
    assert.equal(pending?.status,"PENDING");
  }
  return finish(f,index);
}
async function allArtifacts(f,index) {
  const artifacts=await prisma.globalEventCaptureArtifact.findMany({where:{eventId:f.event.id,userId:f.accounts[index].user.id}});
  return Promise.all(artifacts.map(inspectArtifact));
}
async function addWindow(f,{accountIndex,dayOffset,name,sampleBase,daily=true}) {
  const startsAt=new Date(f.startsAt.getTime()+dayOffset*86400000);
  const endsAt=new Date(startsAt.getTime()+600000);
  const localDate=startsAt.toISOString().slice(0,10);
  const event=await prisma.globalStepEvent.create({data:{startsAt,endsAt,multiplier:2,summaryAttributionVersion:2}});
  await prisma.globalStepEventEntitlement.create({data:{eventId:event.id,userId:f.accounts[accountIndex].user.id,
    timezone:"UTC",localDate,startsAt,endsAt,startOutcome:"ACTIVATED_ON_TIME",startProcessedAt:startsAt}});
  await prisma.globalEventSummaryWork.create({data:{eventId:event.id,userId:f.accounts[accountIndex].user.id,
    status:"WAITING_SYNC",expiresAt:new Date(Date.now()+3600000),requiredRaceCount:1}});
  const window={...f,event,startsAt,endsAt,localDate};
  const {race}=await addConnectedRace(window,{name,startedAt:new Date(startsAt.getTime()-600000),
    endsAt:new Date(endsAt.getTime()+1800000),impactIndexes:[accountIndex]});
  window.race=race;
  await prisma.stepSample.createMany({data:f.accounts.map((account,index)=>({userId:account.user.id,
    periodStart:startsAt,periodEnd:new Date(startsAt.getTime()+120000),steps:sampleBase+index}))});
  if (daily) await prisma.step.createMany({data:f.accounts.map((account,index)=>({userId:account.user.id,
    date:new Date(localDate+"T00:00:00.000Z"),steps:sampleBase+index}))});
  return window;
}
async function addLeech(f,sourceIndex,targetIndex,status="EXPIRED") {
  const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,
    participantId:f.participants[sourceIndex].id,userId:f.accounts[sourceIndex].user.id,
    targetUserId:f.accounts[targetIndex].user.id,type:"LEECH",status:"USED"}});
  return prisma.raceActiveEffect.create({data:{raceId:f.race.id,
    targetParticipantId:f.participants[targetIndex].id,targetUserId:f.accounts[targetIndex].user.id,
    sourceUserId:f.accounts[sourceIndex].user.id,powerupId:powerup.id,type:"LEECH",status,
    startsAt:f.startsAt,expiresAt:f.endsAt,metadata:{ratio:2,stepsAtExpiry:500}}});
}
async function removeLeech(f,sourceIndex,targetIndex) {
  await prisma.raceActiveEffect.deleteMany({where:{raceId:f.race.id,
    sourceUserId:f.accounts[sourceIndex].user.id,targetUserId:f.accounts[targetIndex].user.id,type:"LEECH"}});
}
function hasSample(result,index,f,steps) {
  return result.pinnedFacts.samples.some((row)=>row.userId===f.accounts[index].user.id&&row.steps===steps);
}

describe("global-event durable fact reuse contract",()=>{
  before(async()=>{server=await getSharedServer();});
  beforeEach(async()=>{await cleanDatabase();metrics.reset();});

  it("cold capture reads its directed historical dependencies exactly once",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    const result=await capture(f,0);
    await assertCommitted(result,chainIds(f,0));
    assert.equal(result.pinnedFacts.samples.length,7);
    assert.equal(result.pinnedFacts.dailySteps.length,2);
    assert.equal(result.artifact.payload.attributionDeltaSteps,2303);
    assert.ok(!factIds(result).has(f.accounts[7].user.id),"a retained distant chain is not a scoring dependency");
    // CURRENT scans deliberately include the next padded day's 32-day
    // candidates. Seven logical samples are examined twice; two daily rows once.
    assert.equal(measured(SAMPLE_ROWS),14);
    assert.equal(measured(DAILY_ROWS),2);
    await assertPhysicalAccounting();
  });

  it("reports actual physical candidates separately from logical facts and durable version reuse",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    const first=await capture(f,0);
    assert.equal(measured(SAMPLE_ROWS),14);
    assert.equal(measured(DAILY_ROWS),2);
    const before=sourceSnapshot(), roots=await rootCounters();
    const second=await capture(f,1);
    await assertCommitted(second,chainIds(f,1));
    await assertPhysicalAccounting();
    assertOldRootsNotReadAgain(roots,await rootCounters());
    assert.equal(measured(SAMPLE_ROWS)-before.samples,6,
      "only newly required leaf2 has cold source candidates; changed uploader uses its complete journal");
    assert.equal(measured(DAILY_ROWS)-before.daily,1);
    const firstIds=new Set(first.pinnedFacts.roots.filter((root)=>root.user_id===f.accounts[0].user.id).map((root)=>root.id));
    assert.ok(second.pinnedFacts.roots.filter((root)=>root.user_id===f.accounts[0].user.id).every((root)=>firstIds.has(root.id)));
  });

  it("a second uploader reuses unchanged dependencies and prepares only its newly required leaf",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    const before=physicalRows(), roots=await rootCounters();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.equal(physicalRows()-before,7);
    assertOldRootsNotReadAgain(roots,await rootCounters());
  });

  it("retains shared facts when the next uploader reaches a fresh worker",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    const before=physicalRows();
    require("../../src/modules/steps/services/globalEventCaptureFactCache").processGlobalEventCaptureFactCache.clear();
    const result=await capture(f,1); // finish() constructs a new real worker on every claim.
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.equal(physicalRows()-before,7);
  });

  it("ignores a nondependency's outside-window mutation without replaying the historical graph",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    const start=new Date(f.startsAt.getTime()-4*86400000);
    assert.equal((await intake(f,5,{steps:500,startsAt:start,endsAt:new Date(start.getTime()+300000),
      date:start.toISOString().slice(0,10)})).status,202);
    const before=physicalRows();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.equal(physicalRows()-before,7);
    assert.ok(!factIds(result).has(f.accounts[5].user.id));
  });

  it("reuses a real dependency after both distant and same-day outside-window uploads",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    for(const start of [new Date(f.startsAt.getTime()-4*86400000),new Date(f.endsAt.getTime()+1000)]){
      assert.equal((await intake(f,0,{steps:500,startsAt:start,endsAt:new Date(start.getTime()+300000),
        date:start.toISOString().slice(0,10)})).status,202);
    }
    const before=physicalRows();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.equal(physicalRows()-before,7,"real dependency0's unchanged scoring interval must not be read again");
  });

  it("keeps warm-read work flat as sequential uploaders introduce one new directed leaf",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:12,workIndexes:[0,1,2,3,4]});
    await capture(f,0);
    const actual=[], expectedScores=[2334,2365,2396,2427];
    for(const index of [1,2,3,4]){
      const before=physicalRows();
      const result=await capture(f,index,{steps:2000+index});
      actual.push(physicalRows()-before);
      await assertCommitted(result,chainIds(f,index));
      assert.equal(result.artifact.payload.attributionDeltaSteps,expectedScores[index-1]);
    }
    assert.deepEqual(actual,[7,7,7,7],"one new leaf per upload, never the retained whole population");
  });

  it("prepares shared fact versions once when one sync captures multiple race impacts",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await addConnectedRace(f,{name:"Second simultaneous capture race",startedAt:f.race.startedAt,
      endsAt:f.race.endsAt,impactIndexes:[0,1]});
    await prisma.globalEventSummaryWork.updateMany({where:{eventId:f.event.id},data:{requiredRaceCount:2}});
    await capture(f,0);
    const before=physicalRows();
    await capture(f,1);
    const results=await allArtifacts(f,1);
    assert.equal(results.length,2);
    for(const result of results){await assertCommitted(result,chainIds(f,1));assert.equal(result.artifact.payload.attributionDeltaSteps,2333);}
    assert.equal(physicalRows()-before,7,"two race impacts must not duplicate shared source preparation");
    assert.deepEqual(new Set(results[0].pinnedFacts.roots.map((root)=>root.id)),
      new Set(results[1].pinnedFacts.roots.map((root)=>root.id)));
  });

  it("reuses wider prepared roots when a later capture needs only a narrower race window",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await addConnectedRace(f,{name:"Wide first capture race",startedAt:new Date(f.race.startedAt.getTime()-2*86400000),
      endsAt:f.race.endsAt,impactIndexes:[0]});
    await prisma.globalEventSummaryWork.updateMany({where:{eventId:f.event.id,userId:f.accounts[0].user.id},
      data:{requiredRaceCount:2}});
    await capture(f,0);
    const before=physicalRows(), roots=await rootCounters();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(physicalRows()-before,7);
    assertOldRootsNotReadAgain(roots,await rootCounters());
  });

  it("extends earlier coverage for required users without leaking it into narrower artifacts",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    const wideStart=new Date(f.race.startedAt.getTime()-2*86400000);
    const oldStart=new Date(wideStart.getTime()+600000), oldEnd=new Date(oldStart.getTime()+120000);
    const oldDate=oldStart.toISOString().slice(0,10);
    await prisma.stepSample.createMany({data:f.accounts.map((a,i)=>({userId:a.user.id,periodStart:oldStart,periodEnd:oldEnd,steps:700+i}))});
    await prisma.step.createMany({data:f.accounts.map((a,i)=>({userId:a.user.id,date:new Date(oldDate+"T00:00:00.000Z"),steps:700+i}))});
    await capture(f,0);
    const before=physicalRows(), roots=await rootCounters();
    const {race}=await addConnectedRace(f,{name:"Earlier range extension race",startedAt:wideStart,
      endsAt:f.race.endsAt,impactIndexes:[1]});
    await prisma.globalEventSummaryWork.updateMany({where:{eventId:f.event.id,userId:f.accounts[1].user.id},data:{requiredRaceCount:2}});
    await capture(f,1);
    const results=await allArtifacts(f,1);
    assert.equal(results.length,2);
    for(const result of results) await assertCommitted(result,chainIds(f,1));
    const wide=results.find((r)=>r.artifact.raceId===race.id),narrow=results.find((r)=>r.artifact.raceId===f.race.id);
    for(const i of [0,2]){
      assert.ok(hasSample(wide,i,f,700+i),"relevant old sample must be included by extension");
      assert.ok(!hasSample(narrow,i,f,700+i),"old prefix must not leak into narrow artifact");
    }
    assert.ok(!hasSample(wide,6,f,706),"irrelevant distant participant stays excluded even after extension");
    assert.ok(physicalRows()>before,"newly required day versions must actually prepare source inputs");
    assertOldRootsNotReadAgain(roots,await rootCounters());
    await assertNewRootCandidateBudget(roots);
    await assertPhysicalAccounting();
  });

  it("never treats in-range facts as coverage of a disjoint event window",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    await capture(f,0);
    const window=await addWindow(f,{accountIndex:1,dayOffset:-4,name:"Disjoint capture range",sampleBase:800});
    const before=physicalRows(),roots=await rootCounters();
    const result=await capture(window,1,{steps:3000});
    assert.equal(result.artifact.raceId,window.race.id);
    await assertCommitted(result,chainIds(f,1));
    assert.ok(hasSample(result,2,f,802));
    assert.ok(!hasSample(result,2,f,120),"recent sample must not leak into disjoint event");
    assert.ok(!factIds(result).has(f.accounts[6].user.id));
    assert.ok(physicalRows()>before);
    await assertNewRootCandidateBudget(roots);
    await assertPhysicalAccounting();
  });

  it("does not invent coverage for the populated gap between disjoint fills",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    await capture(f,0);
    const old=await addWindow(f,{accountIndex:1,dayOffset:-4,name:"Old disjoint cache window",sampleBase:800,daily:false});
    await capture(old,1,{steps:3000});
    const middle=await addWindow(f,{accountIndex:2,dayOffset:-2,name:"Populated cache coverage gap",sampleBase:900,daily:false});
    const before=physicalRows(),roots=await rootCounters();
    const result=await capture(middle,2,{steps:4000});
    await assertCommitted(result,chainIds(f,2));
    assert.ok(hasSample(result,3,f,903),"real dependency3's uncovered middle must be captured");
    assert.ok(!factIds(result).has(f.accounts[6].user.id),"irrelevant user6 is not required just because its row exists");
    assert.ok(physicalRows()>before,"a middle range without pinned day versions must remain physically cold");
    await assertNewRootCandidateBudget(roots);
    await assertPhysicalAccounting();
  });

  it("does not invalidate directed inputs when an irrelevant participant's generation changes",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    assert.equal((await intake(f,5,{steps:9000})).status,202);
    const before=physicalRows();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.ok(!factIds(result).has(f.accounts[5].user.id));
    assert.equal(physicalRows()-before,7,"a distant changed generation is not a read dependency");
  });

  it("captures a relevant competing source's changed facts and their actual score consequence",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    assert.equal((await intake(f,2,{steps:9000})).status,202);
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.ok(hasSample(result,2,f,9000));
    // User1 has2333 raw event steps. Its competing source2 has9363,
    // draining floor(9363/2)=4681: both2333 and boosted4666 are fully drained.
    assert.equal(result.artifact.payload.attributionDeltaSteps,0);
  });

  it("coalesces concurrent cold captures sharing a directed leaf across independent race fences",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await prisma.globalEventRaceImpact.deleteMany({where:{raceId:f.race.id}});
    await prisma.raceActiveEffect.deleteMany({where:{raceId:f.race.id}});
    await prisma.racePowerup.deleteMany({where:{raceId:f.race.id}});
    await prisma.raceParticipant.deleteMany({where:{raceId:f.race.id}});
    await prisma.race.delete({where:{id:f.race.id}});
    const {race:a}=await addConnectedRace(f,{name:"Concurrent capture race A",startedAt:f.race.startedAt,
      endsAt:f.race.endsAt,participantIndexes:[0,2,3,4,5,6,7],impactIndexes:[0]});
    const {race:b}=await addConnectedRace(f,{name:"Concurrent capture race B",startedAt:f.race.startedAt,
      endsAt:f.race.endsAt,participantIndexes:[1,2,3,4,5,6,7],impactIndexes:[1]});
    const original=captureService.claimEligibleSummaryWork;
    let release;
    const ready=new Promise((resolve)=>{release=resolve;});
    const arrivals=new Set();
    captureService.claimEligibleSummaryWork=async(tx,args)=>{
      arrivals.add(args.userId);if(arrivals.size===2)release();
      await ready;return original(tx,args);
    };
    let first,second,timer;
    try{
      first=capture({...f,race:a},0,{steps:2000});
      second=capture({...f,race:b},1,{steps:2100});
      await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("both HTTP requests did not reach intake barrier")),5000);})]);
      clearTimeout(timer);
      const [one,two]=await Promise.all([first,second]);
      await assertCommitted(one,[f.accounts[0].user.id,f.accounts[2].user.id]);
      await assertCommitted(two,[f.accounts[1].user.id,f.accounts[2].user.id]);
      assert.equal(physicalRows(),25,"two uploaders'9candidate rows each plus one shared leaf's7, not two leaf fills");
      const leaf=(result)=>new Set(result.pinnedFacts.roots.filter((root)=>root.user_id===f.accounts[2].user.id).map((root)=>root.id));
      assert.deepEqual(leaf(one),leaf(two));
      await assertPhysicalAccounting();
    }finally{
      clearTimeout(timer);captureService.claimEligibleSummaryWork=original;release();
      await Promise.allSettled([first,second].filter(Boolean));
    }
  });

  it("does not grow directed membership when a distant retained edge is added",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await removeLeech(f,7,6);
    await capture(f,0);
    await addLeech(f,7,6);
    const before=physicalRows();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.ok(!factIds(result).has(f.accounts[7].user.id));
    assert.equal(physicalRows()-before,7);
  });

  it("adds an actually relevant competing source without replaying retained roots",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    await addLeech(f,7,1);
    const before=physicalRows(),roots=await rootCounters();
    const result=await capture(f,1);
    await assertCommitted(result,[...chainIds(f,1),f.accounts[7].user.id]);
    assert.ok(hasSample(result,7,f,170));
    assert.equal(physicalRows()-before,14,"only newly needed leaves2and7 prepare source candidates");
    assertOldRootsNotReadAgain(roots,await rootCounters());
  });

  it("does not invalidate retained facts when a distant edge is removed",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    await removeLeech(f,7,6);
    const before=physicalRows();
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.ok(!factIds(result).has(f.accounts[7].user.id));
    assert.equal(physicalRows()-before,7);
  });

  it("excludes a formerly required victim after its actual dependency edge is removed",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    await capture(f,0);
    await removeLeech(f,1,0);
    const before=physicalRows(),roots=await rootCounters();
    const result=await capture(f,1);
    await assertCommitted(result,[f.accounts[1].user.id,f.accounts[2].user.id]);
    assert.ok(!result.pinnedFacts.samples.some((row)=>row.userId===f.accounts[0].user.id));
    assert.equal(physicalRows()-before,7);
    assertOldRootsNotReadAgain(roots,await rootCounters());
  });

  it("pins facts and root revisions from one committed snapshot across a held dependency transaction",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0,1,2]});
    await capture(f,0);
    const dependency=f.accounts[1];
    const [beforeRoot]=await prisma.$queryRawUnsafe(
      "SELECT revision::text FROM durable_capture_fact_heads WHERE user_id=$1 AND day=$2::date",dependency.user.id,f.localDate);
    let ready,release;
    const mutationReady=new Promise((resolve)=>{ready=resolve;});
    const mutationReleased=new Promise((resolve)=>{release=resolve;});
    const mutation=prisma.$transaction(async(tx)=>{
      await tx.userScoringInputVersion.update({where:{userId:dependency.user.id},data:{generation:{increment:1n}}});
      await tx.step.update({where:{userId_date:{userId:dependency.user.id,date:new Date(f.localDate+"T00:00:00.000Z")}},
        data:{steps:9000}});
      await tx.stepSample.create({data:{userId:dependency.user.id,
        periodStart:new Date(f.startsAt.getTime()+360000),periodEnd:f.endsAt,steps:9000}});
      ready();await mutationReleased;
    });
    await mutationReady;
    const capturePromise=capture(f,2);
    try{
      const early=await Promise.race([capturePromise,new Promise((resolve)=>setTimeout(()=>resolve(null),200))]);
      if(early){
        assert.equal(early.pinnedFacts.dailySteps.find((row)=>row.userId===dependency.user.id).steps,1001);
        assert.ok(!hasSample(early,1,f,9000));
      }
      release();await mutation;
      const result=early||await capturePromise;
      const daily=result.pinnedFacts.dailySteps.find((row)=>row.userId===dependency.user.id).steps;
      const root=result.pinnedFacts.roots.find((row)=>row.user_id===dependency.user.id&&row.day===f.localDate);
      assert.ok((daily===1001&&root.revision===beforeRoot.revision&&!hasSample(result,1,f,9000))||
        (daily===9000&&BigInt(root.revision)===BigInt(beforeRoot.revision)+2n&&hasSample(result,1,f,9000)),
      "only a complete old or complete new fact/revision pair is allowed");
      const originalFacts=structuredClone(result.pinnedFacts);
      const after=await capture(f,1,{steps:9000});
      await assertCommitted(after,chainIds(f,1));
      assert.ok(hasSample(after,1,f,9000));
      assert.equal(after.pinnedFacts.dailySteps.find((row)=>row.userId===dependency.user.id).steps,9000);
      const originalAgain=await inspectArtifact(result.artifact);
      assert.deepEqual(originalAgain.pinnedFacts.samples,originalFacts.samples);
      assert.deepEqual(originalAgain.pinnedFacts.dailySteps,originalFacts.dailySteps);
    }finally{release();await Promise.allSettled([mutation,capturePromise]);}
  });

  it("does not publish facts or pins from an intake transaction that rolls back",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8});
    const name="reject_capture_"+randomUUID().replaceAll("-","");
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id='${f.accounts[0].user.id}' THEN RAISE EXCEPTION 'intentional intake rollback'; END IF;RETURN NEW;END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON durable_global_event_capture_requests
      FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try{
      assert.ok((await intake(f,0)).status>=500);
      assert.equal(await prisma.globalEventCaptureArtifact.count(),0);
      assert.equal(await prisma.stepSample.count({where:{userId:f.accounts[0].user.id}}),3);
      const [state]=await prisma.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM durable_global_event_capture_requests) AS requests,
        (SELECT count(*)::int FROM durable_capture_fact_pins) AS pins,
        (SELECT count(*)::int FROM durable_capture_fact_roots) AS roots`);
      assert.deepEqual(state,{requests:0,pins:0,roots:0});
    }finally{
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON durable_global_event_capture_requests`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    const result=await capture(f,1);
    await assertCommitted(result,chainIds(f,1));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2333);
    assert.equal(physicalRows(),23,"failed intake leaves all three directed users genuinely cold");
    await assertPhysicalAccounting();
  });

  it("retains accepted immutable inputs when artifact publication rolls back and retries safely",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    const name="reject_artifact_"+randomUUID().replaceAll("-","");
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional publication rollback'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON global_event_capture_artifacts
      FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    assert.equal((await intake(f,0)).status,202);
    try{
      for(let tick=0;tick<20;tick++){
        try{await buildGlobalEventSummaryTick({prisma,now:()=>new Date()})();}
        catch(error){assert.match(error.message,/intentional publication rollback/);}
        const [requestRow]=await prisma.$queryRawUnsafe(
          "SELECT last_error_code FROM durable_global_event_capture_requests WHERE user_id=$1",f.accounts[0].user.id);
        if(requestRow.last_error_code)break;
      }
      assert.equal(await prisma.globalEventCaptureArtifact.count(),0);
      assert.equal(await prisma.stepSample.count({where:{userId:f.accounts[0].user.id}}),4,
        "accepted source upload is not rolled back by later publication failure");
      const [requestRow]=await prisma.$queryRawUnsafe(
        "SELECT status,last_error_code FROM durable_global_event_capture_requests WHERE user_id=$1",f.accounts[0].user.id);
      assert.equal(requestRow.status,"PENDING");assert.ok(requestRow.last_error_code);
    }finally{
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON global_event_capture_artifacts`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
    const before=physicalRows();
    await prisma.$executeRawUnsafe("UPDATE durable_global_event_capture_requests SET available_at=now()");
    const result=await finish(f,0);
    await assertCommitted(result,chainIds(f,0));
    assert.equal(result.artifact.payload.attributionDeltaSteps,2303);
    assert.equal(physicalRows(),before,"publication retry reuses already prepared immutable inputs");
    assert.equal(await prisma.globalEventCaptureArtifact.count(),1);
  });

  it("does not hydrate again when the client retries the same accepted sync",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    const idempotencyKey=randomUUID();
    const first=await capture(f,0,{idempotencyKey});
    const before=physicalRows();
    const second=await capture(f,0,{idempotencyKey});
    assert.equal(physicalRows(),before);
    assert.equal(first.artifact.id,second.artifact.id);
    assert.equal(first.owner.id,second.owner.id);
    assert.deepEqual(first.owner.context.roots,second.owner.context.roots);
    assert.equal(await prisma.globalEventCaptureArtifact.count(),1);
  });

  it("never reuses facts across unrelated user identities",async()=>{
    const first=await createConnectedCaptureFixture({participantCount:4,workIndexes:[0]});
    const one=await capture(first,0);
    const second=await createConnectedCaptureFixture({participantCount:4,workIndexes:[0]});
    const before=physicalRows();
    const two=await capture(second,0);
    await assertCommitted(two,chainIds(second,0));
    assert.equal(physicalRows()-before,16);
    const firstRoots=new Set(one.pinnedFacts.roots.map((root)=>root.id));
    assert.ok(two.pinnedFacts.roots.every((root)=>!firstRoots.has(root.id)));
    assert.equal(two.artifact.payload.attributionDeltaSteps,2303);
  });

  it("does not turn ordinary dependency syncs into capture hydration",async()=>{
    const f=await createConnectedCaptureFixture({participantCount:8,workIndexes:[0]});
    assert.equal((await intake(f,6,{steps:4000})).status,202);
    const [state]=await prisma.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM durable_global_event_capture_requests) AS requests,
      (SELECT count(*)::int FROM durable_capture_fact_pins) AS pins,
      (SELECT count(*)::int FROM durable_capture_fact_roots) AS roots,
      (SELECT count(*)::int FROM durable_capture_fact_journal) AS mutations`);
    assert.deepEqual([state.requests,state.pins,state.roots],[0,0,0]);
    assert.ok(state.mutations>0,"source journaling is expected; source hydration is not");
    assert.equal(metrics.snapshot().histograms[SAMPLE_ROWS],undefined);
    assert.equal(metrics.snapshot().histograms[DAILY_ROWS],undefined);
  });
});
