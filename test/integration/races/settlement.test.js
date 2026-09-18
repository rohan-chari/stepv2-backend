// Canonical lean integration suite.


// ---- consolidated from team-races-10v10-settlement.test.js ----
(function team_races_10v10_settlement_test_js(){
const assert = require('node:assert/strict');
const {describe,it,before,beforeEach}=require('node:test');
process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const {cleanDatabase,prisma,request,getSharedServer,createTestUser}=require('../setup');
// Settlement is worker-owned with no HTTP trigger: exercise the real scheduled
// entrypoint, then assert only public HTTP result/balance views plus SQL metrics.
const {resolveExpiredRaces}=require('../../../src/modules/races/jobs/raceExpiry');
const HEADERS={'X-Client-Features':'characters,team_races,team_races_10v10_v1,race_participants_paging,race_leave'};
let server,queries=null;
async function get(actor,path,headers=HEADERS){
 const r=await request(server.baseUrl,'GET',path,{token:actor.token,headers});
 const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;
}
describe('10v10 settlement public results and worker cost',()=>{
 before(async()=>{server=await getSharedServer();prisma.$on('query',event=>{if(queries)queries.push(event.query);});});
 beforeEach(cleanDatabase);
 for(const size of [5,10])for(const tie of [false,true])it(`${size}v${size} ${tie?'tie':'win'} pays every eligible member once and exposes full final roster`,async()=>{
  const actors=[];
  for(let i=0;i<2*size;i++)actors.push(await createTestUser());
  const startedAt=new Date(Date.now()-7*86400000),finishedAt=new Date(Date.now()-120000);
  const race=await prisma.race.create({data:{name:'Large settlement fixture',creatorId:actors[0].user.id,targetSteps:0,status:'ACTIVE',isPublic:true,timeBased:true,maxParticipants:size*2,maxDurationDays:7,payoutPreset:'WINNER_TAKES_ALL',fundedPrize:true,prizeCalculationVersion:2,prizeCoinUnit:10,prizePoolMaxCoins:8000,payoutRoundingVersion:1,isTeamRace:true,teamSize:size,teamAName:'Alpha',teamBName:'Bravo',teamPoolMultBps:15000,teamPayoutVersion:1,teamWinnerRewardCoins:500,startedAt,endsAt:new Date(Date.now()-60000)}});
  await prisma.raceParticipant.createMany({data:actors.map((a,i)=>({raceId:race.id,userId:a.user.id,status:'ACCEPTED',team:i<size?'TEAM_A':'TEAM_B',totalSteps:tie||i<size?1000:100,rawSteps:tie||i<size?1000:100,finishTotalSteps:tie||i<size?1000:100,finishedAt,joinedAt:startedAt}))});
  queries=[];const begin=performance.now();await resolveExpiredRaces();const elapsedMs=performance.now()-begin;const measured=queries;queries=null;
  const sql={SELECT:0,INSERT:0,UPDATE:0,DELETE:0,OTHER:0};for(const q of measured){const kind=q.trim().match(/^(SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase()||'OTHER';sql[kind]++;}
  console.log('TEAM10_SETTLEMENT_METRIC',JSON.stringify({size,tie,elapsedMs:Number(elapsedMs.toFixed(2)),queries:measured.length,sql,coinWrites:measured.filter(q=>/INSERT INTO "(?:public"\.")?coin_transactions"/.test(q)).length}));
  const detail=await get(actors[0],`/races/${race.id}?view=participants-v1&limit=1`);
  assert.equal(detail.status,'COMPLETED');assert.equal(detail.winnerTeam,tie?null:'TEAM_A');
  assert.equal(detail.teamRosterComplete,true);assert.equal(detail.teamAcceptedParticipants.length,size*2);
  assert.equal(detail.teamPayoutVersion,1);assert.equal(detail.teamWinnerRewardCoins,500);
  assert.equal(detail.prizePool.coins,size*500);
  for(let i=0;i<actors.length;i++){
    const me=await get(actors[i],'/auth/me');
    assert.equal((me.user||me).coins,tie?250:i<size?500:0,JSON.stringify(me));
  }
  const progress=(await get(actors[0],`/races/${race.id}/progress?view=participants-v1&limit=1`)).progress;
  assert.equal(progress.participants.length,size*2);assert.equal(progress.prizePool.coins,size*500);
  assert.equal(progress.teams.teamA.totalSteps,size*1000);assert.equal(progress.teams.teamB.totalSteps,size*(tie?1000:100));
  await resolveExpiredRaces();
  for(let i=0;i<actors.length;i++)assert.equal(((await get(actors[i],'/auth/me')).user||{}).coins,tie?250:i<size?500:0);
  const legacy=await get(actors[0],'/races',{'X-Client-Features':'characters,team_races,race_leave'});
  assert.ok(legacy.completed.some(r=>r.id===race.id),'downgrade keeps earned result card');
 });
});

})();


// ---- consolidated from fixed-team-winner-payouts.test.js ----
(function fixed_team_winner_payouts_test_js(){
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("../setup");
const { appSettings } = require("../../../src/shared/config/appSettings");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const {
  buildRaceAdminCommandWorker,
} = require("../../../src/modules/races/jobs/raceAdminCommandRunner");
const {
  buildCompleteRace,
  completeRace,
} = require("../../../src/modules/races/commands/completeRace");
const { awardCoins } = require("../../../src/shared/economy/awardCoins");

const TEAM_HEADERS = { "X-Client-Features": "characters,team_races" };
const ALL_COMPETITION_HEADERS = {
  "X-Client-Features": "characters,team_races,tournaments",
};

let server;
let seq = 0;
const execFileAsync = promisify(execFile);

async function makeUser() {
  const { user, token } = await createTestUser({
    appleId: `apple-fixed-team-${++seq}`,
    email: `fixed-team-${seq}@example.com`,
  });
  return { userId: user.id, token };
}

function req(method, path, { body, token, headers } = {}) {
  return request(server.baseUrl, method, path, { body, token, headers });
}

async function createTeamRace({ token, durationDays, name }) {
  await req("GET", "/auth/me", { token, headers: TEAM_HEADERS });
  const response = await req("POST", "/races", {
    token,
    headers: TEAM_HEADERS,
    body: {
      name,
      maxDurationDays: durationDays,
      isTeamRace: true,
      teamSize: 5,
      isPublic: true,
    },
  });
  assert.equal(response.status, 201);
  return (await response.json()).race;
}

async function seedFixedTeamRace({
  durationDays = 7,
  rewardCoins = 500,
  teamSize = 5,
  payoutRoundingVersion = 1,
  teamPayoutVersion = 1,
} = {}) {
  return prisma.race.create({
    data: {
      name: `Fixed settlement ${durationDays}d`,
      targetSteps: 0,
      status: "ACTIVE",
      isPublic: true,
      timeBased: true,
      maxParticipants: teamSize * 2,
      maxDurationDays: durationDays,
      payoutPreset: "WINNER_TAKES_ALL",
      fundedPrize: true,
      prizeCalculationVersion: 2,
      prizeCoinUnit: 10,
      prizePoolMaxCoins: 8000,
      payoutRoundingVersion,
      isTeamRace: true,
      teamSize,
      teamAName: "Reds",
      teamBName: "Blues",
      teamPoolMultBps: 15000,
      teamPayoutVersion,
      teamWinnerRewardCoins: rewardCoins,
      startedAt: new Date(Date.now() - durationDays * 86_400_000),
      endsAt: new Date(Date.now() - 60_000),
    },
  });
}

async function addMembers(race, members) {
  const users = [];
  for (let index = 0; index < members.length; index++) {
    const member = members[index];
    const user = await makeUser();
    users.push(user);
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.userId,
        status: "ACCEPTED",
        team: member.team,
        totalSteps: member.steps,
        rawSteps: member.steps,
        finishTotalSteps: member.steps,
        finishedAt: new Date(Date.now() - 120_000),
        forfeitedAt: member.forfeited ? new Date(Date.now() - 180_000) : null,
        joinedAt: new Date(race.startedAt.getTime() + index * 1000),
      },
    });
  }
  return users;
}

async function coinsOf(userId) {
  return (await prisma.user.findUnique({ where: { id: userId } })).coins;
}

async function poolLedger(raceId) {
  return prisma.coinTransaction.findMany({
    where: {
      reason: "race_prize_pool_payout",
      refId: { startsWith: `${raceId}:` },
    },
  });
}

describe("fixed team-winner payouts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("teamRacesEnabled", true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  after(async () => {
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("teamRacesEnabled", true);
    await appSettings.setFlag("payoutRoundingV1Enabled", true);
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  it("stamps and projects the approved immutable reward in every duration band", async () => {
    const bands = [
      [1, 100],
      [3, 200],
      [7, 500],
      [8, 1000],
      [14, 1000],
      [30, 1000],
    ];

    for (const [durationDays, reward] of bands) {
      const creator = await makeUser();
      const race = await createTeamRace({
        token: creator.token,
        durationDays,
        name: `Fixed team ${durationDays}d`,
      });

      const stamps = await prisma.$queryRawUnsafe(
        `SELECT team_payout_version AS "teamPayoutVersion",
                team_winner_reward_coins AS "teamWinnerRewardCoins"
           FROM races
          WHERE id = $1`,
        race.id,
      );
      assert.deepEqual(stamps, [{
        teamPayoutVersion: 1,
        teamWinnerRewardCoins: reward,
      }]);

      const detailResponse = await req("GET", `/races/${race.id}`, {
        token: creator.token,
        headers: TEAM_HEADERS,
      });
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json();
      assert.equal(detail.teamPayoutVersion, 1);
      assert.equal(detail.teamWinnerRewardCoins, reward);
      assert.equal(detail.prizePool.coins, reward);
      assert.equal(detail.projectedPotCoins, reward);
      assert.deepEqual(detail.payouts, {
        first: reward,
        second: 0,
        third: 0,
      });
      assert.deepEqual(detail.payoutTiers, [
        { placement: 1, amount: reward },
      ]);
    }
  });

  it("keeps non-team funded races unstamped", async () => {
    const creator = await makeUser();
    await req("GET", "/auth/me", { token: creator.token });
    const response = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Solo unchanged", maxDurationDays: 7, isPublic: true },
    });
    assert.equal(response.status, 201);
    const race = (await response.json()).race;
    const stamps = await prisma.$queryRawUnsafe(
      `SELECT team_payout_version AS "teamPayoutVersion",
              team_winner_reward_coins AS "teamWinnerRewardCoins"
         FROM races
        WHERE id = $1`,
      race.id,
    );
    assert.deepEqual(stamps, [{
      teamPayoutVersion: null,
      teamWinnerRewardCoins: null,
    }]);

    const detailResponse = await req("GET", `/races/${race.id}`, {
      token: creator.token,
    });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.teamPayoutVersion, null);
    assert.equal(detail.teamWinnerRewardCoins, null);
  });

  it("projects every established HTTP surface from the same 7-day stamp", async () => {
    await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
    const creator = await makeUser();
    const race = await createTeamRace({
      token: creator.token,
      durationDays: 7,
      name: "Every surface fixed",
    });
    const expectedPayouts = { first: 500, second: 0, third: 0 };
    const expectedTiers = [{ placement: 1, amount: 500 }];

    const detail = await (await req("GET", `/races/${race.id}`, {
      token: creator.token,
      headers: TEAM_HEADERS,
    })).json();
    assert.equal(detail.teamPayoutVersion, 1);
    assert.equal(detail.teamWinnerRewardCoins, 500);
    assert.equal(detail.prizePool.coins, 500);
    assert.deepEqual(detail.payouts, expectedPayouts);
    assert.deepEqual(detail.payoutTiers, expectedTiers);

    const list = await (await req("GET", "/races", {
      token: creator.token,
      headers: TEAM_HEADERS,
    })).json();
    const listed = list.pending.find((entry) => entry.id === race.id);
    assert.equal(listed.teamPayoutVersion, 1);
    assert.equal(listed.teamWinnerRewardCoins, 500);
    assert.equal(listed.prizePool.coins, 500);
    assert.deepEqual(listed.payouts, expectedPayouts);
    assert.deepEqual(listed.payoutTiers, expectedTiers);

    const progress = (await (await req("GET", `/races/${race.id}/progress`, {
      token: creator.token,
      headers: TEAM_HEADERS,
    })).json()).progress;
    assert.equal(progress.teamPayoutVersion, 1);
    assert.equal(progress.teamWinnerRewardCoins, 500);
    assert.equal(progress.prizePool.coins, 500);
    assert.deepEqual(progress.payouts, expectedPayouts);
    assert.deepEqual(progress.payoutTiers, expectedTiers);

    const viewer = await makeUser();
    const publicBody = await (await req("GET", "/races/public", {
      token: viewer.token,
      headers: TEAM_HEADERS,
    })).json();
    const publicRace = publicBody.races.find((entry) => entry.id === race.id);
    assert.equal(publicRace.teamPayoutVersion, 1);
    assert.equal(publicRace.teamWinnerRewardCoins, 500);
    assert.equal(publicRace.prizePool.coins, 500);
    assert.deepEqual(publicRace.payouts, expectedPayouts);
    assert.deepEqual(publicRace.payoutTiers, expectedTiers);

    await prisma.race.update({
      where: { id: race.id },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 86_400_000),
      },
    });
    const home = await (await req("GET", "/home/race-card", {
      token: creator.token,
      headers: TEAM_HEADERS,
    })).json();
    assert.equal(home.data.teamPayoutVersion, 1);
    assert.equal(home.data.teamWinnerRewardCoins, 500);

    const linkResponse = await req("POST", `/races/${race.id}/share-link`, {
      token: creator.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(linkResponse.status, 201);
    const { shareToken } = await linkResponse.json();
    const previewResponse = await req("GET", `/races/share/${shareToken}`);
    assert.equal(previewResponse.status, 200);
    const previewBody = await previewResponse.json();
    const preview = previewBody.race || previewBody;
    assert.equal(preview.teamPayoutVersion, 1);
    assert.equal(preview.teamWinnerRewardCoins, 500);
  });

  it("settles a 7-day 5v5 at 500 per eligible winner and 2500 total", async () => {
    const race = await seedFixedTeamRace();
    const users = await addMembers(race, [
      ...[0, 1, 2, 3, 4].map((i) => ({ team: "TEAM_A", steps: 1000 - i })),
      ...[0, 1, 2, 3, 4].map((i) => ({ team: "TEAM_B", steps: 100 + i })),
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.status, "COMPLETED");
    assert.equal(settled.winnerTeam, "TEAM_A");
    assert.equal(settled.prizePoolCoins, 2500);
    assert.equal(settled.potCoins, 2500);
    for (const winner of users.slice(0, 5)) {
      assert.equal(await coinsOf(winner.userId), 500);
    }
    for (const loser of users.slice(5)) {
      assert.equal(await coinsOf(loser.userId), 0);
    }
    const ledger = await poolLedger(race.id);
    assert.equal(ledger.length, 5);
    assert.equal(ledger.reduce((sum, row) => sum + row.amount, 0), 2500);

    const detail = await (await req("GET", `/races/${race.id}`, {
      token: users[0].token,
      headers: TEAM_HEADERS,
    })).json();
    const list = await (await req("GET", "/races", {
      token: users[0].token,
      headers: TEAM_HEADERS,
    })).json();
    const listed = list.completed.find((entry) => entry.id === race.id);
    const progress = (await (await req("GET", `/races/${race.id}/progress`, {
      token: users[0].token,
      headers: TEAM_HEADERS,
    })).json()).progress;
    for (const payload of [detail, listed, progress]) {
      assert.equal(payload.teamPayoutVersion, 1);
      assert.equal(payload.teamWinnerRewardCoins, 500);
      assert.equal(payload.prizePool.coins, 2500);
      assert.equal(payload.prizePool.projected, false);
      assert.deepEqual(payload.payoutTiers, [
        { placement: 1, amount: 500 },
        { placement: 2, amount: 500 },
        { placement: 3, amount: 500 },
        { placement: 4, amount: 500 },
        { placement: 5, amount: 500 },
      ]);
    }
  });

  it("does not redistribute a forfeited winner's fixed share", async () => {
    const race = await seedFixedTeamRace({ teamSize: 2 });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 1000 },
      { team: "TEAM_A", steps: 900, forfeited: true },
      { team: "TEAM_B", steps: 100 },
      { team: "TEAM_B", steps: 100 },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.prizePoolCoins, 500);
    assert.equal(await coinsOf(users[0].userId), 500);
    assert.equal(await coinsOf(users[1].userId), 0);
    assert.deepEqual((await poolLedger(race.id)).map((row) => row.amount), [500]);
  });

  it("pays half rewards on a zero-step tie and preserves the accepted risk decision", async () => {
    const race = await seedFixedTeamRace({
      durationDays: 1,
      rewardCoins: 100,
      teamSize: 1,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 0 },
      { team: "TEAM_B", steps: 0 },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.winnerTeam, null);
    assert.equal(settled.prizePoolCoins, 100);
    assert.equal(await coinsOf(users[0].userId), 50);
    assert.equal(await coinsOf(users[1].userId), 50);
  });

  it("pays half only to each non-forfeited member on an asymmetric tie", async () => {
    const race = await seedFixedTeamRace({ teamSize: 2 });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 100 },
      { team: "TEAM_A", steps: 100 },
      { team: "TEAM_B", steps: 100 },
      { team: "TEAM_B", steps: 100, forfeited: true },
    ]);

    await resolveExpiredRaces();

    const settled = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(settled.winnerTeam, null);
    assert.equal(settled.prizePoolCoins, 750);
    assert.deepEqual(
      await Promise.all(users.map((user) => coinsOf(user.userId))),
      [250, 250, 250, 0],
    );
  });

  it("pays a zero-step teammate when their team wins, with no personal-step gate", async () => {
    const race = await seedFixedTeamRace({ teamSize: 2 });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 1 },
      { team: "TEAM_A", steps: 0 },
      { team: "TEAM_B", steps: 0 },
      { team: "TEAM_B", steps: 0 },
    ]);

    await resolveExpiredRaces();

    assert.equal(await coinsOf(users[0].userId), 500);
    assert.equal(await coinsOf(users[1].userId), 500);
    assert.equal((await prisma.race.findUnique({ where: { id: race.id } })).prizePoolCoins, 1000);
  });

  it("falls back to the legacy divisible pool for partial or malformed stamps", async () => {
    const race = await seedFixedTeamRace({
      durationDays: 1,
      rewardCoins: null,
      teamSize: 1,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 10 },
      { team: "TEAM_B", steps: 1 },
    ]);

    await resolveExpiredRaces();

    // V2 legacy math: 2 walkers x 1 point x 10 coins x 1.5 multiplier.
    assert.equal((await prisma.race.findUnique({ where: { id: race.id } })).prizePoolCoins, 30);
    assert.equal(await coinsOf(users[0].userId), 30);
    const detail = await (await req("GET", `/races/${race.id}`, {
      token: users[0].token,
      headers: TEAM_HEADERS,
    })).json();
    assert.equal(detail.teamPayoutVersion, null);
    assert.equal(detail.teamWinnerRewardCoins, null);
  });

  it("normalizes partial stamps on edit and start mutation payloads", async () => {
    const creator = await makeUser();
    const opponent = await makeUser();
    const race = await prisma.race.create({
      data: {
        creatorId: creator.userId,
        name: "Partial mutation stamp",
        targetSteps: 0,
        status: "PENDING",
        isPublic: true,
        timeBased: true,
        maxParticipants: 2,
        maxDurationDays: 1,
        payoutPreset: "WINNER_TAKES_ALL",
        fundedPrize: true,
        prizeCalculationVersion: 2,
        prizeCoinUnit: 10,
        prizePoolMaxCoins: 8000,
        payoutRoundingVersion: 1,
        isTeamRace: true,
        teamSize: 1,
        teamAName: "Reds",
        teamBName: "Blues",
        teamPoolMultBps: 15000,
        teamPayoutVersion: 1,
        teamWinnerRewardCoins: null,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        {
          raceId: race.id,
          userId: creator.userId,
          status: "ACCEPTED",
          team: "TEAM_A",
        },
        {
          raceId: race.id,
          userId: opponent.userId,
          status: "ACCEPTED",
          team: "TEAM_B",
        },
      ],
    });

    const edit = await req("PATCH", `/races/${race.id}`, {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: { name: "Partial mutation renamed" },
    });
    assert.equal(edit.status, 200);
    const edited = (await edit.json()).race;
    assert.equal(edited.teamPayoutVersion, null);
    assert.equal(edited.teamWinnerRewardCoins, null);

    const start = await req("POST", `/races/${race.id}/start`, {
      token: creator.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(start.status, 200);
    const started = (await start.json()).race;
    assert.equal(started.teamPayoutVersion, null);
    assert.equal(started.teamWinnerRewardCoins, null);
    const stored = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(stored.teamPayoutVersion, 1, "normalization is wire-only");
    assert.equal(stored.teamWinnerRewardCoins, null);
  });

  it("recovery is idempotent for the fixed ledger and participant payout", async () => {
    const race = await seedFixedTeamRace({ teamSize: 1 });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 10 },
      { team: "TEAM_B", steps: 1 },
    ]);
    await resolveExpiredRaces();
    await resolveExpiredRaces();

    assert.equal((await poolLedger(race.id)).length, 1);
    assert.equal(await coinsOf(users[0].userId), 500);
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: users[0].userId } },
    });
    assert.equal(participant.payoutCoins, 500);
  });

  it("recovers an exact fixed payout crash when legacy rounding is disabled", async () => {
    const race = await seedFixedTeamRace({
      teamSize: 2,
      payoutRoundingVersion: 0,
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 10 },
      { team: "TEAM_A", steps: 9 },
      { team: "TEAM_B", steps: 1 },
      { team: "TEAM_B", steps: 1 },
    ]);
    let crashAfterCredit = true;
    const crashOnce = buildCompleteRace({
      awardCoins: async (input) => {
        const outcome = await awardCoins(input);
        if (crashAfterCredit && outcome.awarded) {
          crashAfterCredit = false;
          throw new Error("simulated fixed payout crash after durable credit");
        }
        return outcome;
      },
    });

    await assert.rejects(
      crashOnce({
        raceId: race.id,
        winnerTeam: "TEAM_A",
        participantUserIds: users.map((user) => user.userId),
      }),
      /simulated fixed payout crash/,
    );
    await completeRace({
      raceId: race.id,
      winnerTeam: "TEAM_A",
      participantUserIds: users.map((user) => user.userId),
    });

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { joinedAt: "asc" },
    });
    assert.deepEqual(participants.map((row) => row.payoutCoins), [500, 500, 0, 0]);
    assert.equal((await poolLedger(race.id)).length, 2);
    const completed = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(completed.prizePoolCoins, 1000);
    assert.equal(completed.potCoins, 1000);
  });

  it("uses the persisted fixed award as the payout-double base", async () => {
    const previousPrepare = process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED;
    const previousClaim = process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED;
    const previousAdUnits = process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS;
    process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = "true";
    process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = "true";
    process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS =
      "ca-app-pub-3940256099942544/5224354917";
    try {
      await prisma.appSetting.upsert({
        where: { key: "racePayoutDoubleRolloutPercent" },
        create: { key: "racePayoutDoubleRolloutPercent", value: 100 },
        update: { value: 100 },
      });
      appSettings.bustCache();
      const race = await seedFixedTeamRace({ teamSize: 1 });
      const users = await addMembers(race, [
        { team: "TEAM_A", steps: 10 },
        { team: "TEAM_B", steps: 1 },
      ]);
      await resolveExpiredRaces();

      const body = await (await req("GET", "/races", {
        token: users[0].token,
        headers: {
          "X-Client-Features":
            "characters,team_races,race_payout_double,race_payout_flat_50",
        },
      })).json();
      assert.equal(body.payoutDoubleOffer.baseCoins, 500);
      assert.deepEqual(body.payoutDoubleOffer.raceIds, [race.id]);
    } finally {
      if (previousPrepare == null) {
        delete process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED;
      } else {
        process.env.ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED = previousPrepare;
      }
      if (previousClaim == null) {
        delete process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED;
      } else {
        process.env.ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED = previousClaim;
      }
      if (previousAdUnits == null) {
        delete process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS;
      } else {
        process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS = previousAdUnits;
      }
    }
  });

  it("atomically rejects a twenty-first simultaneous user-created competition", async () => {
    const creator = await makeUser();
    for (let index = 0; index < 20; index++) {
      await createTeamRace({
        token: creator.token,
        durationDays: 1,
        name: `Active slot ${index + 1}`,
      });
    }

    const twentyFirst = await req("POST", "/races", {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: {
        name: "Active slot twenty-one",
        maxDurationDays: 1,
        isTeamRace: true,
        teamSize: 1,
      },
    });
    assert.equal(twentyFirst.status, 409);
    assert.deepEqual(await twentyFirst.json(), {
      error: "You can have up to 20 active competitions at a time.",
      code: "ACTIVE_COMPETITION_LIMIT",
      limit: 20,
      current: 20,
    });
    assert.equal(await prisma.raceParticipant.count({
      where: { userId: creator.userId, status: "ACCEPTED" },
    }), 20);
  });

  it("serializes concurrent twentieth-vs-twenty-first race/tournament admission across types", async () => {
    const creator = await makeUser();
    await req("GET", "/races", {
      token: creator.token,
      headers: ALL_COMPETITION_HEADERS,
    });
    for (let index = 0; index < 19; index++) {
      await createTeamRace({
        token: creator.token,
        durationDays: 1,
        name: `Cross-type slot ${index + 1}`,
      });
    }

    const [raceResponse, tournamentResponse] = await Promise.all([
      req("POST", "/races", {
        token: creator.token,
        headers: ALL_COMPETITION_HEADERS,
        body: {
          name: "Concurrent twentieth race",
          maxDurationDays: 1,
          isTeamRace: true,
          teamSize: 1,
        },
      }),
      req("POST", "/tournaments", {
        token: creator.token,
        headers: ALL_COMPETITION_HEADERS,
        body: {
          name: "Concurrent twentieth cup",
          bracketSize: 4,
          matchupDurationDays: 2,
          buyInAmount: 0,
          isPublic: true,
        },
      }),
    ]);
    assert.deepEqual(
      [raceResponse.status, tournamentResponse.status].sort(),
      [201, 409],
    );
    const rejected = raceResponse.status === 409
      ? raceResponse
      : tournamentResponse;
    assert.deepEqual(await rejected.json(), {
      error: "You can have up to 20 active competitions at a time.",
      code: "ACTIVE_COMPETITION_LIMIT",
      limit: 20,
      current: 20,
    });
    const [raceCount, tournamentCount] = await Promise.all([
      prisma.raceParticipant.count({
        where: {
          userId: creator.userId,
          status: "ACCEPTED",
          race: { tournamentId: null },
        },
      }),
      prisma.tournamentParticipant.count({
        where: { userId: creator.userId, status: "ACCEPTED" },
      }),
    ]);
    assert.equal(raceCount + tournamentCount, 20);
  });
});

})();


