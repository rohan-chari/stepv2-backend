const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  prisma,
  cleanDatabase,
  request,
  getSharedServer,
} = require("./setup");

// Onboarding revamp — backend half (docs/onboarding-revamp-requirements.md).
// Real HTTP, real DB, real handler chain. Never against prod: `npm run
// test:integration` pins DATABASE_URL to the local steps-tracker-integration DB.
describe("onboarding revamp", () => {
  let server;
  let nextAppleId = 0;

  const ADMIN_EMAIL =
    process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    // cleanDatabase() truncates users (cascading activation_events/referrals)
    // and races, but NOT app_settings. Clear ONLY the key this suite writes:
    // the integration DB is shared with every other suite and a blanket
    // appSetting/raceSeed wipe would yank state out from under them.
    await prisma.appSetting.deleteMany({
      where: { key: "onboardingV3Enabled" },
    });
    nextAppleId = 0;
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  async function signUp() {
    const appleId = `apple-onboarding-revamp-${++nextAppleId}-${Date.now()}`;
    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: appleId },
    });
    assert.equal(res.status, 200, "signup should succeed");
    const body = await res.json();
    return { userId: body.user.id, token: body.sessionToken, user: body.user };
  }

  async function signUpAdmin() {
    const admin = await signUp();
    await prisma.user.update({
      where: { id: admin.userId },
      data: { email: ADMIN_EMAIL },
    });
    return admin;
  }

  // `kind` is unique and race_seeds is never truncated by cleanDatabase, so an
  // upsert (not a create) is what keeps this suite re-runnable and keeps it from
  // clobbering seeds other suites rely on.
  async function createSeed(kind, overrides = {}) {
    const data = {
      name: `${kind} seed`,
      targetSteps: 10000,
      durationHours: 24,
      cadence: "DAILY",
      ...overrides,
    };
    return prisma.raceSeed.upsert({
      where: { kind },
      update: data,
      create: { id: `seed-${kind}`, kind, ...data },
    });
  }

  async function createSeededRace(seed, overrides = {}) {
    return prisma.race.create({
      data: {
        seedId: seed.id,
        name: overrides.name || `${seed.kind} race`,
        targetSteps: 10000,
        maxDurationDays: 1,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60 * 1000),
        timeBased: true,
        powerupsEnabled: true,
        ...overrides,
      },
    });
  }

  // Fill a race to maxParticipants with throwaway users.
  async function fillRace(race) {
    const count = race.maxParticipants ?? 10;
    for (let i = 0; i < count; i++) {
      const filler = await prisma.user.create({
        data: {
          appleId: `filler-${race.id}-${i}`,
          email: `filler-${race.id}-${i}@example.com`,
        },
      });
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: filler.id, status: "ACCEPTED" },
      });
    }
  }

  function activationEvent(overrides = {}) {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      name: "home_reached",
      appVersion: "2.1.0",
      platform: "ios",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  // ── §5.1 / §6.1 / §6.2 — the onboardingV3Enabled flag ─────────────────────

  it("1. GET /auth/me serves onboarding V3 permanently enabled", async () => {
    const { token } = await signUp();
    const res = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.featureFlags.onboardingV3Enabled, true);
    // Additive only — the pre-existing envelope keys must survive. Their VALUES
    // are not asserted: app_settings is shared with every other suite, so
    // another suite may legitimately have flipped one.
    for (const key of [
      "onboardingV2Enabled",
      "bannerAdsEnabled",
      "dualBoxBannersEnabled",
      "teamRacesEnabled",
    ]) {
      assert.equal(
        typeof body.user.featureFlags[key],
        "boolean",
        `${key} still served`
      );
    }
  });

  it("2. PATCH /admin/settings cannot change permanently enabled onboarding V3", async () => {
    const admin = await signUpAdmin();
    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { onboardingV3Enabled: false },
    });
    assert.equal(patch.status, 400);

    const { token } = await signUp();
    const me = await request(server.baseUrl, "GET", "/auth/me", { token });
    const body = await me.json();
    assert.equal(body.user.featureFlags.onboardingV3Enabled, true);
  });

  it("3. PATCH /admin/settings with an unknown key 400s", async () => {
    const admin = await signUpAdmin();
    const res = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: admin.token,
      body: { onboardingV4Enabled: true },
    });
    assert.equal(res.status, 400);
  });

  // ── §5.6 — enrollment guarantee ───────────────────────────────────────────

  it("4. signup with zero seeded races does not crash and warns AUTO_ENROLL_EMPTY", async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
    };
    let created;
    try {
      created = await signUp();
    } finally {
      console.warn = originalWarn;
    }

    const races = await request(server.baseUrl, "GET", "/races", {
      token: created.token,
    });
    assert.equal(races.status, 200);

    const participants = await prisma.raceParticipant.count({
      where: { userId: created.userId },
    });
    assert.equal(participants, 0);
    assert.ok(
      warnings.some((line) => line.includes("AUTO_ENROLL_EMPTY")),
      `expected an AUTO_ENROLL_EMPTY warn, got: ${JSON.stringify(warnings)}`
    );
  });

  it("5. signup enrolls in the most recent ACTIVE seeded race even when every seeded race is full", async () => {
    const seed = await createSeed("ONBOARDING_REVAMP_DAILY");
    const older = await createSeededRace(seed, {
      name: "Older active",
      maxParticipants: 2,
      startedAt: new Date(Date.now() - 10 * 60_000),
    });
    const newest = await createSeededRace(seed, {
      name: "Newest active",
      maxParticipants: 2,
      startedAt: new Date(Date.now() - 60_000),
    });
    await fillRace(older);
    await fillRace(newest);

    const created = await signUp();

    const rows = await prisma.raceParticipant.findMany({
      where: { userId: created.userId },
    });
    assert.equal(rows.length, 1, "exactly one over-capacity relaxation join");
    assert.equal(rows[0].raceId, newest.id);
    assert.equal(rows[0].status, "ACCEPTED");
  });

  it("6. signup with a PENDING-only seeded race enrolls but grants no welcome boxes", async () => {
    const seed = await createSeed("ONBOARDING_REVAMP_DAILY");
    const pending = await createSeededRace(seed, {
      name: "Upcoming",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
    });

    const created = await signUp();

    const rows = await prisma.raceParticipant.findMany({
      where: { userId: created.userId },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].raceId, pending.id);

    const boxes = await prisma.racePowerup.count({
      where: { userId: created.userId },
    });
    assert.equal(boxes, 0, "no welcome boxes without an ACTIVE seeded race");
  });

  // ── §5.6 / §6.6 — starter reward unpinned from DAILY_10K ──────────────────

  it("7. starter reward is claimable when the only ACTIVE seeded race is not DAILY_10K", async () => {
    const seed = await createSeed("ONBOARDING_REVAMP_OTHER");
    const race = await createSeededRace(seed, { name: "Weekend Warrior" });
    const created = await signUp();
    // Signup auto-enrolls; assert it landed rather than re-creating the row.
    const membership = await prisma.raceParticipant.findFirst({
      where: { userId: created.userId, raceId: race.id },
    });
    assert.ok(membership, "auto-enroll should have joined the non-Daily race");

    const eligibility = await request(
      server.baseUrl,
      "GET",
      "/onboarding/starter-reward",
      { token: created.token }
    );
    assert.equal(eligibility.status, 200);
    assert.deepEqual(await eligibility.json(), {
      eligible: true,
      claimed: false,
      amount: 100,
      raceId: race.id,
    });

    const claim = await request(
      server.baseUrl,
      "POST",
      "/onboarding/starter-reward/claim",
      { token: created.token }
    );
    assert.equal(claim.status, 200);
    assert.deepEqual(await claim.json(), { granted: true, coins: 100 });
  });

  it("8. starter reward and the legacy tutorial reward share one ledger key (100 coins, not 200)", async () => {
    const seed = await createSeed("ONBOARDING_REVAMP_OTHER");
    await createSeededRace(seed, { name: "Weekend Warrior" });
    const created = await signUp();

    const tutorial = await request(
      server.baseUrl,
      "POST",
      "/tutorial/complete-reward",
      { token: created.token }
    );
    assert.equal(tutorial.status, 200);
    const tutorialBody = await tutorial.json();
    assert.equal(tutorialBody.granted, true);

    const claim = await request(
      server.baseUrl,
      "POST",
      "/onboarding/starter-reward/claim",
      { token: created.token }
    );
    assert.equal(claim.status, 200);
    const claimBody = await claim.json();
    assert.equal(claimBody.granted, false, "second grant is a ledger no-op");
    assert.equal(claimBody.coins, 100, "still 100 coins total, never 200");
  });

  // ── §5.9 / §6.4 — analytics allowlist widening + soft drop ────────────────

  it("9. a batch with one unknown name is 202 with the rest inserted", async () => {
    const { token, userId } = await signUp();
    const good = activationEvent({ name: "home_reached" });
    const alsoGood = activationEvent({
      name: "health_result",
      context: { result: "granted" },
    });
    const unknown = activationEvent({ name: "totally_made_up_event" });

    const res = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [good, unknown, alsoGood] } }
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 2, inserted: 2 });

    const stored = await prisma.activationEvent.findMany({ where: { userId } });
    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((row) => row.name).sort(),
      ["health_result", "home_reached"]
    );
  });

  it("9b. all eight new event names are accepted", async () => {
    const { token, userId } = await signUp();
    const names = [
      "health_result",
      "health_escaped",
      "health_probe_inconclusive",
      "health_recovered",
      "notif_prompt_shown",
      "notif_result",
      "inviter_race_shown",
      "home_reached",
    ];
    const res = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token,
        body: { events: names.map((name) => activationEvent({ name })) },
      }
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 8, inserted: 8 });
    assert.equal(
      await prisma.activationEvent.count({ where: { userId } }),
      8
    );
  });

  it("10. a disallowed context value still 400s the whole batch", async () => {
    const { token } = await signUp();
    const res = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token,
        body: {
          events: [
            activationEvent({ name: "home_reached", context: { result: "banana" } }),
          ],
        },
      }
    );
    assert.equal(res.status, 400);
  });

  it("10b. a malformed appVersion / platform still 400s", async () => {
    const { token } = await signUp();
    const badVersion = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [activationEvent({ appVersion: "not a version" })] } }
    );
    assert.equal(badVersion.status, 400);

    const badPlatform = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [activationEvent({ platform: "windows" })] } }
    );
    assert.equal(badPlatform.status, 400);
  });

  // §5.11.8 — per-step tutorial drop-off. `step` rides the wire as a DECIMAL
  // STRING like every other context value (the client's context map is
  // Map<String, String>), so "3" is the valid form and a bare number 3 is not.
  it("10c. context.step is accepted for the strings \"1\"-\"10\" and stored as a string", async () => {
    const { token, userId } = await signUp();
    const res = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      {
        token,
        body: {
          events: [
            activationEvent({
              name: "tutorial_skipped",
              context: { source: "onboarding", step: "1" },
            }),
            activationEvent({
              name: "tutorial_skipped",
              context: { source: "onboarding", step: "5" },
            }),
            // Headroom above the 5 steps shipping now, so a longer tutorial
            // needs no backend deploy. Also the only two-digit case.
            activationEvent({
              name: "tutorial_skipped",
              context: { source: "onboarding", step: "10" },
            }),
            activationEvent({ name: "tutorial_completed" }),
          ],
        },
      }
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 4, inserted: 4 });

    const stored = await prisma.activationEvent.findMany({
      where: { userId, name: "tutorial_skipped" },
    });
    // Stored as strings — one wire format, so `context->>'step'` groups cleanly.
    assert.deepEqual(
      stored.map((row) => row.context.step).sort(),
      ["1", "10", "5"]
    );
    for (const row of stored) {
      assert.equal(typeof row.context.step, "string");
      assert.equal(row.context.source, "onboarding");
    }
  });

  it("10d. an out-of-range, malformed or non-string context.step 400s", async () => {
    const { token } = await signUp();
    const reject = async (step) => {
      const res = await request(
        server.baseUrl,
        "POST",
        "/analytics/activation-events",
        {
          token,
          body: {
            events: [activationEvent({ name: "tutorial_skipped", context: { step } })],
          },
        }
      );
      assert.equal(res.status, 400, `step=${JSON.stringify(step)} must 400`);
    };
    await reject("0");
    await reject("11");
    await reject("-1");
    await reject("2.5");
    await reject("03");
    await reject("");
    await reject(null);
    await reject(true);
    // ONE wire format. Accepting the bare number too would put mixed types in
    // the stored JSON and break grouping on context->>'step'.
    await reject(3);
  });

  it("11. duplicate event ids remain idempotent", async () => {
    const { token, userId } = await signUp();
    const event = activationEvent({ name: "home_reached" });
    const first = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [event] } }
    );
    assert.deepEqual(await first.json(), { accepted: 1, inserted: 1 });

    const replay = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [event] } }
    );
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { accepted: 1, inserted: 0 });
    assert.equal(await prisma.activationEvent.count({ where: { userId } }), 1);
  });

  // ── §6.3 — GET /referrals/inviter-race ────────────────────────────────────

  async function attachReferral({ referrerId, refereeId, sourceRaceId = null }) {
    return prisma.referral.create({
      data: {
        referrerId,
        refereeId,
        refereeSubHash: `sub-${refereeId}`,
        sourceRaceId,
      },
    });
  }

  async function createUserRace(creatorId, overrides = {}) {
    const race = await prisma.race.create({
      data: {
        creatorId,
        name: overrides.name || "Weekend Warriors",
        targetSteps: 10000,
        maxDurationDays: 2,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        timeBased: true,
        isPublic: true,
        maxParticipants: 10,
        ...overrides,
      },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: creatorId, status: "ACCEPTED" },
    });
    return race;
  }

  it("12a. a referred user gets the inviter's ACTIVE race", async () => {
    const inviter = await signUp();
    await prisma.user.update({
      where: { id: inviter.userId },
      data: { displayName: "Priya", profilePhotoUrl: null },
    });
    const race = await createUserRace(inviter.userId);
    await prisma.stepSample.create({
      data: {
        userId: inviter.userId,
        periodStart: new Date(Date.now() - 30 * 60 * 1000),
        periodEnd: new Date(Date.now() - 25 * 60 * 1000),
        steps: 2400,
      },
    });

    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });

    const res = await request(
      server.baseUrl,
      "GET",
      "/referrals/inviter-race",
      { token: referee.token }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.race, {
      id: race.id,
      name: "Weekend Warriors",
      status: "ACTIVE",
      endsAt: race.endsAt.toISOString(),
      participantCount: 1,
      alreadyJoined: false,
    });
    assert.deepEqual(body.inviter, {
      id: inviter.userId,
      displayName: "Priya",
      profilePhotoUrl: null,
      steps: 2400,
    });
  });

  it("12aa. a race-share referral prefers its exact source race over seeded fallback", async () => {
    const inviter = await signUp();
    const sourceRace = await createUserRace(inviter.userId, {
      name: "Shared quick race",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
    });

    const seed = await createSeed(`SOURCE_FALLBACK_${Date.now()}`);
    const seededRace = await createSeededRace(seed, {
      name: "Daily Challenge",
      startedAt: new Date(),
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: seededRace.id,
        userId: inviter.userId,
        status: "ACCEPTED",
      },
    });

    const referee = await signUp();
    await attachReferral({
      referrerId: inviter.userId,
      refereeId: referee.userId,
      sourceRaceId: sourceRace.id,
    });

    const res = await request(
      server.baseUrl,
      "GET",
      "/referrals/inviter-race",
      { token: referee.token }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.race.id, sourceRace.id);
    assert.equal(body.race.name, "Shared quick race");
    assert.equal(body.race.alreadyJoined, false);
  });

  it("12ab. generic inviter fallback excludes seeded and private races", async () => {
    const inviter = await signUp();
    await createUserRace(inviter.userId, {
      name: "Private race",
      isPublic: false,
    });
    const seed = await createSeed(`GENERIC_FALLBACK_${Date.now()}`);
    const seededRace = await createSeededRace(seed, { name: "Daily Challenge" });
    await prisma.raceParticipant.create({
      data: {
        raceId: seededRace.id,
        userId: inviter.userId,
        status: "ACCEPTED",
      },
    });

    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });

    const res = await request(
      server.baseUrl,
      "GET",
      "/referrals/inviter-race",
      { token: referee.token }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { race: null, inviter: null });
  });

  it("12b. an unreferred user gets {race:null, inviter:null}", async () => {
    const { token } = await signUp();
    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race", {
      token,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { race: null, inviter: null });
  });

  it("12c. an inviter with no joinable race gets {race:null, inviter:null}", async () => {
    const inviter = await signUp();
    await createUserRace(inviter.userId, {
      status: "COMPLETED",
      completedAt: new Date(),
    });
    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });

    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race", {
      token: referee.token,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { race: null, inviter: null });
  });

  it("12d. unauthenticated gets 401", async () => {
    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race");
    assert.equal(res.status, 401);
  });

  it("12e. ACTIVE is preferred over PENDING, then most recent startedAt", async () => {
    const inviter = await signUp();
    await createUserRace(inviter.userId, {
      name: "Pending one",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
    });
    await createUserRace(inviter.userId, {
      name: "Old active",
      startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });
    await createUserRace(inviter.userId, {
      name: "Recent active",
      startedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });

    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race", {
      token: referee.token,
    });
    const body = await res.json();
    assert.equal(body.race.name, "Recent active");
  });

  it("12f. a race the caller already joined is returned with alreadyJoined:true", async () => {
    const inviter = await signUp();
    const race = await createUserRace(inviter.userId);
    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: referee.userId, status: "ACCEPTED" },
    });

    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race", {
      token: referee.token,
    });
    const body = await res.json();
    assert.equal(body.race.id, race.id);
    assert.equal(body.race.alreadyJoined, true);
    assert.equal(body.race.participantCount, 2);
  });

  it("13. tournament matchup races and at-capacity races are excluded", async () => {
    const inviter = await signUp();
    const tournament = await prisma.tournament.create({
      data: {
        name: "Daily Dash",
        status: "ACTIVE",
        bracketSize: 4,
        matchupDurationDays: 1,
        totalRounds: 2,
      },
    });
    await createUserRace(inviter.userId, {
      name: "Matchup",
      tournamentId: tournament.id,
      tournamentRound: 1,
      tournamentMatchIndex: 0,
      startedAt: new Date(Date.now() - 60_000),
    });
    const full = await createUserRace(inviter.userId, {
      name: "Full race",
      maxParticipants: 1,
      startedAt: new Date(Date.now() - 120_000),
    });
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId: full.id } }),
      1
    );

    const referee = await signUp();
    await attachReferral({ referrerId: inviter.userId, refereeId: referee.userId });

    const res = await request(server.baseUrl, "GET", "/referrals/inviter-race", {
      token: referee.token,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { race: null, inviter: null });
  });

  // ── GET /referrals/:code — inviterRace ordering regression ────────────────
  // Not part of the onboarding-revamp contract, but the same wrong assumption
  // this suite caught in getInviterRace ("status: asc sorts active before
  // pending") shipped in getReferralPreview, which is what a referred user sees
  // when they open an invite link. Postgres orders enums by DECLARATION order
  // and RaceStatus declares PENDING first, so invitees were being shown
  // "starts Thursday" lobbies instead of the live race.
  it("13b. GET /referrals/:code prefers the inviter's ACTIVE race over a PENDING one", async () => {
    const inviter = await signUp();
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: inviter.token,
    });
    assert.equal(link.status, 200);
    const { code } = await link.json();
    assert.ok(code, "inviter has a referral code");

    await createUserRace(inviter.userId, {
      name: "Pending lobby",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
      isPublic: true,
    });
    const active = await createUserRace(inviter.userId, {
      name: "Live race",
      isPublic: true,
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    // Public route — deliberately no token, exactly as the invite landing hits it.
    const res = await request(server.baseUrl, "GET", `/referrals/${code}`);
    assert.equal(res.status, 200);
    const { referral } = await res.json();
    assert.ok(referral.inviterRace, "an inviter race is offered");
    assert.equal(referral.inviterRace.id, active.id);
    assert.equal(referral.inviterRace.name, "Live race");
    assert.equal(referral.inviterRace.status, "ACTIVE");
  });

  it("13bb. GET /referrals/:code excludes seeded races from the inviter fallback", async () => {
    const inviter = await signUp();
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: inviter.token,
    });
    assert.equal(link.status, 200);
    const { code } = await link.json();

    const humanRace = await createUserRace(inviter.userId, {
      name: "Shared human race",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
      isPublic: true,
    });
    const seed = await createSeed(`PUBLIC_PREVIEW_${Date.now()}`);
    const seededRace = await createSeededRace(seed, {
      name: "Daily Challenge",
      startedAt: new Date(),
      isPublic: true,
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: seededRace.id,
        userId: inviter.userId,
        status: "ACCEPTED",
      },
    });

    const res = await request(server.baseUrl, "GET", `/referrals/${code}`);
    assert.equal(res.status, 200);
    const { referral } = await res.json();
    assert.equal(referral.inviterRace.id, humanRace.id);
    assert.equal(referral.inviterRace.name, "Shared human race");
  });

  it("13c. GET /referrals/:code still offers a PENDING race when that is all there is", async () => {
    const inviter = await signUp();
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: inviter.token,
    });
    const { code } = await link.json();
    const pending = await createUserRace(inviter.userId, {
      name: "Pending lobby",
      status: "PENDING",
      startedAt: null,
      endsAt: null,
      isPublic: true,
    });

    const res = await request(server.baseUrl, "GET", `/referrals/${code}`);
    const { referral } = await res.json();
    assert.equal(referral.inviterRace.id, pending.id);
    assert.equal(referral.inviterRace.status, "PENDING");
  });

  // ── §6.5 — admin onboarding funnel ────────────────────────────────────────

  it("14. GET /admin/stats reports onboardingFunnel with distinct-session counts", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    const sessionA = "session-aaaa-1111";
    const sessionB = "session-bbbb-2222";

    const events = [
      // Session A: started -> cta -> granted -> daily intro -> home
      activationEvent({ name: "onboarding_started", onboardingSessionId: sessionA }),
      activationEvent({ name: "health_cta_tapped", onboardingSessionId: sessionA }),
      // Two health_result rows in one session must still count as ONE session.
      activationEvent({
        name: "health_result",
        onboardingSessionId: sessionA,
        context: { result: "denied" },
      }),
      activationEvent({
        name: "health_result",
        onboardingSessionId: sessionA,
        context: { result: "granted" },
      }),
      activationEvent({ name: "daily_intro_viewed", onboardingSessionId: sessionA }),
      activationEvent({ name: "home_reached", onboardingSessionId: sessionA }),
      // Session B (android): started, then falls out after an inconclusive probe.
      activationEvent({
        name: "onboarding_started",
        onboardingSessionId: sessionB,
        platform: "android",
      }),
      activationEvent({
        name: "health_probe_inconclusive",
        onboardingSessionId: sessionB,
        platform: "android",
      }),
    ];

    const post = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      { token, body: { events } }
    );
    assert.equal(post.status, 202);

    const res = await request(server.baseUrl, "GET", "/admin/stats", {
      token: admin.token,
    });
    assert.equal(res.status, 200);
    const { stats } = await res.json();
    const funnel = stats.onboardingFunnel;
    assert.ok(funnel, "onboardingFunnel section is present");
    assert.equal(funnel.windowDays, 7);
    assert.ok(funnel.byPlatform.ios, "ios bucket always present");
    assert.ok(funnel.byPlatform.android, "android bucket always present");

    assert.deepEqual(funnel.byPlatform.ios, {
      onboarding_started: 1,
      health_cta_tapped: 1,
      health_granted: 1,
      health_escaped: 0,
      health_probe_inconclusive: 0,
      daily_intro_viewed: 1,
      tutorial_opened: 0,
      demo_box_opened: 0,
      demo_powerup_used: 0,
      demo_won: 0,
      tutorial_completed: 0,
      home_reached: 1,
    });
    assert.deepEqual(funnel.byPlatform.android, {
      onboarding_started: 1,
      health_cta_tapped: 0,
      health_granted: 0,
      health_escaped: 0,
      health_probe_inconclusive: 1,
      daily_intro_viewed: 0,
      tutorial_opened: 0,
      demo_box_opened: 0,
      demo_powerup_used: 0,
      demo_won: 0,
      tutorial_completed: 0,
      home_reached: 0,
    });

    // Pre-existing sections must be untouched (additive-only contract).
    assert.ok(stats.activationFunnel, "activationFunnel still present");
    assert.ok(stats.referralFunnel, "referralFunnel still present");
  });

  it("14b. events with no onboardingSessionId are not counted in the funnel", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();
    await request(server.baseUrl, "POST", "/analytics/activation-events", {
      token,
      body: { events: [activationEvent({ name: "home_reached" })] },
    });

    const res = await request(server.baseUrl, "GET", "/admin/stats", {
      token: admin.token,
    });
    const { stats } = await res.json();
    assert.equal(stats.onboardingFunnel.byPlatform.ios.home_reached, 0);
  });
});
