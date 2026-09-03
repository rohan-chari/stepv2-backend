// Batch 2026-08-08 — Item 9: "Admin stats: users per app version + private
// race count".
//
// Two things are under test, and they are coupled:
//
//   1. A STICKY, RATE-LIMITED write of `users.last_app_version` /
//      `users.last_seen_at` from the X-App-Version header inside requireAuth.
//      The write fires ONLY when the version changed or the stored lastSeenAt
//      is on an earlier UTC day — never per request (commit 3e6c827's
//      write-amplification/pool-exhaustion lesson).
//   2. The additive `versions` / `races` sections of GET /admin/stats that
//      read those columns.
//
// Everything below goes through real HTTP against the real handler chain and
// the real Postgres. The only non-HTTP reads are direct `prisma.user.findUnique`
// assertions on the STORED ROW — that is the observable the middleware exists
// to produce and it is deliberately NOT exposed through any endpoint (see the
// /auth/me leak test), so there is no public path that could assert it.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

let server;
let nextId = 0;

function uniq(prefix) {
  return `${prefix}-${++nextId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function signUp() {
  const appleId = uniq("apple-v9");
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  assert.equal(res.status, 200, "sign-in should succeed");
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken, appleId };
}

async function signUpAdmin() {
  const admin = await signUp();
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

// GET /auth/me is the cheapest authenticated endpoint, so it is the vehicle for
// every sticky-write case. No X-Client-Features / X-Timezone headers are sent:
// those carry their OWN sticky writes (which DO invalidate the /auth/me cache),
// and including them would contaminate the "no extra write / no invalidation"
// assertions.
function me(token, appVersion) {
  return request(server.baseUrl, "GET", "/auth/me", {
    token,
    headers: appVersion === undefined ? {} : { "X-App-Version": appVersion },
  });
}

function meWithFeatures(token, features) {
  return request(server.baseUrl, "GET", "/auth/me", {
    token,
    headers: { "X-Client-Features": features },
  });
}

function readRow(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { lastAppVersion: true, lastSeenAt: true },
  });
}

async function waitForRow(userId, predicate, description, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  do {
    row = await readRow(userId);
    if (predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`${description}; last row: ${JSON.stringify(row)}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("batch 2026-08-08 item 9 — app-version sticky write", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("stores X-App-Version and lastSeenAt on the first authenticated request", async () => {
    const user = await signUp();

    const before = await readRow(user.userId);
    assert.equal(before.lastAppVersion, null, "starts null (no backfill)");
    assert.equal(before.lastSeenAt, null);

    const res = await me(user.token, "2.1.2");
    assert.equal(res.status, 200);

    const after = await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "deferred first-sighting write should become durable"
    );
    assert.equal(after.lastAppVersion, "2.1.2");
    assert.ok(after.lastSeenAt instanceof Date, "lastSeenAt is stamped");
    assert.ok(
      Date.now() - after.lastSeenAt.getTime() < 60_000,
      "lastSeenAt is roughly now"
    );
  });

  it("atomically preserves divergent capability headers from concurrent authenticated requests", async () => {
    const user = await signUp();
    const responses = await Promise.all([
      meWithFeatures(user.token, "from_left"),
      meWithFeatures(user.token, "from_right"),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      select: { clientFeatures: true },
    });
    assert.deepEqual(stored.clientFeatures, ["from_left", "from_right"]);
  });

  it("performs NO write on a second same-day request with the SAME version", async () => {
    const user = await signUp();

    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const first = await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "deferred first-sighting write should become durable"
    );

    // Enough wall-clock that a per-request write would move the timestamp.
    await new Promise((r) => setTimeout(r, 25));

    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const second = await readRow(user.userId);

    assert.equal(
      second.lastSeenAt.getTime(),
      first.lastSeenAt.getTime(),
      "lastSeenAt must be byte-identical — a second same-day request writes nothing"
    );
    assert.equal(second.lastAppVersion, "2.1.2");

    // And a third, for good measure.
    await new Promise((r) => setTimeout(r, 25));
    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const third = await readRow(user.userId);
    assert.equal(third.lastSeenAt.getTime(), first.lastSeenAt.getTime());
  });

  it("writes when the version CHANGES within the same day", async () => {
    const user = await signUp();

    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const first = await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "initial app-version write should become durable"
    );

    await new Promise((r) => setTimeout(r, 25));

    assert.equal((await me(user.token, "2.2.0")).status, 200);
    const second = await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.2.0",
      "changed app version should become durable"
    );

    assert.equal(second.lastAppVersion, "2.2.0", "upgrade lands at once");
    assert.ok(
      second.lastSeenAt.getTime() > first.lastSeenAt.getTime(),
      "the combined UPDATE also moves lastSeenAt"
    );
  });

  it("writes on the next request when the stored lastSeenAt is on an earlier UTC day", async () => {
    const user = await signUp();

    assert.equal((await me(user.token, "2.1.2")).status, 200);
    await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "initial app-version write should become durable before backdating"
    );

    // Back-date 36h so the stored value is unambiguously an earlier UTC date
    // no matter what time of day the suite runs.
    const yesterday = new Date(Date.now() - 1.5 * DAY_MS);
    await prisma.user.update({
      where: { id: user.userId },
      data: { lastSeenAt: yesterday },
    });
    require("../../src/modules/users/services/authSessionUserCache").clear();

    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const after = await waitForRow(
      user.userId,
      (row) => row.lastSeenAt?.getTime() > yesterday.getTime() + DAY_MS,
      "new-day sighting should become durable"
    );

    assert.ok(
      after.lastSeenAt.getTime() > yesterday.getTime() + DAY_MS,
      "a new UTC day re-stamps lastSeenAt even though the version is unchanged"
    );
    assert.equal(after.lastAppVersion, "2.1.2");
  });

  it("rejects a malformed / oversized X-App-Version without storing it, and still returns 200", async () => {
    const user = await signUp();

    // Establish a known-good stored value first.
    assert.equal((await me(user.token, "2.1.2")).status, 200);
    const good = await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "known-good version should become durable"
    );

    const junk = [
      "'; DROP TABLE users; --",
      "9".repeat(200),
      "not-a-version",
      "2.1.2 OR 1=1",
      "<script>alert(1)</script>",
      "1.2.3.4.5.6",
    ];

    for (const value of junk) {
      const res = await me(user.token, value);
      assert.equal(res.status, 200, `request must still succeed for ${value}`);
      const row = await readRow(user.userId);
      assert.equal(
        row.lastAppVersion,
        "2.1.2",
        `malformed header must not overwrite the stored version (${value})`
      );
      assert.equal(
        row.lastSeenAt.getTime(),
        good.lastSeenAt.getTime(),
        "a rejected header on the same day is also not a write"
      );
    }
  });

  it("accepts a request with NO X-App-Version at all, leaving the column null", async () => {
    const user = await signUp();

    const res = await me(user.token, undefined);
    assert.equal(res.status, 200);

    const row = await waitForRow(
      user.userId,
      (stored) => stored.lastSeenAt instanceof Date,
      "header-less sighting should become durable"
    );
    assert.equal(row.lastAppVersion, null, "no header => nothing stored");
    assert.ok(
      row.lastSeenAt instanceof Date,
      "but the user IS seen, so they can appear in the 30-day window"
    );
  });

  it("never leaks lastAppVersion / lastSeenAt into the /auth/me payload", async () => {
    const user = await signUp();

    // Two requests: the first performs the sticky write, the second is served
    // from a row that definitely HAS both columns populated. The handler
    // spreads `...req.user`, so this is the real leak surface.
    assert.equal((await me(user.token, "2.1.2")).status, 200);
    await waitForRow(
      user.userId,
      (row) => row.lastAppVersion === "2.1.2" && row.lastSeenAt instanceof Date,
      "sticky fields should be durable before leak check"
    );
    const res = await me(user.token, "2.1.2");
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.user, "payload shape unchanged");
    assert.equal(
      Object.prototype.hasOwnProperty.call(body.user, "lastAppVersion"),
      false,
      "lastAppVersion must not appear in /auth/me"
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(body.user, "lastSeenAt"),
      false,
      "lastSeenAt must not appear in /auth/me"
    );
    // Pre-existing fields still there (frozen-client guard).
    assert.equal(body.user.id, user.userId);
    assert.ok("coins" in body.user);
    assert.ok("featureFlags" in body.user);

    // Same guard on the other two endpoints of this router that spread the
    // user row through the same serializer.
    const session = await request(server.baseUrl, "GET", "/auth/session", {
      token: user.token,
      headers: { "X-App-Version": "2.1.2" },
    });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal("lastAppVersion" in sessionBody.user, false);
    assert.equal("lastSeenAt" in sessionBody.user, false);
  });

  it("does NOT invalidate the /auth/me cache when the sticky write fires", async () => {
    // The chokepoint (`User.update` and siblings in models/user.js) DELs the
    // /auth/me cache key. A per-user DAILY write through it would gut the hit
    // rate of the #2 endpoint by volume, so the sticky write deliberately uses
    // a dedicated model method that bypasses the chokepoint. Proven here at the
    // invalidation seam: the request still goes over real HTTP, only the
    // observation point is the module the model calls.
    const authMeCache = require("../../src/modules/users/services/authMeCache");
    const originalSafe = authMeCache.invalidateSafe;
    const originalInvalidate = authMeCache.invalidate;
    let calls = 0;
    authMeCache.invalidateSafe = async (...args) => {
      calls += 1;
      return originalSafe.apply(authMeCache, args);
    };
    authMeCache.invalidate = async (...args) => {
      calls += 1;
      return originalInvalidate.apply(authMeCache, args);
    };

    try {
      const user = await signUp();

      // 1. First sighting: writes both columns.
      calls = 0;
      assert.equal((await me(user.token, "2.1.2")).status, 200);
      assert.equal(
        calls,
        0,
        "the first-sighting sticky write must not touch the /auth/me cache"
      );

      // 2. Version change: writes both columns again.
      calls = 0;
      assert.equal((await me(user.token, "2.2.0")).status, 200);
      assert.equal(
        calls,
        0,
        "a version-change sticky write must not touch the /auth/me cache"
      );

      // 3. New UTC day: writes lastSeenAt again.
      await prisma.user.update({
        where: { id: user.userId },
        data: { lastSeenAt: new Date(Date.now() - 1.5 * DAY_MS) },
      });
      calls = 0;
      assert.equal((await me(user.token, "2.2.0")).status, 200);
      assert.equal(
        calls,
        0,
        "a new-UTC-day sticky write must not touch the /auth/me cache"
      );

      // Control: a real user-row mutation through the chokepoint DOES
      // invalidate — proving the spy is wired to a live seam and that the
      // three zeros above are meaningful.
      calls = 0;
      const renamed = await request(
        server.baseUrl,
        "PUT",
        "/auth/me/display-name",
        {
          token: user.token,
          body: { displayName: "VersionSpy" },
          headers: { "X-App-Version": "2.2.0" },
        }
      );
      assert.equal(renamed.status, 200);
      assert.ok(
        calls > 0,
        "control: a chokepoint write must still invalidate the cache"
      );
    } finally {
      authMeCache.invalidateSafe = originalSafe;
      authMeCache.invalidate = originalInvalidate;
    }
  });
});