// ---- consolidated from race-queue-v2-settlement-parity.test.js ----
(function race_queue_v2_settlement_parity_test_js(){
// C0 — settlement parity and expiry/worker mutual exclusion
// (docs/redis-derived-data-layer-requirements.md §5a items 5-6, test plan 5a).
//
// The acceptance question this file answers: does a race whose standings were
// maintained ENTIRELY by the race-keyed worker settle to the same placements and
// the same payouts as a control race resolved the old way (inline, via the
// `inlineRaceResolutionFallback` lever)? If C0 changed a single settled coin the
// whole change is unshippable, so the assertion is a full lifecycle — create ->
// syncs -> powerup -> expiry -> completeRace — run twice over identical inputs.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  RaceResolutionJobV2,
} = require("../../../src/modules/races/models/raceResolutionJobV2");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const { appSettings } = require("../../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-c0p-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendship = (await sendRes.json()).friendship;
  if (!friendship) return;
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(owner, others, name) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
    },
    token: owner.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: owner.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token,
  });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  return {
    periodStart: new Date(end.getTime() - HOUR_MS).toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

async function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
  });
}

function makeWorker(overrides = {}) {
  return buildRaceResolutionWorkerV2({ bootAt: 0, ...overrides });
}

async function drain(worker = makeWorker(), maxJobs = 50) {
  for (let i = 0; i < maxJobs; i++) {
    if (!(await worker.processOne())) break;
  }
}

