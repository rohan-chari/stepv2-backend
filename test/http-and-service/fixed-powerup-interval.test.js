const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRenewSeededRaces,
} = require("../../src/modules/races/jobs/seededRaceRenewal");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../src/shared/time/week");

// Fixed 2,000-step powerup interval (spec §9, backend tests 1-9).
//
// The creator-chosen interval is retired: every powerup-enabled competition is
// 2,000 steps per box, decided by the server. The interesting half is old
// binaries — a frozen client keeps sending its own value forever and must get a
// 201 and a 2,000-step race, never a 400 (spec §5.4, CLAUDE.md rule #1).
//
// Everything runs through real HTTP + the real DB; the grandfathered-race case
// runs the actual box-minting path so "no retroactive minting" (§4.3) is proved
// by boxes on disk, not by a helper's return value.

const FIXED = 2000;
const TZ = "America/New_York";
const DAY_MS = 24 * 60 * 60 * 1000;
const TOURNAMENT_FEATURE = "tournaments";
const TEST_SEED_ID = "seed-fpi-interval-test";

let server;
let seq = 0;

function req(method, path, { body, token, headers } = {}) {
  return request(server.baseUrl, method, path, {
    body,
    token,
    headers: { "X-Client-Features": TOURNAMENT_FEATURE, "x-timezone": TZ, ...headers },
  });
}

