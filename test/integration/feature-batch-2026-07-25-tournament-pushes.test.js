// Feature batch 2026-07-25 — §1 (D1): TOURNAMENT_COMPLETED is dead.
//
// A completed bracket must produce exactly ONE end-of-run push per player:
// the champion gets TOURNAMENT_CHAMPION, everyone else already got their own
// TOURNAMENT_ELIMINATED at their knockout. Nobody gets TOURNAMENT_COMPLETED.
//
// Asserted on the notifications ACTUALLY RECORDED (the `notifications` audit
// rows written by the real notification handlers), not on advanceTournament's
// return value — the fan-out lived in a deferred[] array whose contents are a
// helper detail. The real handler chain is registered on the shared event bus
// with a stub push transport, so this exercises emit -> handler -> audit row.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const { buildDomainEventProjectionJob } = require("../../src/modules/domainEvents");
const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;
const FEAT = "tournaments,characters";
const quietLogger = { log() {}, warn() {}, error() {} };
const stubPush = {
  async sendNotification() {
    return { success: true };
  },
};

function authReq(method, path, { body, token } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: { "X-Client-Features": FEAT },
  });
}

async function createUser(displayName) {
  const appleId = `apple-tp-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  await authReq("GET", "/races", { token });
  // A recorded notification requires at least one device token (the handler
  // returns early otherwise), so every bracket player registers one.
  await prisma.deviceToken.create({
    data: { userId, token: `dev-${userId}`, platform: "ios" },
  });
  return { userId, token, displayName };
}

async function settleMatchup(raceId, stepsByUser) {
  const participants = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
  });
  for (const p of participants) {
    await prisma.raceParticipant.update({
      where: { id: p.id },
      data: { totalSteps: stepsByUser[p.userId] ?? 0 },
    });
  }
  await completeRace({
    raceId,
    winnerUserId: participants[0].userId,
    participantUserIds: participants.map((p) => p.userId),
  });
}

// The event bus fires handlers without awaiting them; poll briefly for the
// audit rows to land rather than racing them.
async function notificationsOfType(type, { expect = null, timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    rows = await prisma.notification.findMany({ where: { type } });
    if (expect === null ? rows.length > 0 : rows.length >= expect) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("feature batch 2026-07-25 — §1 tournament end-of-run pushes", () => {
  before(async () => {
    server = await getSharedServer();
    // Real handlers on the shared bus (advanceTournament's singleton emits
    // there), with the APNs/FCM transports stubbed out.
    registerNotificationHandlers({
      apnsService: stubPush,
      fcmService: stubPush,
      logger: quietLogger,
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.notification.deleteMany({});
    nextAppleId = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
    await appSettings.setFlag("apiInboxV1Enabled", true);
  });

  it("a 4-bracket run to completion sends TOURNAMENT_CHAMPION to the winner and TOURNAMENT_COMPLETED to nobody", async () => {
    const a = await createUser("BracketA");
    const b = await createUser("BracketB");
    const c = await createUser("BracketC");
    const d = await createUser("BracketD");

    const createRes = await authReq("POST", "/tournaments", {
      token: a.token,
      body: {
        name: "Push Cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        isPublic: true,
        powerupsEnabled: false,
        inviteeIds: [],
      },
    });
    const { tournament } = await createRes.json();
    const tournamentId = tournament.id;
    await prisma.friendship.createMany({
      data: [b, c, d].map((user) => ({
        requesterId: a.userId,
        addresseeId: user.userId,
        status: "ACCEPTED",
      })),
    });
    const invite = await authReq("POST", `/tournaments/${tournamentId}/invite`, {
      token: a.token,
      body: { userIds: [b.userId, c.userId, d.userId] },
    });
    assert.equal(invite.status, 200);
    for (const u of [b, c, d]) {
      await authReq("POST", `/tournaments/${tournamentId}/join`, { token: u.token });
    }

    const round1 = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      include: { participants: true },
      orderBy: { tournamentMatchIndex: "asc" },
    });
    assert.equal(round1.length, 2);

    for (const r of round1) {
      const [p0, p1] = r.participants.filter((p) => p.status === "ACCEPTED");
      await settleMatchup(r.id, { [p0.userId]: 5000, [p1.userId]: 100 });
    }

    const finalRace = await prisma.race.findFirst({
      where: { tournamentId, tournamentRound: 2 },
      include: { participants: true },
    });
    const [f0, f1] = finalRace.participants.filter((p) => p.status === "ACCEPTED");
    await settleMatchup(finalRace.id, { [f0.userId]: 9000, [f1.userId]: 100 });

    const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
    assert.equal(t.status, "COMPLETED");
    assert.equal(t.championUserId, f0.userId);

    const produced = await prisma.domainEventOutbox.groupBy({
      by: ["eventType"],
      where: { aggregateId: tournamentId },
      _count: { _all: true },
    });
    const producedCounts = Object.fromEntries(
      produced.map((row) => [row.eventType, row._count._all]),
    );
    assert.deepEqual(producedCounts, {
      TOURNAMENT_CHAMPION_V1: 1,
      TOURNAMENT_ELIMINATED_V1: 3,
      TOURNAMENT_INVITE_SENT_V1: 3,
      TOURNAMENT_MATCHUP_WON_V1: 2,
      TOURNAMENT_ROUND_STARTED_V1: 2,
      TOURNAMENT_STARTED_V1: 4,
    });
    assert.equal(producedCounts.TOURNAMENT_COMPLETED_V1, undefined,
      "retired tournament completion fan-out remains compatibility-only");
    // The champion push still lands.
    const champion = await notificationsOfType("TOURNAMENT_CHAMPION", { expect: 1 });
    assert.equal(champion.length, 1, "exactly one champion push");
    assert.equal(champion[0].userId, f0.userId);

    // Nobody — champion, runner-up, or round-1 losers — gets the crown fan-out.
    const completed = await notificationsOfType("TOURNAMENT_COMPLETED", {
      expect: 1,
      timeoutMs: 1500,
    });
    assert.equal(
      completed.length,
      0,
      "TOURNAMENT_COMPLETED must not be sent to anyone"
    );

    // Every non-champion got exactly one TOURNAMENT_ELIMINATED: the two round-1
    // losers at their own knockout, and the runner-up when the final settled.
    const eliminated = await notificationsOfType("TOURNAMENT_ELIMINATED", { expect: 3 });
    const eliminatedUserIds = eliminated.map((n) => n.userId).sort();
    const roundOneLosers = [a, b, c, d]
      .map((u) => u.userId)
      .filter((id) => id !== f0.userId && id !== f1.userId)
      .sort();
    assert.deepEqual(
      eliminatedUserIds,
      [...roundOneLosers, f1.userId].sort(),
      "both round-1 losers AND the runner-up are knocked out exactly once"
    );
    for (const id of roundOneLosers) {
      assert.equal(
        eliminated.filter((n) => n.userId === id).length,
        1,
        "exactly one end-of-run push per eliminated player"
      );
    }

    // ⚠️ RUNNER-UP — the D1 follow-up, owner-confirmed 2026-07-25.
    //
    // The spec's original §1 premise was WRONG: it assumed every non-champion
    // "already got one TOURNAMENT_ELIMINATED at their own knockout". Not so for
    // the FINAL's loser — TOURNAMENT_ELIMINATED is emitted only on the round
    // r -> r+1 transition, and the final has no next round. So the runner-up's
    // only end-of-run push was ever TOURNAMENT_COMPLETED, and killing that
    // outright (D1 as literally written) left them with NOTHING.
    //
    // Owner decision: emit TOURNAMENT_ELIMINATED for the runner-up explicitly in
    // the champion branch. This test is the regression guard for that — if the
    // runner-up's push is ever dropped again, this fails.
    const runnerUpPushes = await prisma.notification.findMany({
      where: { userId: f1.userId, type: { startsWith: "TOURNAMENT_" } },
    });
    const runnerUpEndOfRun = runnerUpPushes
      .map((n) => n.type)
      .filter((t) =>
        ["TOURNAMENT_CHAMPION", "TOURNAMENT_COMPLETED", "TOURNAMENT_ELIMINATED"].includes(t)
      );
    assert.deepEqual(
      runnerUpEndOfRun,
      ["TOURNAMENT_ELIMINATED"],
      "the runner-up gets exactly one end-of-run push: their own knockout"
    );

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();
    for (const type of [
      "TOURNAMENT_CHAMPION",
      "TOURNAMENT_ELIMINATED",
      "TOURNAMENT_INVITE_SENT",
      "TOURNAMENT_MATCHUP_WON",
      "TOURNAMENT_ROUND_STARTED",
      "TOURNAMENT_STARTED",
    ]) {
      assert.ok(
        await prisma.inboxAlert.count({ where: { type } }),
        `${type} reaches Inbox from its real tournament command path`,
      );
    }
  });

  it("projects real tournament cancellation/invite commands and suppresses a deleted occurrence recipient", async () => {
    const creator = await createUser("CancelCreator");
    const eligible = await createUser("CancelEligible");
    const deleted = await createUser("CancelDeleted");
    await prisma.friendship.createMany({
      data: [eligible, deleted].map((user) => ({
        requesterId: creator.userId,
        addresseeId: user.userId,
        status: "ACCEPTED",
      })),
    });
    const created = await authReq("POST", "/tournaments", {
      token: creator.token,
      body: {
        name: "Cancellation coverage cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        isPublic: true,
        powerupsEnabled: false,
        inviteeIds: [],
      },
    });
    assert.equal(created.status, 201);
    const tournamentId = (await created.json()).tournament.id;
    const invited = await authReq("POST", `/tournaments/${tournamentId}/invite`, {
      token: creator.token,
      body: { userIds: [eligible.userId, deleted.userId] },
    });
    assert.equal(invited.status, 200);
    const cancelled = await authReq("DELETE", `/tournaments/${tournamentId}`, {
      token: creator.token,
    });
    assert.equal(cancelled.status, 200);
    const removed = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: deleted.token,
    });
    assert.equal(removed.status, 204);

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();
    const cancellationEvents = await prisma.domainEventOutbox.findMany({
      where: { aggregateId: tournamentId, eventType: "TOURNAMENT_CANCELLED_V1" },
      include: { projections: true },
    });
    assert.equal(cancellationEvents.length, 3);
    const projections = cancellationEvents.flatMap((event) => event.projections);
    assert.equal(projections.filter((row) => row.status === "COMPLETED").length, 2);
    assert.equal(projections.filter((row) => row.status === "SUPPRESSED").length, 1);
    assert.equal(
      projections.find((row) => row.recipientUserId === deleted.userId).lastErrorCode,
      "RECIPIENT_DELETED",
    );
    assert.equal(await prisma.inboxAlert.count({ where: {
      type: "TOURNAMENT_CANCELLED",
      userId: { in: [creator.userId, eligible.userId] },
    } }), 2);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: deleted.userId } }), 0);
  });
});
