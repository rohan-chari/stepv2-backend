const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { buildRenewSeededRaces } = require("../../src/modules/races/jobs/seededRaceRenewal");
const { upcomingWindowFor } = require("../../src/modules/races/services/seededRaceBuckets");

const BUCKET_HEADERS = { "X-Client-Features": "seeded_race_buckets" };

function silentRenew() {
  return buildRenewSeededRaces({ prisma, logger: { log() {}, error() {} } });
}

// Prod regression, 2026-08-16/17: every bucket-capable auto-join account landed
// back in the 450-person legacy "Daily Challenge" field.
//
// The renewal tick that CREATES a window's upcoming race is the only tick where
// no durable mode row exists yet, and readWindowMode's mixed-deploy default is
// LEGACY. Commit a5a3ddb moved autoEnroll() ahead of the mode stamp, so on that
// one tick enrollAutoJoinUsers saw "LEGACY", skipped its capability exclusion,
// and claimLegacyStream wrote a write-once LEGACY ledger row for EVERY capable
// user. electAutomatic(), running milliseconds later under the now-BUCKET mode,
// found them all already taken and elected nobody — so no buckets were ever
// finalized and the whole cohort raced in the global field.
//
// These assertions are all on the window's FIRST tick on purpose: a test that
// pre-stamps the mode (as the rest of the suite does) cannot see this bug.
describe("seeded bucket election ordering (integration)", () => {
  let baseUrl;

  before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("seededRaceBucketsEnabled", true);
  });

  it("elects capable auto-join users into BUCKET on the tick that creates the window, never into the legacy field", async () => {
    const capable = await createTestUser({
      autoJoinFeaturedRaces: true,
      clientFeatures: ["seeded_race_buckets"],
    });
    const frozen = await createTestUser({ autoJoinFeaturedRaces: true });

    await silentRenew()();

    for (const kind of ["DAILY_10K", "WEEKLY_50K"]) {
      const seed = await prisma.raceSeed.findUnique({ where: { kind } });
      const { windowStart } = upcomingWindowFor(seed, new Date());
      const where = { seedId: seed.id, windowStart };

      const rows = await prisma.seededRaceWindowMembership.findMany({
        where: { ...where, userId: { in: [capable.user.id, frozen.user.id] } },
      });
      assert.equal(
        rows.find((row) => row.userId === capable.user.id)?.stream,
        "BUCKET",
        `${kind}: capable auto-join user must be elected to the private stream on the creating tick`
      );
      assert.equal(
        rows.find((row) => row.userId === frozen.user.id)?.stream,
        "LEGACY",
        `${kind}: a frozen client stays on the global field`
      );

      const legacyRace = await prisma.race.findFirst({
        where: { seedId: seed.id, status: "PENDING", scheduledStartAt: windowStart, seededBucketId: null },
      });
      assert.ok(legacyRace, `${kind}: the compat global race still exists`);
      assert.equal(
        await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: capable.user.id } }),
        0,
        `${kind}: capable user must not be a participant of the global field`
      );
      assert.equal(
        await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: frozen.user.id } }),
        1,
        `${kind}: frozen client must be a participant of the global field`
      );
    }
  });

  it("keeps the election stable across the every-tick retry a5a3ddb added", async () => {
    const capable = await createTestUser({
      autoJoinFeaturedRaces: true,
      clientFeatures: ["seeded_race_buckets"],
    });
    const renew = silentRenew();

    await renew();
    await renew();
    await renew();

    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart } = upcomingWindowFor(seed, new Date());
    const rows = await prisma.seededRaceWindowMembership.findMany({
      where: { seedId: seed.id, windowStart, userId: capable.user.id },
    });
    assert.equal(rows.length, 1, "the ledger stays write-once across repeated ticks");
    assert.equal(rows[0].stream, "BUCKET");
    const legacyRace = await prisma.race.findFirst({
      where: { seedId: seed.id, status: "PENDING", scheduledStartAt: windowStart, seededBucketId: null },
    });
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId: legacyRace.id, userId: capable.user.id } }),
      0
    );
  });

  it("still backfills an auto-join user who becomes eligible after the window's creating tick", async () => {
    const renew = silentRenew();
    await renew();

    const latecomer = await createTestUser({ clientFeatures: ["seeded_race_buckets"] });
    assert.equal(
      (await request(baseUrl, "PUT", "/auth/me/featured-auto-join", {
        token: latecomer.token, body: { enabled: true }, headers: BUCKET_HEADERS,
      })).status,
      200
    );
    await renew();

    const seed = await prisma.raceSeed.findUnique({ where: { kind: "DAILY_10K" } });
    const { windowStart } = upcomingWindowFor(seed, new Date());
    const membership = await prisma.seededRaceWindowMembership.findUnique({
      where: { seedId_windowStart_userId: { seedId: seed.id, windowStart, userId: latecomer.user.id } },
    });
    assert.equal(membership?.stream, "BUCKET");
  });
});