describe("batch 2026-08-08 item 9 — GET /admin/stats versions + races", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedSeenUser({ version, provider = "apple", daysAgo = 1 }) {
    const seenAt = new Date(Date.now() - daysAgo * DAY_MS);
    return prisma.user.create({
      data: {
        appleId: provider === "apple" ? uniq("apple-seed") : null,
        googleSub: provider === "google" ? uniq("google-seed") : null,
        email: `${uniq("seed")}@example.com`,
        lastAppVersion: version,
        lastSeenAt: seenAt,
      },
    });
  }

  function fetchStats(token, appVersion = "9.9.9") {
    return request(server.baseUrl, "GET", "/admin/stats", {
      token,
      headers: { "X-App-Version": appVersion },
    });
  }

  it("is still admin-gated (403 for a non-admin)", async () => {
    const plain = await signUp();
    const res = await fetchStats(plain.token);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /admin/i);
  });

  it("buckets users by lastAppVersion + platform, with an explicit unknown bucket and a since date", async () => {
    const admin = await signUpAdmin();

    await seedSeenUser({ version: "2.1.2", provider: "apple", daysAgo: 1 });
    await seedSeenUser({ version: "2.1.2", provider: "apple", daysAgo: 5 });
    await seedSeenUser({ version: "2.0.1", provider: "apple", daysAgo: 2 });
    await seedSeenUser({ version: "2.1.2", provider: "google", daysAgo: 3 });
    // NULL version but seen => the "unknown" bucket (the launch-day state).
    await seedSeenUser({ version: null, provider: "apple", daysAgo: 1 });
    await seedSeenUser({ version: null, provider: "google", daysAgo: 4 });
    // Outside the 30-day window => excluded entirely.
    await seedSeenUser({ version: "1.0.0", provider: "apple", daysAgo: 45 });
    // Never seen (lastSeenAt null) => excluded entirely.
    await prisma.user.create({
      data: {
        appleId: uniq("apple-neverseen"),
        email: `${uniq("neverseen")}@example.com`,
      },
    });

    // Establish the admin's deferred sticky write before reading the report,
    // so the deterministic extra bucket is present without coupling the
    // request latency to analytics persistence.
    assert.equal((await me(admin.token, "9.9.9")).status, 200);
    await waitForRow(
      admin.userId,
      (row) => row.lastAppVersion === "9.9.9" && row.lastSeenAt instanceof Date,
      "admin version should become durable before stats are read"
    );
    const res = await fetchStats(admin.token, "9.9.9");
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    assert.ok(Array.isArray(stats.versions), "versions is an array");
    for (const row of stats.versions) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["platform", "users", "version"],
        "each row is exactly {version, platform, users}"
      );
      assert.equal(typeof row.users, "number");
    }

    const key = (r) => `${r.version}|${r.platform}`;
    const actual = Object.fromEntries(
      stats.versions.map((r) => [key(r), r.users])
    );
    assert.deepEqual(actual, {
      "2.1.2|ios": 2,
      "2.1.2|android": 1,
      "2.0.1|ios": 1,
      "unknown|ios": 1,
      "unknown|android": 1,
      "9.9.9|ios": 1, // the admin making this call
    });

    assert.equal(stats.versionsWindowDays, 30);
    assert.match(
      stats.versionsSince,
      /^\d{4}-\d{2}-\d{2}$/,
      "a since DATE accompanies the buckets so an all-unknown day is readable"
    );
    const since = new Date(`${stats.versionsSince}T00:00:00Z`).getTime();
    const expected = Date.now() - 30 * DAY_MS;
    assert.ok(
      Math.abs(since - expected) < 2 * DAY_MS,
      `since (${stats.versionsSince}) should be ~30 days ago`
    );
  });

  it("reports a user with no X-App-Version header in the unknown bucket, end to end", async () => {
    const admin = await signUpAdmin();
    const headerless = await signUp();

    // Real authenticated request with NO version header.
    assert.equal((await me(headerless.token, undefined)).status, 200);
    await waitForRow(
      headerless.userId,
      (row) => row.lastSeenAt instanceof Date,
      "header-less user should be durable before stats are read"
    );

    const res = await fetchStats(admin.token, "9.9.9");
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    const unknownIos = stats.versions.find(
      (r) => r.version === "unknown" && r.platform === "ios"
    );
    assert.ok(unknownIos, "an unknown bucket exists");
    assert.equal(unknownIos.users, 1);

    // ...and once that same user sends a version, they move out of it.
    assert.equal((await me(headerless.token, "2.1.2")).status, 200);
    await waitForRow(
      headerless.userId,
      (row) => row.lastAppVersion === "2.1.2",
      "reported version should be durable before stats are read"
    );
    const after = await (await fetchStats(admin.token, "9.9.9")).json();
    assert.equal(
      after.stats.versions.find(
        (r) => r.version === "unknown" && r.platform === "ios"
      ),
      undefined,
      "the unknown bucket empties as clients report in"
    );
    assert.equal(
      after.stats.versions.find(
        (r) => r.version === "2.1.2" && r.platform === "ios"
      )?.users,
      1
    );
  });

  it("counts private vs public races, total and active", async () => {
    const admin = await signUpAdmin();

    const race = (name, isPublic, status) =>
      prisma.race.create({
        data: { name, targetSteps: 1000, isPublic, status },
      });

    await race("priv-pending", false, "PENDING");
    await race("priv-active-1", false, "ACTIVE");
    await race("priv-active-2", false, "ACTIVE");
    await race("priv-completed", false, "COMPLETED");
    await race("priv-cancelled", false, "CANCELLED");

    await race("pub-active", true, "ACTIVE");
    await race("pub-completed-1", true, "COMPLETED");
    await race("pub-completed-2", true, "COMPLETED");

    const res = await fetchStats(admin.token);
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    assert.deepEqual(stats.races, {
      privateTotal: 5,
      privateActive: 2,
      publicTotal: 3,
      publicActive: 1,
    });
  });

  it("returns zeroed sections rather than omitting them when there is no data", async () => {
    const admin = await signUpAdmin();

    assert.equal((await me(admin.token, "9.9.9")).status, 200);
    await waitForRow(
      admin.userId,
      (row) => row.lastAppVersion === "9.9.9" && row.lastSeenAt instanceof Date,
      "admin version should become durable before stats are read"
    );

    const res = await fetchStats(admin.token, "9.9.9");
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    assert.deepEqual(stats.races, {
      privateTotal: 0,
      privateActive: 0,
      publicTotal: 0,
      publicActive: 0,
    });
    // Only the calling admin has been seen.
    assert.deepEqual(stats.versions, [
      { version: "9.9.9", platform: "ios", users: 1 },
    ]);
  });

  it("FROZEN CLIENT: every pre-existing admin-stats section is still present and unchanged", async () => {
    const admin = await signUpAdmin();

    const res = await fetchStats(admin.token);
    assert.equal(res.status, 200);
    const { stats } = await res.json();

    assert.ok(typeof stats.generatedAt === "string");
    assert.deepEqual(Object.keys(stats.users).sort(), [
      "newLast30Days",
      "newLast7Days",
      "total",
    ]);
    assert.equal(typeof stats.activity.dauToday, "number");
    assert.equal(typeof stats.activity.dauInActiveRace, "number");
    assert.equal(typeof stats.activity.pctDauInActiveRace, "number");
    assert.equal(
      typeof stats.activity.rewardedAds.coinReward.uniqueDauWatchers,
      "number"
    );
    assert.equal(
      typeof stats.activity.rewardedAds.extraSpin.uniqueDauWatchers,
      "number"
    );
    assert.equal(stats.activity.rewardedAds.timeZone, "America/New_York");
    assert.ok("avgUniqueBoxOpenersPerDay" in stats.activity);
    assert.deepEqual(Object.keys(stats.friends.distribution).sort(), [
      "0",
      "1",
      "2",
      "3-5",
      "6+",
    ]);
    assert.deepEqual(Object.keys(stats.retention).sort(), [
      "withFriend",
      "withoutFriend",
    ]);
    assert.deepEqual(Object.keys(stats.teamRaces).sort(), [
      "activeNow",
      "completedLast7Days",
      "completedTotal",
      "createdLast7Days",
      "createdTotal",
    ]);
    assert.deepEqual(Object.keys(stats.referralFunnel).sort(), [
      "finishedRace",
      "joinedRace",
      "linkOpensTotal",
      "linkOpensLast7Days",
      "rewarded",
      "signups",
      "signupsLast7Days",
    ].sort());
    assert.deepEqual(Object.keys(stats.activationFunnel).sort(), [
      "last30Days",
      "last7Days",
      "last90Days",
    ]);
    assert.equal(stats.onboardingFunnel.windowDays, 7);
    assert.ok(stats.onboardingFunnel.byPlatform.ios);
    assert.ok(stats.onboardingFunnel.byPlatform.android);
    assert.ok(stats.onboardingFunnel.byPlatformLast30Days);
  });
});