// Grant a powerup directly and use it through the real endpoint, so the
// lifecycle exercises the enqueue-after-powerup seam.
async function useProteinShake(user, raceId) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
    select: { id: true },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/use`, {
    body: { powerupId: powerup.id },
    token: user.token,
  });
}

// The observable settlement outcome: who placed where, with what total, and how
// many coins each racer walked away with.
async function settlementOutcome(raceId, users) {
  const participants = await prisma.raceParticipant.findMany({
    where: { raceId },
    orderBy: { placement: "asc" },
    select: { userId: true, placement: true, totalSteps: true },
  });
  const race = await prisma.race.findUnique({
    where: { id: raceId },
    select: { status: true, winnerUserId: true },
  });
  const byName = new Map(users.map((u) => [u.userId, u.displayName]));
  const coins = [];
  for (const u of users) {
    const row = await prisma.user.findUnique({
      where: { id: u.userId },
      select: { coins: true },
    });
    coins.push([u.displayName, row.coins]);
  }
  return {
    status: race.status,
    winner: byName.get(race.winnerUserId) ?? null,
    standings: participants.map((p) => ({
      name: byName.get(p.userId),
      placement: p.placement,
      totalSteps: p.totalSteps,
    })),
    coins: coins.sort(),
  };
}

before(async () => {
  server = await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

after(async () => {
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

// One full lifecycle over identical inputs. `queued` selects which side of the
// C0 change drives standings: the race-keyed worker, or the old inline path
// restored by the rollback lever.
async function runLifecycle({ queued }) {
  await appSettings.setFlag("inlineRaceResolutionFallback", !queued);

  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const cara = await createUser("Cara");
  const raceId = await createActiveRace(alice, [bob, cara], "Lifecycle");

  // Deterministic, identical step history on both sides.
  await postSamples(alice, [sampleAt(6, 3000), sampleAt(5, 2500)]);
  await postSamples(bob, [sampleAt(6, 1800), sampleAt(5, 1500)]);
  await postSamples(cara, [sampleAt(6, 900), sampleAt(5, 700)]);

  await useProteinShake(bob, raceId);

  if (queued) await drain();

  // Expire and settle through the real cron entry point.
  await prisma.race.update({
    where: { id: raceId },
    data: { endsAt: new Date(Date.now() - 60 * 1000) },
  });
  await resolveExpiredRaces();

  return settlementOutcome(raceId, [alice, bob, cara]);
}

describe("settlement parity — queue-maintained vs inline-maintained", () => {
  });

describe("5a — raceExpiry vs a live worker are mutually exclusive", () => {
  it("concurrent settlement and live resolution on one race never interleave, and the settled standings stand", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Expiry vs worker");

    await postSamples(alice, [sampleAt(6, 5000)]);
    await postSamples(bob, [sampleAt(6, 2000)]);
    await drain();

    // Both writers are made eligible at the same instant: the race is past its
    // end AND its job row is dirty.
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await postSamples(alice, [sampleAt(5, 4000)]);

    const outcomes = await Promise.allSettled([
      resolveExpiredRaces(),
      drain(),
      drain(makeWorker()),
    ]);
    for (const o of outcomes) {
      assert.equal(
        o.status,
        "fulfilled",
        `no writer may fail: ${o.reason && o.reason.message}`
      );
    }

    // Settlement won the race to a conclusion: placements are set and the
    // live worker did not resurrect the race or scramble the standings.
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
      select: { userId: true, placement: true },
    });
    assert.deepEqual(
      participants.map((p) => p.placement),
      [1, 2]
    );
    assert.equal(participants[0].userId, alice.userId);

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      select: { status: true },
    });
    assert.equal(race.status, "COMPLETED");

    // Post-settlement the worker is a no-op: resolveRaceState refuses to
    // live-resolve a race past endsAt, so nothing can un-settle it.
    await RaceResolutionJobV2.enqueue({ raceId, userId: alice.userId });
    await drain();
    const after = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
      select: { placement: true },
    });
    assert.deepEqual(
      after.map((p) => p.placement),
      [1, 2]
    );
  });
});

})();


// ---- consolidated from team-only-drop-pool.test.js ----
(function team_only_drop_pool_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { balanceConfig } = require("../../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../../src/modules/economy/balanceConfig.defaults");

// Team-only drop pool (docs/team-only-drop-pool-requirements.md), tests §9.1–§9.7.
//
// Everything here runs through the real HTTP endpoints. The whole risk in this
// change is that ONE of the four roll/disclosure paths (single open, batch open,
// odds sheet, purchase) forgets a gate the others apply, so asserting the roller
// directly would prove nothing — the divergence IS the bug.
//
// The two gates under test:
//   * teamOnlyTypes — RALLY_FLAG may only drop in a TEAM race;
//   * powerups5     — RALLY_FLAG may only drop for a client advertising the
//                     `powerups5` X-Client-Features token (compat gate: a frozen
//                     binary that rolls one gets UPDATE_REQUIRED at use time).

let server;
let nextAppleId = 0;

// A modern 2.0.x-style client. `characters`/`team_races` are what the race
// surfaces need; `powerups5` is the token under test.
const P5_HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };
// An App-Store-frozen client (1.6.x–1.7.x): team races, but NO powerups5.
const OLD_HEADERS = { "X-Client-Features": "characters,team_races" };

async function createUser(displayName, headers = undefined) {
  const appleId = `apple-teamonly-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
      headers,
    });
  }
  return { userId: body.user.id, token };
}

