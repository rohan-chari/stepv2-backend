const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const { appSettings } = require("../../src/shared/config/appSettings");
const {
  autoStartScheduledRaces,
} = require("../../src/modules/races/jobs/autoStartScheduledRaces");
const {
  autoStartUnscheduledPrivateRaces,
} = require("../../src/modules/races/jobs/privateRaceAutoStart");
const {
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");

// Custom race windows — docs/race-timeline-options-requirements.md §9,
// backend tests 1-10b and 21. Real HTTP, real DB, real handler chain; every
// end-instant claim is asserted against the persisted row (and, for the
// economy locks, against the settled coin ledger) rather than a response field.

const FLAG = "customRaceWindowEnabled";
const FUNDED_FLAG = "fundedPrizePoolsEnabled";
const POOL_REASON = "race_prize_pool_payout";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let server;
let seq = 0;

async function makeUser({ coins = 0 } = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-window-${++seq}`,
    email: `window-${seq}@example.com`,
    coins,
  });
  return { userId: user.id, token };
}

function req(method, path, { body, token, headers } = {}) {
  return request(server.baseUrl, method, path, { body, token, headers });
}

// Team-race creation requires the X-Client-Features capability token (TR-106).
const TEAM_HEADERS = { "X-Client-Features": "team_races" };

async function makeFriends(a, b) {
  const sendRes = await req("POST", "/friends/request", {
    token: a.token,
    body: { addresseeId: b.userId },
  });
  const friendshipId = (await sendRes.json()).friendship.id;
  await req("PUT", `/friends/request/${friendshipId}`, {
    token: b.token,
    body: { accept: true },
  });
}

async function row(raceId) {
  return prisma.race.findUnique({ where: { id: raceId } });
}

// Create a race over real HTTP and bring a second player in as ACCEPTED, so the
// race is startable. `isPublic: true` by default on purpose: an UNSCHEDULED
// PRIVATE race auto-starts inline the moment the second player accepts
// (privateRaceAutoStart), which would start half these fixtures out from under
// the assertion. Public races have no auto-start at all.
async function createRaceWithField(body, { isPublic = true } = {}) {
  const creator = await makeUser();
  const invitee = await makeUser();
  const res = await req("POST", "/races", {
    token: creator.token,
    body: { name: "Weekend Push", isPublic, maxParticipants: 10, ...body },
  });
  const json = await res.json();
  if (res.status !== 201) return { res, json, creator, invitee, raceId: null };

  const raceId = json.race.id;
  await makeFriends(creator, invitee);
  await req("POST", `/races/${raceId}/invite`, {
    token: creator.token,
    body: { inviteeIds: [invitee.userId] },
  });
  await req("PUT", `/races/${raceId}/respond`, {
    token: invitee.token,
    body: { accept: true },
  });
  return { res, json, creator, invitee, raceId };
}

// A startable TEAM race: 1v1, creator on TEAM_A, invitee accepting onto TEAM_B.
// Team creation and team-side acceptance both require the team_races capability
// token, so every call here carries it.
async function createTeamRaceWithField(body) {
  const creator = await makeUser();
  const invitee = await makeUser();
  const res = await req("POST", "/races", {
    token: creator.token,
    headers: TEAM_HEADERS,
    body: {
      name: "Team Window Race",
      isPublic: true,
      isTeamRace: true,
      teamSize: 1,
      team: "TEAM_A",
      ...body,
    },
  });
  const created = await res.text();
  assert.equal(res.status, 201, created);
  const raceId = JSON.parse(created).race.id;

  await makeFriends(creator, invitee);
  // TR-706/707: the invite is blocked unless the invitee's LAST-SEEN client
  // declared team_races, which the server records from their own requests.
  await req("GET", "/auth/me", { token: invitee.token, headers: TEAM_HEADERS });
  await req("POST", `/races/${raceId}/invite`, {
    token: creator.token,
    headers: TEAM_HEADERS,
    body: { inviteeIds: [invitee.userId] },
  });
  const accept = await req("PUT", `/races/${raceId}/respond`, {
    token: invitee.token,
    headers: TEAM_HEADERS,
    body: { accept: true, team: "TEAM_B" },
  });
  assert.equal(accept.status, 200, await accept.text());

  return { creator, invitee, raceId };
}

// Give both runners steps so settlement treats them as walkers (the funded
// floor is totalSteps > 0), then run the real expiry cron. Totals are FROZEN
// via finishedAt/finishTotalSteps — the same fixture shape the funded-prize
// suite uses — because resolution recomputes live totals from step rows and
// would otherwise zero a directly-written total.
async function settle(raceId) {
  const participants = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
    orderBy: { userId: "asc" },
  });
  let steps = 50000;
  for (const p of participants) {
    await prisma.raceParticipant.update({
      where: { id: p.id },
      data: {
        totalSteps: steps,
        rawSteps: steps,
        finishedAt: new Date(Date.now() - 30 * MINUTE),
        finishTotalSteps: steps,
      },
    });
    steps -= 1000;
  }
  await prisma.race.update({
    where: { id: raceId },
    data: { endsAt: new Date(Date.now() - HOUR) },
  });
  await resolveExpiredRaces();
}

async function poolPayoutTotal(raceId) {
  const rows = await prisma.coinTransaction.findMany({
    where: { reason: POOL_REASON, refId: { startsWith: `${raceId}:` } },
  });
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

describe("custom race windows (§9 tests 1-10b, 21)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag(FLAG, true);
    // app_settings is NOT truncated by cleanDatabase, so flag state persists
    // across files and even across runs. The pool assertions below are
    // meaningless unless the funded model is on (its KNOWN_FLAGS default, and
    // prod's setting), so pin it rather than inherit whatever ran last.
    await appSettings.setFlag(FUNDED_FLAG, true);
  });

  after(async () => {
    await appSettings.setFlag(FLAG, false);
    await appSettings.setFlag(FUNDED_FLAG, true);
  });

  // ── 1 ─────────────────────────────────────────────────────────────────────

  it("1: POST /races with scheduledStartAt + scheduledEndAt returns both, and the SERVER's derived maxDurationDays", async () => {
    const creator = await makeUser();
    const start = new Date(Date.now() + 2 * HOUR);
    const end = new Date(start.getTime() + 25 * HOUR);

    const res = await req("POST", "/races", {
      token: creator.token,
      body: {
        name: "Weekend Push",
        // The client's number is deliberately WRONG for this window: the
        // server owns the priced duration (§5.3).
        maxDurationDays: 5,
        scheduledStartAt: start.toISOString(),
        scheduledEndAt: end.toISOString(),
      },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();

    assert.equal(new Date(race.scheduledStartAt).getTime(), start.getTime());
    assert.equal(new Date(race.scheduledEndAt).getTime(), end.getTime());
    // floor(25h / 24h) = 1, NOT the client's 5 and NOT ceil's 2.
    assert.equal(race.maxDurationDays, 1);

    const stored = await row(race.id);
    assert.equal(stored.maxDurationDays, 1);
    assert.equal(stored.scheduledEndAt.getTime(), end.getTime());
    assert.equal(stored.status, "PENDING");
    assert.equal(stored.endsAt, null, "endsAt stays null until start (§5.1)");

    // GET /races/:id carries BOTH fields (architect R6 — scheduledStartAt has
    // never been on this payload, and the edit screen reads it from here).
    const detail = await req("GET", `/races/${race.id}`, { token: creator.token });
    const body = await detail.json();
    assert.equal(new Date(body.scheduledStartAt).getTime(), start.getTime());
    assert.equal(new Date(body.scheduledEndAt).getTime(), end.getTime());
  });

  it("1b: a TEAM custom race lands on the same route and derives the same duration", async () => {
    const creator = await makeUser();
    const end = new Date(Date.now() + 25 * HOUR);
    const res = await req("POST", "/races", {
      token: creator.token,
      headers: TEAM_HEADERS,
      body: {
        name: "Team Window",
        maxDurationDays: 14,
        isTeamRace: true,
        teamSize: 2,
        scheduledEndAt: end.toISOString(),
      },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.maxDurationDays, 1);
    const stored = await row(race.id);
    assert.equal(stored.isTeamRace, true);
    assert.equal(stored.scheduledEndAt.getTime(), end.getTime());
  });

  // ── 2 ─────────────────────────────────────────────────────────────────────

  it("2: the auto-start cron starts a scheduled custom race at endsAt === scheduledEndAt, to the millisecond", async () => {
    const end = new Date(Date.now() + 3 * DAY);
    const { raceId } = await createRaceWithField(
      {
        name: "Scheduled Custom",
        maxDurationDays: 7,
        scheduledStartAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
        scheduledEndAt: end.toISOString(),
      },
      { isPublic: false }
    );

    // createRace requires a FUTURE start, so the "its moment arrived" state is
    // set directly — one minute ago, inside LATE_START_GRACE_MS.
    const scheduledStartAt = new Date(Date.now() - MINUTE);
    await prisma.race.update({
      where: { id: raceId },
      data: { scheduledStartAt },
    });

    await autoStartScheduledRaces();

    const started = await row(raceId);
    assert.equal(started.status, "ACTIVE");
    assert.equal(
      started.endsAt.getTime(),
      end.getTime(),
      "the race must end at the exact instant the creator picked"
    );
    // Anchored to the scheduled moment (inside the grace window).
    assert.equal(started.startedAt.getTime(), scheduledStartAt.getTime());
    // §5.3a: re-derived from the ACTUAL elapsed window.
    assert.equal(started.maxDurationDays, 3);
    // The record of intent survives the start untouched.
    assert.equal(started.scheduledEndAt.getTime(), end.getTime());
  });

  // ── 3 ─────────────────────────────────────────────────────────────────────

  it("3: a race with NO scheduledEndAt still ends at startedAt + maxDurationDays × 24h (legacy regression lock)", async () => {
    const { creator, raceId } = await createRaceWithField({
      name: "Preset Race",
      maxDurationDays: 7,
    });

    const startRes = await req("POST", `/races/${raceId}/start`, {
      token: creator.token,
    });
    assert.equal(startRes.status, 200);

    const started = await row(raceId);
    assert.equal(started.status, "ACTIVE");
    assert.equal(started.scheduledEndAt, null);
    assert.equal(
      started.endsAt.getTime() - started.startedAt.getTime(),
      7 * DAY,
      "byte-for-byte today's derivation"
    );
    assert.equal(started.maxDurationDays, 7, "duration untouched on the legacy path");
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────

  it("4: the four window validation failures each return their documented 400 + code", async () => {
    const creator = await makeUser();
    const start = new Date(Date.now() + 2 * HOUR);
    const post = (body) =>
      req("POST", "/races", {
        token: creator.token,
        body: { name: "Bad Window", maxDurationDays: 7, ...body },
      });

    const cases = [
      {
        label: "end before start",
        body: {
          scheduledStartAt: start.toISOString(),
          scheduledEndAt: new Date(start.getTime() - HOUR).toISOString(),
        },
        code: "RACE_WINDOW_INVALID",
      },
      {
        label: "end in the past",
        body: { scheduledEndAt: new Date(Date.now() - DAY).toISOString() },
        code: "RACE_WINDOW_INVALID",
      },
      {
        label: "window under 24h",
        body: { scheduledEndAt: new Date(Date.now() + 23 * HOUR).toISOString() },
        code: "RACE_WINDOW_TOO_SHORT",
      },
      {
        label: "window over 30 days",
        body: {
          scheduledEndAt: new Date(Date.now() + 31 * DAY).toISOString(),
        },
        code: "RACE_WINDOW_TOO_LONG",
      },
    ];

    for (const testCase of cases) {
      const res = await post(testCase.body);
      assert.equal(res.status, 400, testCase.label);
      const body = await res.json();
      assert.equal(body.code, testCase.code, testCase.label);
      assert.ok(body.error && body.error.length > 0, testCase.label);
    }

    assert.equal(await prisma.race.count(), 0, "no invalid race was persisted");
  });

  // ── 5 ─────────────────────────────────────────────────────────────────────

  it("5: an unparseable scheduledEndAt is IGNORED, not rejected (the forgiving-client rule)", async () => {
    const creator = await makeUser();
    const res = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Junk End", maxDurationDays: 3, scheduledEndAt: "soon" },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.scheduledEndAt, null);
    assert.equal(race.maxDurationDays, 3, "the client's duration survives");
  });

  it("5b: a frozen client's create body (no window fields at all) is byte-for-byte today's race", async () => {
    const creator = await makeUser();
    const res = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Frozen Client", maxDurationDays: 3, targetSteps: 0 },
    });
    assert.equal(res.status, 201);
    const { race } = await res.json();
    assert.equal(race.scheduledEndAt, null);
    assert.equal(race.scheduledStartAt, null);
    assert.equal(race.maxDurationDays, 3);
  });

  // ── 6 ─────────────────────────────────────────────────────────────────────

  it("6: PATCH with maxDurationDays only, on a custom race, CLEARS the window (frozen edit screen)", async () => {
    const end = new Date(Date.now() + 5 * DAY);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: end.toISOString(),
    });
    assert.equal((await row(raceId)).maxDurationDays, 4, "floor(5d) via the window");

    // Exactly what every shipped edit screen sends on save.
    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { maxDurationDays: 7 },
    });
    assert.equal(res.status, 200);

    const updated = await row(raceId);
    assert.equal(updated.scheduledEndAt, null, "duration wins; the window is cleared");
    assert.equal(updated.maxDurationDays, 7);

    // ...and the race now ends duration-derived, as the old screen displayed.
    await req("POST", `/races/${raceId}/start`, { token: creator.token });
    const started = await row(raceId);
    assert.equal(started.endsAt.getTime() - started.startedAt.getTime(), 7 * DAY);
  });

  it("6b: PATCH with an explicit scheduledEndAt: null clears the window (S1 — presence, not truthiness)", async () => {
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledEndAt: null },
    });
    assert.equal(res.status, 200);
    assert.equal((await row(raceId)).scheduledEndAt, null);
  });

  it("6c: a PATCH that only renames a custom race never revalidates the window (architect R3)", async () => {
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: new Date(Date.now() + 30 * HOUR).toISOString(),
    });
    // Simulate the window having shrunk under 24h while the race sat PENDING.
    const end = new Date(Date.now() + 3 * HOUR);
    await prisma.race.update({ where: { id: raceId }, data: { scheduledEndAt: end } });

    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { name: "Renamed Only" },
    });
    assert.equal(res.status, 200, "a rename must not fail with RACE_WINDOW_TOO_SHORT");
    const updated = await row(raceId);
    assert.equal(updated.name, "Renamed Only");
    assert.equal(updated.scheduledEndAt.getTime(), end.getTime(), "window untouched");
  });

  // ── 7 ─────────────────────────────────────────────────────────────────────

  it("7: PATCHing either window field on an ACTIVE race is the existing 400 (architect R1), not a 409", async () => {
    const { creator, raceId } = await createRaceWithField({ maxDurationDays: 7 });
    await req("POST", `/races/${raceId}/start`, { token: creator.token });
    assert.equal((await row(raceId)).status, "ACTIVE");

    for (const body of [
      { scheduledEndAt: new Date(Date.now() + 5 * DAY).toISOString() },
      { scheduledStartAt: new Date(Date.now() + 2 * HOUR).toISOString() },
    ]) {
      const res = await req("PATCH", `/races/${raceId}`, { token: creator.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(json.code, "RACE_ALREADY_STARTED");
    }

    const after = await row(raceId);
    assert.equal(after.scheduledEndAt, null);
  });

  it("7a: PATCH scheduledStartAt: null is REJECTED, and the race stays scheduled (R2 auto-start trap)", async () => {
    const scheduledStartAt = new Date(Date.now() + 3 * HOUR);
    const { creator, raceId } = await createRaceWithField(
      {
        maxDurationDays: 7,
        scheduledStartAt: scheduledStartAt.toISOString(),
      },
      { isPublic: false }
    );

    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledStartAt: null },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "SCHEDULED_START_NOT_CLEARABLE");

    const after = await row(raceId);
    assert.equal(
      after.scheduledStartAt.getTime(),
      scheduledStartAt.getTime(),
      "still scheduled"
    );

    // The regression this locks: had the clear been honored, this private race
    // (2 accepted, no outstanding invites) would be started by the 5-minute
    // backstop on the very next tick — the OPPOSITE of what "un-schedule"
    // appears to do.
    await autoStartUnscheduledPrivateRaces();
    await autoStartScheduledRaces();
    assert.equal((await row(raceId)).status, "PENDING");
  });

  it("7b: moving only the START, so the STORED end is under a day away, is 400 RACE_WINDOW_TOO_SHORT (merged pair)", async () => {
    const end = new Date(Date.now() + 3 * DAY);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
      scheduledEndAt: end.toISOString(),
    });

    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      // 6 hours before the stored end.
      body: { scheduledStartAt: new Date(end.getTime() - 6 * HOUR).toISOString() },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "RACE_WINDOW_TOO_SHORT");

    const after = await row(raceId);
    assert.equal(after.scheduledEndAt.getTime(), end.getTime(), "nothing was written");
  });

  it("7d: moving either end re-derives maxDurationDays, and the projected pool moves with it", async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: new Date(start.getTime() + 25 * HOUR).toISOString(),
    });
    assert.equal((await row(raceId)).maxDurationDays, 1);

    const poolOf = async () => {
      const res = await req("GET", `/races/${raceId}`, { token: creator.token });
      return (await res.json()).prizePool;
    };
    const before = await poolOf();
    assert.equal(before.durationDays, 1);
    assert.equal(before.durationPoints, 1);

    // Move the END out to a 10-day window.
    const newEnd = new Date(start.getTime() + 10 * DAY);
    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledEndAt: newEnd.toISOString() },
    });
    assert.equal(res.status, 200);
    assert.equal((await row(raceId)).maxDurationDays, 10);

    const after = await poolOf();
    assert.equal(after.durationDays, 10);
    assert.equal(after.durationPoints, 8);
    assert.ok(after.coins > before.coins, "the projected pool moved with the window");

    // Move only the START forward; the merged pair re-prices to 8 days.
    const res2 = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledStartAt: new Date(newEnd.getTime() - 8 * DAY).toISOString() },
    });
    assert.equal(res2.status, 200);
    assert.equal((await row(raceId)).maxDurationDays, 8);
  });

  it("7e: moving the scheduled start of a PLAIN preset race never touches its duration", async () => {
    const { creator, raceId } = await createRaceWithField(
      {
        maxDurationDays: 7,
        scheduledStartAt: new Date(Date.now() + HOUR).toISOString(),
      },
      { isPublic: false }
    );
    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledStartAt: new Date(Date.now() + 5 * HOUR).toISOString() },
    });
    assert.equal(res.status, 200);
    const after = await row(raceId);
    assert.equal(after.maxDurationDays, 7, "no window => no re-derivation");
    assert.equal(after.scheduledEndAt, null);
  });

  // ── 8 / 9 / 9b ────────────────────────────────────────────────────────────

  it("8: a custom race is settled by raceExpiry at its custom end", async () => {
    const end = new Date(Date.now() + 2 * DAY);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: end.toISOString(),
    });
    await req("POST", `/races/${raceId}/start`, { token: creator.token });

    const started = await row(raceId);
    assert.equal(started.endsAt.getTime(), end.getTime());

    // Not yet due: the cron must leave it alone until its custom end.
    await resolveExpiredRaces();
    assert.equal((await row(raceId)).status, "ACTIVE");

    await settle(raceId);
    const done = await row(raceId);
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.winnerUserId, "a winner was picked");
  });

  it("9: a 25-hour custom race prices at the 1-day band on BOTH projection and settlement, and a team race stamps teamPoolMultBps from the same number", async () => {
    const end = new Date(Date.now() + 25 * HOUR);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: end.toISOString(),
    });

    const detail = await req("GET", `/races/${raceId}`, { token: creator.token });
    const { prizePool } = await detail.json();
    assert.equal(prizePool.durationDays, 1);
    assert.equal(prizePool.durationPoints, 1, "the 1-day band, not the 2-day band");

    await req("POST", `/races/${raceId}/start`, { token: creator.token });
    await settle(raceId);
    // 2 walkers × durationPoints(1) × the permanent v2 unit 10 = 20.
    assert.equal(await poolPayoutTotal(raceId), 2 * 1 * 10);

    // Team: teamPoolMultBps is stamped at CREATE from the derived duration and
    // read back by settlement (architect R5).
    const teamCreator = await makeUser();
    const teamRes = await req("POST", "/races", {
      token: teamCreator.token,
      headers: TEAM_HEADERS,
      body: {
        name: "Team Priced",
        maxDurationDays: 14,
        isTeamRace: true,
        teamSize: 2,
        scheduledEndAt: new Date(Date.now() + 25 * HOUR).toISOString(),
      },
    });
    const teamRaceId = (await teamRes.json()).race.id;
    const teamRow = await row(teamRaceId);
    assert.equal(teamRow.maxDurationDays, 1);
    // LITERAL expected value, not a re-computation: asserting
    // resolveTeamPoolMultBps(row.maxDurationDays) against the same row is
    // tautological — it passes no matter what was stamped. 10000 is the 1.0x
    // SHORT band (<= 3 days), which is what a 1-day race must carry.
    assert.equal(
      teamRow.teamPoolMultBps,
      10000,
      "the multiplier is stamped from the DERIVED duration, not the client's 14"
    );
  });

  it("9b: THE anti-exploit lock — a 30-day window started with 25 hours left settles a ONE-day pool", async () => {
    const { creator, raceId } = await createRaceWithField({
      name: "Sit And Wait",
      maxDurationDays: 30,
      scheduledEndAt: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    // floor() of "30 days from the instant the server handled the request" is
    // 29 whole days; either way this is the top band (durationPoints 8).
    assert.ok(
      (await row(raceId)).maxDurationDays >= 29,
      "priced at the top duration band at create"
    );

    // 29 days pass with the race sitting PENDING (public races never auto-start
    // and nothing prunes them), leaving 25 hours of the window.
    const end = new Date(Date.now() + 25 * HOUR);
    await prisma.race.update({
      where: { id: raceId },
      data: { scheduledEndAt: end },
    });

    await req("POST", `/races/${raceId}/start`, { token: creator.token });
    const started = await row(raceId);
    assert.equal(started.endsAt.getTime(), end.getTime(), "the custom end is honored");
    assert.equal(
      started.maxDurationDays,
      1,
      "§5.3a: the priced duration is re-derived from the ACTUAL window at start"
    );

    await settle(raceId);
    // 2 walkers × durationPoints(1) × 10 = 20 coins. Without the re-derivation
    // this pays 2 × 8 × 10 = 160 — an 8x mint for a one-day race.
    assert.equal(await poolPayoutTotal(raceId), 20);
    assert.notEqual(await poolPayoutTotal(raceId), 160);
    assert.equal((await row(raceId)).prizePoolCoins, 20);
  });

  it("9c: the TEAM anti-exploit lock — a 14-day team window started with 25h left settles at 1.0x, not 1.875x", async () => {
    const { creator, raceId } = await createTeamRaceWithField({
      maxDurationDays: 14,
      scheduledEndAt: new Date(Date.now() + 14 * DAY).toISOString(),
    });
    const atCreate = await row(raceId);
    assert.equal(atCreate.maxDurationDays, 13, "floor(14d - request latency)");
    assert.equal(atCreate.teamPoolMultBps, 18750, "the 1.875x LONG band at create");

    // The teams sat uneven for 13 days; the window now has 25 hours left.
    const end = new Date(Date.now() + 25 * HOUR);
    await prisma.race.update({ where: { id: raceId }, data: { scheduledEndAt: end } });

    await req("POST", `/races/${raceId}/start`, { token: creator.token });
    const started = await row(raceId);
    assert.equal(started.endsAt.getTime(), end.getTime());
    assert.equal(started.maxDurationDays, 1, "duration re-priced from the actual window");
    assert.equal(
      started.teamPoolMultBps,
      10000,
      "the multiplier MUST move with the duration — settlement reads this column back"
    );

    await settle(raceId);
    // 2 walkers × durationPoints(1) × 10 × 1.0 = 20. With the stale 1.875x
    // multiplier this pays 40 after payout rounding, breaching the v2 rate.
    assert.equal(await poolPayoutTotal(raceId), 20);
    assert.equal((await row(raceId)).prizePoolCoins, 20);
  });

  it("7f: PATCHing a TEAM race's window re-stamps teamPoolMultBps in the same write", async () => {
    const { creator, raceId } = await createTeamRaceWithField({
      maxDurationDays: 14,
      scheduledEndAt: new Date(Date.now() + 14 * DAY).toISOString(),
    });
    assert.equal((await row(raceId)).teamPoolMultBps, 18750);

    const res = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledEndAt: new Date(Date.now() + 25 * HOUR).toISOString() },
    });
    assert.equal(res.status, 200);

    const after = await row(raceId);
    assert.equal(after.maxDurationDays, 1);
    assert.equal(
      after.teamPoolMultBps,
      10000,
      "shrinking the window must not leave the long-race buff behind"
    );

    // ...and widening it again re-stamps upward.
    const wide = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledEndAt: new Date(Date.now() + 10 * DAY).toISOString() },
    });
    assert.equal(wide.status, 200);
    const widened = await row(raceId);
    assert.equal(widened.maxDurationDays, 9);
    assert.equal(widened.teamPoolMultBps, 18750);
  });

  // ── 10 / 10b ──────────────────────────────────────────────────────────────

  it("10: the share preview carries the window before AND after start, and joining by token works in both states", async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const end = new Date(start.getTime() + 3 * DAY);
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledStartAt: start.toISOString(),
      scheduledEndAt: end.toISOString(),
    });

    const linkRes = await req("POST", `/races/${raceId}/share-link`, {
      token: creator.token,
    });
    assert.equal(linkRes.status, 201);
    const { shareToken: token } = await linkRes.json();
    assert.ok(token);

    const preview = await (await req("GET", `/races/share/${token}`)).json();
    assert.equal(new Date(preview.race.scheduledStartAt).getTime(), start.getTime());
    assert.equal(new Date(preview.race.scheduledEndAt).getTime(), end.getTime());
    assert.equal(preview.race.endsAt, null, "PENDING races carry no endsAt (§5.1)");
    assert.equal(preview.race.maxDurationDays, 3);
    assert.equal(preview.race.isJoinable, true);

    const joiner = await makeUser();
    const joinRes = await req("POST", `/races/share/${token}/join`, {
      token: joiner.token,
    });
    assert.equal(joinRes.status, 201, await joinRes.text());

    // The landing page renders the window rather than nothing.
    const page = await fetch(`${server.baseUrl}/r/${token}`);
    const html = await page.text();
    assert.match(html, /Starts /);
    assert.match(html, /Ends /);

    // After start, endsAt is the authority and the token still joins.
    await prisma.race.update({
      where: { id: raceId },
      data: { scheduledStartAt: new Date(Date.now() - MINUTE) },
    });
    await autoStartScheduledRaces();
    assert.equal((await row(raceId)).status, "ACTIVE");

    const preview2 = await (await req("GET", `/races/share/${token}`)).json();
    assert.equal(new Date(preview2.race.endsAt).getTime(), end.getTime());
    assert.equal(new Date(preview2.race.scheduledEndAt).getTime(), end.getTime());

    const joiner2 = await makeUser();
    const joinRes2 = await req("POST", `/races/share/${token}/join`, {
      token: joiner2.token,
    });
    assert.equal(joinRes2.status, 201, await joinRes2.text());
  });

  it("10b: a LATE auto-start (custom end already past) falls back to the duration", async () => {
    const { raceId } = await createRaceWithField(
      {
        maxDurationDays: 7,
        scheduledStartAt: new Date(Date.now() + 10 * MINUTE).toISOString(),
        // A 5-day-and-change window, so the derived (and thus fallback)
        // duration is unambiguously 5 days.
        scheduledEndAt: new Date(Date.now() + 10 * MINUTE + 5 * DAY + HOUR).toISOString(),
      },
      { isPublic: false }
    );
    assert.equal((await row(raceId)).maxDurationDays, 5);
    // The race sat PENDING well past its whole window.
    await prisma.race.update({
      where: { id: raceId },
      data: {
        scheduledStartAt: new Date(Date.now() - 6 * DAY),
        scheduledEndAt: new Date(Date.now() - 4 * DAY),
      },
    });

    await autoStartScheduledRaces();

    const started = await row(raceId);
    assert.equal(started.status, "ACTIVE");
    // Anchored to NOW (past the late-start grace clamp), and run for the full
    // stored duration — never an end before the start.
    assert.ok(started.endsAt.getTime() > started.startedAt.getTime());
    assert.equal(started.endsAt.getTime() - started.startedAt.getTime(), 5 * DAY);
    assert.equal(started.maxDurationDays, 5, "no re-derivation on the fallback path");
    assert.ok(started.scheduledEndAt, "the stale intent stays on the row");
  });

  it("10c: a LATE MANUAL start falls back the same way (the second reachable path)", async () => {
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: new Date(Date.now() + 5 * DAY + HOUR).toISOString(),
    });
    assert.equal((await row(raceId)).maxDurationDays, 5);
    await prisma.race.update({
      where: { id: raceId },
      data: { scheduledEndAt: new Date(Date.now() - 3 * HOUR) },
    });

    const res = await req("POST", `/races/${raceId}/start`, { token: creator.token });
    assert.equal(res.status, 200, "a late start is a NORMAL start (Q3)");
    const started = await row(raceId);
    assert.equal(started.endsAt.getTime() - started.startedAt.getTime(), 5 * DAY);
  });

  // ── 21 ────────────────────────────────────────────────────────────────────

  it("21: flag OFF => 403 FEATURE_DISABLED on create and on PATCH, never a silent drop", async () => {
    const end = new Date(Date.now() + 5 * DAY);
    // A race that already HAS a window, created while the flag was on.
    const { creator, raceId } = await createRaceWithField({
      maxDurationDays: 7,
      scheduledEndAt: end.toISOString(),
    });

    await appSettings.setFlag(FLAG, false);

    const createRes = await req("POST", "/races", {
      token: creator.token,
      body: {
        name: "Blocked Window",
        maxDurationDays: 7,
        scheduledEndAt: end.toISOString(),
      },
    });
    assert.equal(createRes.status, 403);
    assert.equal((await createRes.json()).code, "FEATURE_DISABLED");

    const patchRes = await req("PATCH", `/races/${raceId}`, {
      token: creator.token,
      body: { scheduledEndAt: new Date(Date.now() + 6 * DAY).toISOString() },
    });
    assert.equal(patchRes.status, 403);
    assert.equal((await patchRes.json()).code, "FEATURE_DISABLED");
    assert.equal(
      (await row(raceId)).scheduledEndAt.getTime(),
      end.getTime(),
      "the existing window is untouched — a rejected edit writes nothing"
    );

    // A race with no window is unaffected by the kill switch.
    const plain = await req("POST", "/races", {
      token: creator.token,
      body: { name: "Plain", maxDurationDays: 7 },
    });
    assert.equal(plain.status, 201);
  });

  it("21b: /auth/me carries customRaceWindowEnabled permanently enabled", async () => {
    await appSettings.setFlag(FLAG, false);
    const user = await makeUser();
    const off = await (await req("GET", "/auth/me", { token: user.token })).json();
    assert.equal(off.user.featureFlags.customRaceWindowEnabled, true);

    await appSettings.setFlag(FLAG, true);
    const user2 = await makeUser();
    const on = await (await req("GET", "/auth/me", { token: user2.token })).json();
    assert.equal(on.user.featureFlags.customRaceWindowEnabled, true);
  });
});
