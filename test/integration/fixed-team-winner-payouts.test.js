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
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const {
  buildRaceAdminCommandWorker,
} = require("../../src/modules/races/jobs/raceAdminCommandRunner");
const {
  buildCompleteRace,
  completeRace,
} = require("../../src/modules/races/commands/completeRace");
const { awardCoins } = require("../../src/shared/economy/awardCoins");

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

  it("repairs an open legacy team race under its write fence and invalidates every cache", async () => {
    const race = await seedFixedTeamRace({
      teamSize: 2,
      teamPayoutVersion: null,
      rewardCoins: null,
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { creatorId: (await makeUser()).userId },
    });
    const users = await addMembers(race, [
      { team: "TEAM_A", steps: 100 },
      { team: "TEAM_A", steps: 90 },
      { team: "TEAM_B", steps: 10 },
      { team: "TEAM_B", steps: 5 },
    ]);
    const downwardRace = await seedFixedTeamRace({
      durationDays: 30,
      rewardCoins: null,
      teamPayoutVersion: null,
    });
    await prisma.race.update({
      where: { id: downwardRace.id },
      data: {
        creatorId: (await makeUser()).userId,
        prizeCoinUnit: 100,
        teamPoolMultBps: 18750,
      },
    });
    await addMembers(downwardRace, [
      ...Array.from({ length: 5 }, (_, index) => ({
        team: "TEAM_A",
        steps: 100 - index,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        team: "TEAM_B",
        steps: 50 - index,
      })),
    ]);
    const partialRace = await seedFixedTeamRace({
      teamSize: 1,
      teamPayoutVersion: 1,
      rewardCoins: null,
    });
    await prisma.race.update({
      where: { id: partialRace.id },
      data: { creatorId: (await makeUser()).userId },
    });
    const repairScript = path.resolve(
      __dirname,
      "../../scripts/repair-open-fixed-team-payouts.js",
    );
    const childEnv = {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      DOTENV_CONFIG_QUIET: "true",
    };
    const dryRun = await execFileAsync(process.execPath, [repairScript], {
      env: childEnv,
    });
    const report = JSON.parse(dryRun.stdout);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.candidateCount, 2);
    assert.equal(report.upwardCount, 1);
    assert.equal(report.skippedNonUpwardCount, 1);
    assert.equal(report.skippedPartialOrMalformedCount, 1);
    assert.equal(report.skippedPartialOrMalformed[0].raceId, partialRace.id);
    assert.equal(report.skippedPartialOrMalformed[0].teamPayoutVersion, 1);
    assert.equal(report.skippedPartialOrMalformed[0].teamWinnerRewardCoins, null);
    assert.equal(report.upward[0].raceId, race.id);
    assert.equal(report.upward[0].repairedProjectionCoins, 1000);
    assert.equal(report.upward[0].sideALiabilityCoins, 1000);
    assert.equal(report.upward[0].sideBLiabilityCoins, 1000);
    assert.equal(report.skippedNonUpward[0].raceId, downwardRace.id);
    assert.ok(report.skippedNonUpward[0].deltaCoins < 0);
    assert.match(report.reportDigest, /^[a-f0-9]{64}$/);

    await assert.rejects(
      execFileAsync(process.execPath, [repairScript, "--enqueue"], {
        env: childEnv,
      }),
      (error) => {
        assert.match(error.stderr, /Enqueue refused/);
        return true;
      },
    );

    const enqueueArgs = [
      repairScript,
      "--enqueue",
      "--confirm-enqueue=FIXED_TEAM_PAYOUT_REPAIR_V1",
      `--report-digest=${report.reportDigest}`,
    ];
    await prisma.race.update({
      where: { id: race.id },
      data: { maxDurationDays: 8 },
    });
    await assert.rejects(
      execFileAsync(process.execPath, enqueueArgs, { env: childEnv }),
      (error) => {
        assert.match(error.stderr, /candidate report changed since dry-run/);
        return true;
      },
    );
    await prisma.race.update({
      where: { id: race.id },
      data: { maxDurationDays: 7 },
    });
    await execFileAsync(process.execPath, enqueueArgs, { env: childEnv });
    await execFileAsync(process.execPath, enqueueArgs, { env: childEnv });
    assert.equal(await prisma.raceAdminCommand.count({
      where: { dedupeKey: `fixed-team-payout-v1:${race.id}` },
    }), 1, "rerunning enqueue is idempotent");
    const invalidatedProgress = [];
    const invalidatedUsers = [];
    const run = buildRaceAdminCommandWorker({
      invalidateRaceProgress: async (raceId) => invalidatedProgress.push(raceId),
      invalidateRaceListUser: async (userId) => invalidatedUsers.push(userId),
      logger: { error() {} },
    });

    assert.equal(
      await run(),
      false,
      "enqueue cannot race ahead of separately authorized execution",
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [repairScript, "--authorize-execution"],
        { env: childEnv },
      ),
      (error) => {
        assert.match(error.stderr, /Execution authorization refused/);
        return true;
      },
    );
    const authorizeArgs = [
      repairScript,
      "--authorize-execution",
      "--confirm-execution=FIXED_TEAM_PAYOUT_EXECUTION_V1",
      `--report-digest=${report.reportDigest}`,
    ];
    const authorization = await execFileAsync(
      process.execPath,
      authorizeArgs,
      { env: childEnv },
    );
    assert.equal(JSON.parse(authorization.stdout).authorizedCount, 1);

    assert.equal(await run(), true);

    const repaired = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(repaired.teamPayoutVersion, 1);
    assert.equal(repaired.teamWinnerRewardCoins, 500);
    assert.deepEqual(invalidatedProgress, [race.id]);
    assert.deepEqual(
      invalidatedUsers.sort(),
      users.map((user) => user.userId).sort(),
    );
    const detail = await (await req("GET", `/races/${race.id}`, {
      token: users[0].token,
      headers: TEAM_HEADERS,
    })).json();
    assert.equal(detail.prizePool.coins, 1000);
    assert.deepEqual(detail.payoutTiers, [
      { placement: 1, amount: 500 },
      { placement: 2, amount: 500 },
    ]);
    assert.equal(await run(), false, "completed command is not replayed");
  });

  it("re-arms a terminal non-mutating repair after snapshot drift", async () => {
    const race = await seedFixedTeamRace({
      teamSize: 2,
      teamPayoutVersion: null,
      rewardCoins: null,
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { creatorId: (await makeUser()).userId },
    });
    await addMembers(race, [
      { team: "TEAM_A", steps: 100 },
      { team: "TEAM_B", steps: 10 },
    ]);
    const repairScript = path.resolve(
      __dirname,
      "../../scripts/repair-open-fixed-team-payouts.js",
    );
    const childEnv = {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      DOTENV_CONFIG_QUIET: "true",
    };
    const report1 = JSON.parse((await execFileAsync(process.execPath, [repairScript], {
      env: childEnv,
    })).stdout);
    await execFileAsync(process.execPath, [
      repairScript,
      "--enqueue",
      "--confirm-enqueue=FIXED_TEAM_PAYOUT_REPAIR_V1",
      `--report-digest=${report1.reportDigest}`,
    ], { env: childEnv });
    await execFileAsync(process.execPath, [
      repairScript,
      "--authorize-execution",
      "--confirm-execution=FIXED_TEAM_PAYOUT_EXECUTION_V1",
      `--report-digest=${report1.reportDigest}`,
    ], { env: childEnv });

    const newcomer = await makeUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: newcomer.userId,
        status: "ACCEPTED",
        team: "TEAM_A",
      },
    });
    const run = buildRaceAdminCommandWorker({ logger: { error() {} } });
    assert.equal(await run(), true);
    const mismatch = await prisma.raceAdminCommand.findUnique({
      where: { dedupeKey: `fixed-team-payout-v1:${race.id}` },
    });
    assert.equal(mismatch.status, "COMPLETED");
    assert.equal(mismatch.lastError, "REPAIR_SNAPSHOT_MISMATCH");
    assert.equal((await prisma.race.findUnique({ where: { id: race.id } })).teamPayoutVersion, null);

    const report2 = JSON.parse((await execFileAsync(process.execPath, [repairScript], {
      env: childEnv,
    })).stdout);
    assert.notEqual(report2.reportDigest, report1.reportDigest);
    await execFileAsync(process.execPath, [
      repairScript,
      "--enqueue",
      "--confirm-enqueue=FIXED_TEAM_PAYOUT_REPAIR_V1",
      `--report-digest=${report2.reportDigest}`,
    ], { env: childEnv });
    await execFileAsync(process.execPath, [
      repairScript,
      "--authorize-execution",
      "--confirm-execution=FIXED_TEAM_PAYOUT_EXECUTION_V1",
      `--report-digest=${report2.reportDigest}`,
    ], { env: childEnv });
    assert.equal(await run(), true);
    const repaired = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(repaired.teamPayoutVersion, 1);
    assert.equal(repaired.teamWinnerRewardCoins, 500);
    assert.equal((await poolLedger(race.id)).length, 0);
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