async function makeFriends(a, b, headers = undefined) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers,
  });
  const sendBody = await sendRes.json();
  if (!sendBody.friendship) {
    throw new Error(`friend request failed: ${sendRes.status} ${JSON.stringify(sendBody)}`);
  }
  await request(server.baseUrl, "PUT", `/friends/request/${sendBody.friendship.id}`, {
    body: { accept: true },
    token: b.token,
    headers,
  });
}

async function backdate(raceId) {
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
}

// A started SOLO race with `others` invited alongside the creator.
async function createSoloRace(creator, others) {
  for (const other of others) await makeFriends(creator, other);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Solo Drops",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      // Public keeps the race out of private-race auto-start so this suite
      // still exercises the manual start path. Privacy is irrelevant to the
      // drop-pool behavior asserted here.
      isPublic: true,
    },
    token: creator.token,
  });
  const createBody = await createRes.json();
  if (!createBody.race) {
    throw new Error(`race create failed: ${createRes.status} ${JSON.stringify(createBody)}`);
  }
  const raceId = createBody.race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });
  await backdate(raceId);
  return raceId;
}

// A started 2v2 TEAM race: creator + `teamA` on TEAM_A, `teamB` on TEAM_B.
async function createTeamRace(creator, teamA, teamB) {
  const others = [...teamA, ...teamB];
  for (const other of others) await makeFriends(creator, other, P5_HEADERS);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Team Drops",
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 1 + teamA.length,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      // See createSoloRace: public == ineligible for private auto-start.
      isPublic: true,
    },
    token: creator.token,
    headers: P5_HEADERS,
  });
  const createBody = await createRes.json();
  if (!createBody.race) {
    throw new Error(`team race create failed: ${createRes.status} ${JSON.stringify(createBody)}`);
  }
  const raceId = createBody.race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
    headers: P5_HEADERS,
  });
  for (const [user, team] of [
    ...teamA.map((u) => [u, "TEAM_A"]),
    ...teamB.map((u) => [u, "TEAM_B"]),
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: P5_HEADERS,
    });
    assert.equal(res.status, 200, `respond failed: ${res.status}`);
  }
  const detail = await request(server.baseUrl, "GET", `/races/${raceId}`, {
    token: creator.token,
    headers: P5_HEADERS,
  });
  assert.equal(detail.status, 200);
  const current = await detail.json();
  if (current.status === "PENDING") {
    const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: creator.token,
      headers: P5_HEADERS,
    });
    assert.equal(startRes.status, 200, `team race start failed: ${startRes.status}`);
  } else {
    assert.equal(current.status, "ACTIVE");
  }
  await backdate(raceId);
  return raceId;
}