async function makeUser() {
  const appleId = `apple-fpi-${++seq}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  const userId = body.user.id;
  // Stamps the sticky clientFeatures (tournaments) used by createTournament.
  await req("GET", "/races", { token });
  return { userId, token };
}

// Create a race through the public endpoint and return { status, race, id }.
async function createRace(token, body) {
  const res = await req("POST", "/races", {
    token,
    body: { name: "Interval Race", maxDurationDays: 7, isPublic: true, ...body },
  });
  const json = res.status === 201 ? await res.json() : await res.json().catch(() => ({}));
  return { status: res.status, race: json.race, body: json };
}

// The interval a client actually sees on GET /races/:id.
async function detailInterval(token, raceId) {
  const res = await req("GET", `/races/${raceId}`, { token });
  assert.equal(res.status, 200, `GET /races/${raceId} -> ${res.status}`);
  const body = await res.json();
  const race = body.race || body;
  return race.powerupStepInterval;
}

async function storedInterval(raceId) {
  const row = await prisma.race.findUnique({ where: { id: raceId } });
  return row.powerupStepInterval;
}

describe("fixed 2,000-step powerup interval", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    seq = 0;
    await appSettings.setFlag("tournamentsEnabled", true);
  });

  after(async () => {
    // race_seeds are not truncated by cleanDatabase — remove the fixture seed so
    // it can never leak an extra featured challenge into another test file.
    await prisma.race.deleteMany({ where: { seedId: TEST_SEED_ID } });
    await prisma.raceSeed.deleteMany({ where: { id: TEST_SEED_ID } });
  });

  // ── 1. the old-binary case ──────────────────────────────────────────────────

  it("1: POST /races from a frozen client sending 10000 stores and reports 2000", async () => {
    const { token } = await makeUser();
    const { status, race } = await createRace(token, {
      powerupsEnabled: true,
      powerupStepInterval: 10000,
    });

    assert.equal(status, 201, "an old binary must never be 400ed over this field");
    assert.equal(race.powerupStepInterval, FIXED, "create response");
    assert.equal(await storedInterval(race.id), FIXED, "stored row");
    assert.equal(
      await detailInterval(token, race.id),
      FIXED,
      "the old client's race-detail screen reads 2000 back from the server"
    );
  });

  // ── 2. new client / field omitted ───────────────────────────────────────────

  it("2: POST /races with powerupStepInterval omitted stores 2000", async () => {
    const { token } = await makeUser();
    const { status, race } = await createRace(token, { powerupsEnabled: true });

    assert.equal(status, 201);
    assert.equal(race.powerupStepInterval, FIXED);
    assert.equal(await storedInterval(race.id), FIXED);
  });

  // ── 3. the retired validation error ─────────────────────────────────────────

  it("3: POST /races with an out-of-band 999 is a 201, not a 400", async () => {
    const { token } = await makeUser();
    const { status, race, body } = await createRace(token, {
      powerupsEnabled: true,
      powerupStepInterval: 999,
    });

    assert.equal(
      status,
      201,
      `999 must be ignored, not rejected; got ${status} ${JSON.stringify(body)}`
    );
    assert.equal(race.powerupStepInterval, FIXED);
    assert.equal(await storedInterval(race.id), FIXED);
  });

  // ── 4. powerups off ─────────────────────────────────────────────────────────

  it("4: POST /races with powerupsEnabled false stores a null interval", async () => {
    const { token } = await makeUser();
    const { status, race } = await createRace(token, {
      powerupsEnabled: false,
      powerupStepInterval: 5000,
    });

    assert.equal(status, 201);
    assert.equal(race.powerupsEnabled, false);
    assert.equal(race.powerupStepInterval, null);
    assert.equal(await storedInterval(race.id), null);
  });

  // ── 5. tournaments + their matchup races ────────────────────────────────────

  it("5: POST /tournaments pins 2000 on the bracket AND its first-round races", async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await makeUser());

    const created = await req("POST", "/tournaments", {
      token: users[0].token,
      body: {
        name: "Interval Cup",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 0,
        isPublic: true,
        powerupsEnabled: true,
        powerupStepInterval: 25000,
      },
    });
    assert.equal(created.status, 201, `create tournament -> ${created.status}`);
    const { tournament } = await created.json();
    assert.equal(tournament.powerupStepInterval, FIXED, "create response");

    const row = await prisma.tournament.findUnique({ where: { id: tournament.id } });
    assert.equal(row.powerupsEnabled, true);
    assert.equal(row.powerupStepInterval, FIXED, "stored tournament row");

    // Fill the bracket; the last joiner pops it ACTIVE and creates round 1.
    for (const user of users.slice(1)) {
      const join = await req("POST", `/tournaments/${tournament.id}/join`, {
        token: user.token,
      });
      assert.equal(join.status, 201, `join -> ${join.status}`);
    }

    const matchups = await prisma.race.findMany({
      where: { tournamentId: tournament.id, tournamentRound: 1 },
    });
    assert.equal(matchups.length, 2, "a 4-bracket opens with 2 first-round races");
    for (const match of matchups) {
      assert.equal(match.powerupsEnabled, true);
      assert.equal(
        match.powerupStepInterval,
        FIXED,
        "bracket matches inherit the pinned interval"
      );
    }
  });

  // ── 6. PATCH is inert, not an error ─────────────────────────────────────────

  it("6: PATCH /races/:id sending 5000 returns 200 and leaves the race at 2000", async () => {
    const { token } = await makeUser();
    const { race } = await createRace(token, {
      powerupsEnabled: true,
      powerupStepInterval: FIXED,
    });

    const patch = await req("PATCH", `/races/${race.id}`, {
      token,
      body: { powerupStepInterval: 5000 },
    });
    assert.equal(patch.status, 200, "an old client's edit must not 400");
    const patched = (await patch.json()).race;
    assert.equal(patched.powerupStepInterval, FIXED, "response echoes the stored value");
    assert.equal(await storedInterval(race.id), FIXED, "nothing persisted");
    assert.equal(await detailInterval(token, race.id), FIXED, "refetch shows the truth");
  });

  // ── 7. flipping powerups on via PATCH arms 2000 ─────────────────────────────

  it("7: PATCH flipping powerupsEnabled false -> true sets the interval to 2000", async () => {
    const { token } = await makeUser();
    const { race } = await createRace(token, { powerupsEnabled: false });
    assert.equal(await storedInterval(race.id), null);

    const patch = await req("PATCH", `/races/${race.id}`, {
      token,
      body: { powerupsEnabled: true },
    });
    assert.equal(patch.status, 200);
    const patched = (await patch.json()).race;
    assert.equal(patched.powerupsEnabled, true);
    assert.equal(patched.powerupStepInterval, FIXED);
    assert.equal(await storedInterval(race.id), FIXED);
  });

  // ── 8. a grandfathered race keeps its cadence (§4.3) ────────────────────────

  it("8: a pre-deploy 5000-step race is untouched by PATCH and still paces boxes at 5000", async () => {
    const { userId, token } = await makeUser();
    const { race } = await createRace(token, {
      powerupsEnabled: true,
      powerupStepInterval: FIXED,
      maxDurationDays: 14,
    });
    const raceId = race.id;

    // Rewrite the row to what a race created BEFORE this deploy looks like.
    await prisma.race.update({
      where: { id: raceId },
      data: { powerupsEnabled: true, powerupStepInterval: 5000 },
    });

    // A frozen edit screen "saves" 2000 onto it. That must be dropped on the
    // floor: coercing a running race downward back-mints boxes via the
    // rollPowerup ratchet (§4.3 — the public-join over-grant bug class).
    const patch = await req("PATCH", `/races/${raceId}`, {
      token,
      body: { powerupStepInterval: FIXED, name: "Grandfathered" },
    });
    assert.equal(patch.status, 200);
    assert.equal(
      await storedInterval(raceId),
      5000,
      "PATCH must never re-point a race's interval"
    );

    // Now run it: the box cadence must still be 5,000.
    const nowParts = getTimeZoneParts(new Date(), TZ);
    const todayEt = formatDateString(nowParts.year, nowParts.month, nowParts.day);
    const yEt = addDaysToDateString(todayEt, -1);
    const y = parseDateString(yEt);
    const startEt = parseDateString(addDaysToDateString(yEt, -1));
    const startedAt = zonedDateTimeToUtc(
      { year: startEt.year, month: startEt.month, day: startEt.day, hour: 12, minute: 0, second: 0 },
      TZ
    );

    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        timeBased: true,
        timezone: TZ,
        startedAt,
        endsAt: new Date(Date.now() + 4 * DAY_MS),
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId },
      data: { joinedAt: startedAt, nextBoxAtSteps: 5000 },
    });

    // 7,000 raw steps yesterday (ET), the way a real device reports them: an
    // evening sample plus the daily total row covering the same steps.
    const eveningStart = zonedDateTimeToUtc(
      { year: y.year, month: y.month, day: y.day, hour: 23, minute: 0, second: 0 },
      TZ
    );
    const eveningEnd = zonedDateTimeToUtc(
      { year: y.year, month: y.month, day: y.day, hour: 23, minute: 30, second: 0 },
      TZ
    );
    await prisma.stepSample.create({
      data: {
        userId,
        periodStart: eveningStart,
        periodEnd: eveningEnd,
        steps: 7000,
      },
    });
    await prisma.step.create({
      data: {
        userId,
        steps: 7000,
        date: new Date(Date.UTC(y.year, y.month - 1, y.day)),
      },
    });

    const progressRes = await req("GET", `/races/${raceId}/progress`, { token });
    assert.equal(progressRes.status, 200);
    const { progress } = await progressRes.json();

    assert.equal(
      progress.powerupData.powerupStepInterval,
      5000,
      "the race reports its own historical interval"
    );
    assert.equal(
      progress.powerupData.stepsUntilNextPowerup,
      10000 - 7000,
      "countdown paces at 5,000 (next box at 10,000)"
    );

    const milestones = (
      await prisma.racePowerup.findMany({ where: { raceId, userId } })
    )
      .filter((p) => p.earnedAtSteps != null && p.earnedAtSteps >= FIXED)
      .map((p) => p.earnedAtSteps)
      .sort((a, b) => a - b);
    assert.deepEqual(
      milestones,
      [5000],
      `7,000 steps at a 5,000 interval is exactly ONE box; got [${milestones.join(", ")}] ` +
        `— a 2,000 cadence would back-mint 2000/4000/6000`
    );
  });

  // ── 9. seeded daily/weekly renewal ──────────────────────────────────────────

  it("9: seededRaceRenewal mints 2000 from a seed whose column still says 2500", async () => {
    await prisma.raceSeed.upsert({
      where: { id: TEST_SEED_ID },
      update: {
        active: true,
        powerupsEnabled: true,
        powerupStepInterval: 2500,
      },
      create: {
        id: TEST_SEED_ID,
        kind: "FPI_DAILY_TEST",
        name: "Interval Test Daily",
        targetSteps: 10000,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 500,
        powerupsEnabled: true,
        powerupStepInterval: 2500,
        timeBased: true,
        active: true,
      },
    });

    const renew = buildRenewSeededRaces({ prisma });
    await renew();

    const races = await prisma.race.findMany({ where: { seedId: TEST_SEED_ID } });
    assert.ok(races.length >= 1, "renewal must mint at least the ACTIVE race");
    for (const race of races) {
      assert.equal(race.powerupsEnabled, true);
      assert.equal(
        race.powerupStepInterval,
        FIXED,
        "the seed column is no longer read — 2000 always"
      );
    }
  });
});