async function recordSteps(token, steps) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  await request(server.baseUrl, "POST", "/steps/samples", {
    body: {
      samples: [
        { periodStart: oneHourAgo.toISOString(), periodEnd: now.toISOString(), steps },
      ],
    },
    token,
  });
}

async function getProgress(token, raceId, headers = undefined) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers,
  });
  return (await res.json()).progress;
}

async function walk(user, raceId, steps, headers = undefined) {
  await recordSteps(user.token, steps);
  await getProgress(user.token, raceId, headers);
}

let nextEarnedAtSteps = 2_000_000;

async function giveBox(raceId, userId) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type: null,
      rarity: null,
      status: "MYSTERY_BOX",
      earnedAtSteps: ++nextEarnedAtSteps,
    },
  });
}

async function giveHeld(raceId, userId, type, rarity = "UNCOMMON") {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD" },
  });
}

// Open `count` boxes one at a time through POST .../open and return the rolled
// types. Each opened row is retired immediately so slot accounting never
// interferes with a long sampling run.
async function openBoxes(user, raceId, count, headers) {
  const types = [];
  for (let i = 0; i < count; i++) {
    const box = await giveBox(raceId, user.userId);
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: user.token, headers }
    );
    assert.equal(res.status, 200, `open ${i} failed: ${res.status}`);
    const body = await res.json();
    assert.ok(body.result.type, `open ${i} returned a null type — a tapped box must always pay out`);
    types.push(body.result.type);
    await prisma.racePowerup.update({
      where: { id: box.id },
      data: { status: "USED", usedAt: new Date() },
    });
  }
  return types;
}

// Same sampling, but through POST .../powerups/open-batch. The batch endpoint is
// the likeliest partial implementation (gate `open`, forget `open-batch`).
async function openBoxesBatch(user, raceId, count, headers) {
  const types = [];
  let remaining = count;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 10);
    const boxes = [];
    for (let i = 0; i < chunk; i++) boxes.push(await giveBox(raceId, user.userId));
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/open-batch`,
      { token: user.token, headers, body: { powerupIds: boxes.map((b) => b.id) } }
    );
    assert.equal(res.status, 200, `open-batch failed: ${res.status}`);
    const body = await res.json();
    assert.equal(body.results.length, chunk, "batch must open every box it was handed");
    for (const r of body.results) {
      assert.ok(r.type, "open-batch returned a null type");
      types.push(r.type);
    }
    await prisma.racePowerup.updateMany({
      where: { id: { in: boxes.map((b) => b.id) } },
      data: { status: "USED", usedAt: new Date() },
    });
    remaining -= chunk;
  }
  return types;
}

async function activateConfig(config, version = 1) {
  await prisma.balanceConfig.updateMany({ where: { active: true }, data: { active: false } });
  const row = await prisma.balanceConfig.create({
    data: { version, config, active: true, note: "team-only-drop-pool test" },
  });
  balanceConfig.bustCache();
  return row;
}

// Force every roll into the UNCOMMON tier holding exactly the named pool, so a
// "RALLY_FLAG never appears" assertion is deterministic rather than a rare tail.
// Tier probabilities are precisely what this change must NOT touch, so pinning
// them is safe.
function pinnedUncommon(pool) {
  const config = defaultConfig();
  config.positionOdds = { first: [0, 1, 0], last: [0, 1, 0] };
  config.dropPool = { COMMON: [], UNCOMMON: [...pool], RARE: [] };
  config.typeWeights = {};
  return config;
}

const SAMPLES = 40;

describe("team-only drop pool", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
    await prisma.powerupShopItem.deleteMany({});
    balanceConfig.bustCache();
  });

  // §9.1
  it("a powerups5 client in a TEAM race can roll Rally Flag", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("TeamAliceP5", P5_HEADERS);
    const bob = await createUser("TeamBobP5", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      rolled.includes("RALLY_FLAG"),
      `a powerups5 client in a team race must be able to roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
  });

  // §9.2
  it("a powerups5 client in a SOLO race never rolls Rally Flag", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("SoloAliceP5", P5_HEADERS);
    const bob = await createUser("SoloBobP5", P5_HEADERS);
    const raceId = await createSoloRace(alice, [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      !rolled.includes("RALLY_FLAG"),
      `a solo race must never roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
    assert.deepEqual([...new Set(rolled)], ["STEALTH_MODE"]);
  });

  // §9.3 — the compat gate. This is the one that makes the change shippable
  // before the 2.0.x App Store rollout.
  it("a client without powerups5 never rolls Rally Flag, even in a team race", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("TeamAliceOld", P5_HEADERS);
    const bob = await createUser("TeamBobOld", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, OLD_HEADERS);
    await walk(bob, raceId, 4000, OLD_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, OLD_HEADERS);
    assert.ok(
      !rolled.includes("RALLY_FLAG"),
      `a pre-powerups5 binary must never roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
    assert.deepEqual([...new Set(rolled)], ["STEALTH_MODE"]);
  });

  // §9.4 — both roll paths. Gating `open` and forgetting `open-batch` is the
  // most plausible partial implementation of this spec.
  it("open-batch applies the same two gates as the single open", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("BatchAlice", P5_HEADERS);
    const bob = await createUser("BatchBob", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const modern = await openBoxesBatch(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      modern.includes("RALLY_FLAG"),
      `open-batch must reach RALLY_FLAG for a powerups5 team client, got ${[...new Set(modern)].join(",")}`
    );

    const frozen = await openBoxesBatch(alice, raceId, SAMPLES, OLD_HEADERS);
    assert.ok(
      !frozen.includes("RALLY_FLAG"),
      `open-batch must gate a pre-powerups5 client, got ${[...new Set(frozen)].join(",")}`
    );

    // …and the solo half of the gate, through the batch path too.
    const carol = await createUser("BatchCarol", P5_HEADERS);
    const dave = await createUser("BatchDave", P5_HEADERS);
    const soloId = await createSoloRace(carol, [dave]);
    await walk(carol, soloId, 8000, P5_HEADERS);
    await walk(dave, soloId, 4000, P5_HEADERS);
    const solo = await openBoxesBatch(carol, soloId, SAMPLES, P5_HEADERS);
    assert.ok(
      !solo.includes("RALLY_FLAG"),
      `open-batch must gate a solo race, got ${[...new Set(solo)].join(",")}`
    );
  });

  // §9.5 — the odds sheet must not advertise what the roll cannot produce. The
  // roll and the disclosure read the same seam; if they diverge the sheet lies.
  it("the odds sheet lists Rally Flag in exactly the one case it can drop", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));

    const alice = await createUser("OddsAlice", P5_HEADERS);
    const bob = await createUser("OddsBob", P5_HEADERS);
    const teamId = await createTeamRace(alice, [], [bob]);
    await walk(alice, teamId, 8000, P5_HEADERS);
    await walk(bob, teamId, 4000, P5_HEADERS);

    const carol = await createUser("OddsCarol", P5_HEADERS);
    const dave = await createUser("OddsDave", P5_HEADERS);
    const soloId = await createSoloRace(carol, [dave]);
    await walk(carol, soloId, 8000, P5_HEADERS);
    await walk(dave, soloId, 4000, P5_HEADERS);

    const teamP5 = await getProgress(alice.token, teamId, P5_HEADERS);
    const teamOld = await getProgress(alice.token, teamId, OLD_HEADERS);
    const soloP5 = await getProgress(carol.token, soloId, P5_HEADERS);
    const soloOld = await getProgress(carol.token, soloId, OLD_HEADERS);

    assert.ok(
      teamP5.powerupData.dropOdds.byType.RALLY_FLAG > 0,
      "team + powerups5 is the one combination that must quote RALLY_FLAG"
    );
    for (const [label, progress] of [
      ["team without powerups5", teamOld],
      ["solo with powerups5", soloP5],
      ["solo without powerups5", soloOld],
    ]) {
      assert.equal(
        progress.powerupData.dropOdds.byType.RALLY_FLAG ?? 0,
        0,
        `${label} must be quoted zero RALLY_FLAG`
      );
    }

    // The tier block is untouched by this feature — the shipped odds sheet hides
    // itself entirely if it stops summing to 1.
    for (const progress of [teamP5, teamOld, soloP5, soloOld]) {
      const { rarity } = progress.powerupData.dropOdds;
      const sum = rarity.COMMON + rarity.UNCOMMON + rarity.RARE;
      assert.ok(Math.abs(sum - 1) < 0.001, `rarity must still sum to 1, got ${sum}`);
    }
  });

  // §9.6 — §5.7 hides the store row; a purchase must 404.
  it("Rally Flag cannot be purchased once the store row is hidden", async () => {
    await activateConfig(defaultConfig());
    const alice = await createUser("ShopAlice", P5_HEADERS);
    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 5000 } });

    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_RALLY_FLAG" },
      update: { active: false, testOnly: true },
      create: {
        sku: "POWERUP_RALLY_FLAG",
        name: "Rally Flag",
        description: "Team races only",
        priceCoins: 150,
        powerupType: "RALLY_FLAG",
        active: false,
        testOnly: true,
        sortOrder: 16,
      },
    });

    const catalogRes = await request(server.baseUrl, "GET", "/shop/powerups", {
      token: alice.token,
      headers: { ...P5_HEADERS, "X-Release-Channel": "testflight" },
    });
    assert.equal(catalogRes.status, 200);
    const catalog = await catalogRes.json();
    assert.ok(
      !(catalog.items || []).some((i) => i.sku === "POWERUP_RALLY_FLAG"),
      "a hidden row must not appear in the catalog on any channel"
    );

    const buyRes = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
      token: alice.token,
      headers: {
        ...P5_HEADERS,
        "X-Release-Channel": "testflight",
        "Idempotency-Key": "team-only-rally-flag-1",
      },
      body: { sku: "POWERUP_RALLY_FLAG" },
    });
    assert.equal(buyRes.status, 404, `purchase should 404, got ${buyRes.status}`);

    const user = await prisma.user.findUnique({ where: { id: alice.userId } });
    assert.equal(user.coins, 5000, "a 404'd purchase must not spend coins");
  });

  // §9.7 — the effect itself is byte-identical to today.
  it("a held Rally Flag still buffs the whole team, and still 400s in a solo race", async () => {
    await activateConfig(defaultConfig());

    const alice = await createUser("EffectAlice", P5_HEADERS);
    const bob = await createUser("EffectBob", P5_HEADERS);
    const carol = await createUser("EffectCarol", P5_HEADERS);
    const dave = await createUser("EffectDave", P5_HEADERS);
    const teamId = await createTeamRace(alice, [bob], [carol, dave]);
    for (const u of [alice, bob, carol, dave]) await walk(u, teamId, 3000, P5_HEADERS);

    const flag = await giveHeld(teamId, alice.userId, "RALLY_FLAG");
    const useRes = await request(
      server.baseUrl,
      "POST",
      `/races/${teamId}/powerups/${flag.id}/use`,
      { token: alice.token, headers: P5_HEADERS, body: {} }
    );
    const useBody = await useRes.json();
    assert.equal(useRes.status, 200, `use failed: ${useRes.status} ${JSON.stringify(useBody)}`);
    assert.equal(useBody.result.outcome, "APPLIED");
    assert.equal(useBody.result.affected, 2, "both TEAM_A members are buffed");
    assert.equal(useBody.result.durationMs, 60 * 60 * 1000);

    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId: teamId, type: "RALLY_FLAG", status: "ACTIVE" },
    });
    assert.equal(effects.length, 2);
    assert.deepEqual(
      effects.map((e) => e.targetUserId).sort(),
      [alice.userId, bob.userId].sort()
    );
    for (const e of effects) assert.equal(e.metadata.multiplier, 1.25);

    // Solo half — unchanged 400 INVALID_TARGET, item not consumed.
    const erin = await createUser("EffectErin", P5_HEADERS);
    const frank = await createUser("EffectFrank", P5_HEADERS);
    const soloId = await createSoloRace(erin, [frank]);
    await walk(erin, soloId, 3000, P5_HEADERS);
    const soloFlag = await giveHeld(soloId, erin.userId, "RALLY_FLAG");
    const soloRes = await request(
      server.baseUrl,
      "POST",
      `/races/${soloId}/powerups/${soloFlag.id}/use`,
      { token: erin.token, headers: P5_HEADERS, body: {} }
    );
    assert.equal(soloRes.status, 400);
    const soloBody = await soloRes.json();
    assert.equal(soloBody.error, "Rally Flag needs a team race");
    assert.equal(soloBody.code, "INVALID_TARGET");
    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: soloFlag.id } });
    assert.equal(stillHeld.status, "HELD", "a rejected use must not consume the item");
  });
});

})();
