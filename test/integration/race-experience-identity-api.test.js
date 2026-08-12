const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const {
  cleanDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { startTestRedis } = require("./redisTestServer");

const IDENTITY_FEATURE = "discoverable_identity";
const IDENTITY_KEYS = [
  "firstName",
  "lastName",
  "nameSetupOnboardingRequired",
  "nameSetupCompletedAt",
];

let server;
let nextUser = 0;
let liveRedis = null;
let redisProbe = null;

function featureHeaders(extra = {}) {
  return { "X-Client-Features": IDENTITY_FEATURE, ...extra };
}

async function setFlag(key, value) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  appSettings.bustCache();
}

async function provision({ provider = "apple", capable = false, name } = {}) {
  const n = ++nextUser;
  const path = provider === "google" ? "/auth/google" : "/auth/apple";
  const body =
    provider === "google"
      ? { idToken: `identity-google-${n}`, name }
      : { identityToken: `identity-apple-${n}`, name };
  const response = await request(server.baseUrl, "POST", path, {
    body,
    headers: capable ? featureHeaders() : {},
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return {
    id: payload.user.id,
    token: payload.sessionToken,
    user: payload.user,
    providerId: provider === "google" ? body.idToken : body.identityToken,
    provider,
  };
}

async function rename(user, displayName, extra = {}) {
  const response = await request(
    server.baseUrl,
    "PUT",
    "/auth/me/display-name",
    {
      token: user.token,
      body: { displayName, ...extra },
      headers: featureHeaders(),
    }
  );
  return response;
}

async function pageOne(user, firstName, lastName = null) {
  const response = await request(server.baseUrl, "PUT", "/auth/me/discoverable-name", {
    token: user.token,
    headers: featureHeaders(),
    body: { firstName, lastName },
  });
  response.json = () => jsonBody(response);
  return response;
}

async function completeIdentity(user, {
  firstName = "Nathan",
  lastName = "Chari",
  displayName,
} = {}) {
  const first = await pageOne(user, firstName, lastName);
  const firstBody = await first.json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  const chosen = displayName || firstBody.suggestedDisplayName;
  const second = await rename(user, chosen, {
    completeDiscoverableNameSetup: true,
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200, JSON.stringify(secondBody));
  return { suggestedDisplayName: firstBody.suggestedDisplayName, user: secondBody.user };
}

function assertIdentityEnvelope(user, expected = {}) {
  for (const key of IDENTITY_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(user, key),
      true,
      `own-user envelope omitted ${key}`
    );
  }
  assert.equal("discoverableNameSearch" in user, false);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(user[key], value, key);
  }
}

async function postSearch(user, q) {
  const response = await request(server.baseUrl, "POST", "/friends/search", {
    token: user.token,
    headers: featureHeaders(),
    body: { q },
  });
  response.json = () => jsonBody(response);
  return response;
}

async function jsonBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

describe("race experience + discoverable identity — locked HTTP contract", () => {
  before(async () => {
    server = await startServer({
      isAdminUser: () => true,
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      verifyGoogleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
    });
    liveRedis = await startTestRedis();
  });

  after(async () => {
    await setFlag("discoverableIdentityOnboardingEnrollmentEnabled", false);
    await setFlag("racesInviteDecisionGateEnabled", false);
    await setFlag("quickRaceShareAutoFriendEnabled", false);
    await setFlag("redisCacheAuthMeEnabled", false);
    delete process.env.REDIS_URL;
    await cache.close();
    derivedCache.reset();
    if (redisProbe) await redisProbe.quit().catch(() => {});
    if (liveRedis) await liveRedis.close();
    await server.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextUser = 0;
    delete process.env.REDIS_URL;
    await cache.close();
    derivedCache.reset();
    await setFlag("discoverableIdentityOnboardingEnrollmentEnabled", false);
    await setFlag("racesInviteDecisionGateEnabled", false);
    await setFlag("quickRaceShareAutoFriendEnabled", false);
    await setFlag("redisCacheAuthMeEnabled", false);
  });

  it("declares all three rollout flags with false defaults", async () => {
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: [
            "discoverableIdentityOnboardingEnrollmentEnabled",
            "racesInviteDecisionGateEnabled",
            "quickRaceShareAutoFriendEnabled",
          ],
        },
      },
    });
    appSettings.bustCache();
    const user = await provision();
    const settingsResponse = await request(
      server.baseUrl,
      "GET",
      "/admin/settings",
      { token: user.token }
    );
    const settings = (await settingsResponse.json()).settings;
    assert.equal(settingsResponse.status, 200);
    assert.equal(settings.discoverableIdentityOnboardingEnrollmentEnabled, false);
    assert.equal(settings.racesInviteDecisionGateEnabled, false);
    assert.equal(settings.quickRaceShareAutoFriendEnabled, false);

    const me = await request(server.baseUrl, "GET", "/auth/me", {
      token: user.token,
    });
    const flags = (await me.json()).user.featureFlags;
    assert.equal(flags.racesInviteDecisionGateEnabled, false);

    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token: user.token,
      body: {
        discoverableIdentityOnboardingEnrollmentEnabled: true,
        racesInviteDecisionGateEnabled: true,
        quickRaceShareAutoFriendEnabled: true,
      },
    });
    const patched = await patch.json();
    assert.equal(patch.status, 200, JSON.stringify(patched));
    assert.equal(patched.settings.discoverableIdentityOnboardingEnrollmentEnabled, true);
    assert.equal(patched.settings.racesInviteDecisionGateEnabled, true);
    assert.equal(patched.settings.quickRaceShareAutoFriendEnabled, true);
  });

  it("stamps required only for capable, flag-on Apple and Google create branches", async () => {
    for (const provider of ["apple", "google"]) {
      for (const enabled of [false, true]) {
        for (const capable of [false, true]) {
          await setFlag(
            "discoverableIdentityOnboardingEnrollmentEnabled",
            enabled
          );
          const created = await provision({ provider, capable });
          assertIdentityEnvelope(created.user, {
            nameSetupOnboardingRequired: enabled && capable,
            nameSetupCompletedAt: null,
          });
        }
      }
    }
  });

  it("never restamps an existing account when a later sign-in is capable and flag-on", async () => {
    const original = await provision({ capable: false });
    assertIdentityEnvelope(original.user, {
      nameSetupOnboardingRequired: false,
    });

    await setFlag("discoverableIdentityOnboardingEnrollmentEnabled", true);
    const response = await request(server.baseUrl, "POST", "/auth/apple", {
      headers: featureHeaders(),
      body: { identityToken: original.providerId },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assertIdentityEnvelope(body.user, {
      nameSetupOnboardingRequired: false,
      nameSetupCompletedAt: null,
    });
  });

  it("serves additive identity state on every own-user envelope to old and new clients", async () => {
    const apple = await provision({ provider: "apple", capable: false });
    const google = await provision({ provider: "google", capable: true });
    assertIdentityEnvelope(apple.user);
    assertIdentityEnvelope(google.user);

    for (const [method, path, options] of [
      ["GET", "/auth/me", {}],
      ["GET", "/auth/session", {}],
      ["PUT", "/auth/me/step-goal", { body: { stepGoal: 9000 } }],
    ]) {
      for (const headers of [{}, featureHeaders()]) {
        const response = await request(server.baseUrl, method, path, {
          token: apple.token,
          headers,
          ...options,
        });
        const body = await response.json();
        assert.equal(response.status, 200, `${method} ${path}`);
        assertIdentityEnvelope(body.user);
        assert.equal(body.user.id, apple.id);
      }
    }

    const renamed = await rename(apple, "LegacyRunner");
    const renamedBody = await renamed.json();
    assert.equal(renamed.status, 200);
    assertIdentityEnvelope(renamedBody.user, {
      nameSetupCompletedAt: null,
    });
  });

  it("keeps the reviewer own-user envelope safe without exposing the private search column", async () => {
    const oldEmail = process.env.APP_REVIEW_EMAIL;
    const oldPassword = process.env.APP_REVIEW_PASSWORD;
    process.env.APP_REVIEW_EMAIL = "review-contract@example.com";
    process.env.APP_REVIEW_PASSWORD = "review-contract-password";
    try {
      const response = await request(server.baseUrl, "POST", "/auth/review", {
        body: {
          email: process.env.APP_REVIEW_EMAIL,
          password: process.env.APP_REVIEW_PASSWORD,
        },
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assertIdentityEnvelope(body.user, {
        nameSetupOnboardingRequired: false,
        nameSetupCompletedAt: null,
      });
    } finally {
      if (oldEmail === undefined) delete process.env.APP_REVIEW_EMAIL;
      else process.env.APP_REVIEW_EMAIL = oldEmail;
      if (oldPassword === undefined) delete process.env.APP_REVIEW_PASSWORD;
      else process.env.APP_REVIEW_PASSWORD = oldPassword;
    }
  });

  it("Page 1 normalizes supported Unicode names, persists no completion, and suggests a valid available handle", async () => {
    const user = await provision({ capable: true });
    const response = await pageOne(user, "  José   María ", " D'Ávila  ");
    const body = await jsonBody(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.user.firstName, "José María");
    assert.equal(body.user.lastName, "D'Ávila");
    assert.equal(body.user.nameSetupCompletedAt, null);
    assert.equal(body.user.nameSetupOnboardingRequired, false);
    assert.match(body.suggestedDisplayName, /^[A-Za-z0-9_]{4,30}$/);

    const availability = await request(
      server.baseUrl,
      "GET",
      `/auth/check-display-name?name=${encodeURIComponent(body.suggestedDisplayName)}`,
      { token: user.token }
    );
    assert.deepEqual(await availability.json(), { available: true });

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(stored.firstName, "José María");
    assert.equal(stored.lastName, "D'Ávila");
    assert.equal(stored.discoverableNameSearch, "jose maria d avila");
    assert.equal(stored.nameSetupCompletedAt, null);
  });

  it("Page 1 replaces pending values and collision-suffixes its advisory suggestion", async () => {
    const taken = await provision();
    assert.equal((await rename(taken, "NathanChari")).status, 200);
    const user = await provision({ capable: true });

    const first = await pageOne(user, "Wrong", "Name");
    assert.equal(first.status, 200);
    const second = await pageOne(user, "Nathan", "Chari");
    const body = await jsonBody(second);
    assert.equal(second.status, 200, JSON.stringify(body));
    assert.notEqual(body.suggestedDisplayName.toLowerCase(), "nathanchari");
    assert.match(body.suggestedDisplayName, /^NathanChari[A-Za-z0-9_]+$/);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(stored.firstName, "Nathan");
    assert.equal(stored.lastName, "Chari");
    assert.equal(stored.nameSetupCompletedAt, null);
  });

  it("Page 1 derives a valid fallback suggestion when Unicode transliteration is too short", async () => {
    const user = await provision({ capable: true });
    const response = await pageOne(user, "李", null);
    const body = await jsonBody(response);
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(body.suggestedDisplayName, /^[A-Za-z0-9_]{4,30}$/);
  });

  it("Page 1 rejects wrong types with the exact field-specific codes", async () => {
    const user = await provision({ capable: true });
    for (const [payload, code] of [
      [{ firstName: 123, lastName: null }, "INVALID_FIRST_NAME"],
      [{ firstName: "Nathan", lastName: ["Chari"] }, "INVALID_LAST_NAME"],
    ]) {
      const response = await request(
        server.baseUrl,
        "PUT",
        "/auth/me/discoverable-name",
        { token: user.token, headers: featureHeaders(), body: payload }
      );
      const body = await jsonBody(response);
      assert.equal(response.status, 400);
      assert.equal(body.code, code);
      assert.equal(typeof body.error, "string");
    }
  });

  it("Page 1 rejects empty/long/control/emoji/URL/profane first names and invalid last names", async () => {
    const user = await provision({ capable: true });
    const invalid = [
      { firstName: "", lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "a".repeat(51), lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "Na\u0000than", lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "Nathan🙂", lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "https://bara.app", lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "shit", lastName: null, code: "INVALID_FIRST_NAME" },
      { firstName: "Nathan", lastName: "🙂", code: "INVALID_LAST_NAME" },
      { firstName: "Nathan", lastName: "x".repeat(51), code: "INVALID_LAST_NAME" },
    ];
    for (const { code, ...payload } of invalid) {
      const response = await request(
        server.baseUrl,
        "PUT",
        "/auth/me/discoverable-name",
        { token: user.token, headers: featureHeaders(), body: payload }
      );
      const body = await jsonBody(response);
      assert.equal(response.status, 400, JSON.stringify({ payload, body }));
      assert.equal(body.code, code);
    }
  });

  it("does not disclose a Page-1-only name through capable search", async () => {
    const pending = await provision({ capable: true });
    assert.equal((await pageOne(pending, "Secret", "Walker")).status, 200);
    const searcher = await provision({ capable: true });
    const response = await postSearch(searcher, "Secret Walker");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { users: [] });
  });

  it("Page 2 atomically updates the display name and completion timestamp", async () => {
    const user = await provision({ capable: true });
    const before = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal((await pageOne(user, "Nathan", "Chari")).status, 200);
    const response = await rename(user, "NathanChari", {
      completeDiscoverableNameSetup: true,
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.user.displayName, "NathanChari");
    assert.equal(body.user.nameSetupOnboardingRequired, false);
    assert.match(body.user.nameSetupCompletedAt, /^\d{4}-\d{2}-\d{2}T/);

    const stored = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(stored.displayName, "NathanChari");
    assert.ok(stored.nameSetupCompletedAt instanceof Date);
    assert.notEqual(stored.displayName, before.displayName);
  });

  it("Page 2 collision preserves both prior display name and null completion and returns a fresh suggestion", async () => {
    const owner = await provision();
    assert.equal((await rename(owner, "NathanChari")).status, 200);
    const user = await provision({ capable: true });
    assert.equal((await pageOne(user, "Nathan", "Chari")).status, 200);
    const before = await prisma.user.findUnique({ where: { id: user.id } });

    const response = await rename(user, "NathanChari", {
      completeDiscoverableNameSetup: true,
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "DISPLAY_NAME_TAKEN");
    assert.match(body.suggestedDisplayName, /^[A-Za-z0-9_]{4,30}$/);
    assert.notEqual(body.suggestedDisplayName.toLowerCase(), "nathanchari");

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(after.displayName, before.displayName);
    assert.equal(after.nameSetupCompletedAt, null);
  });

  it("preserves legacy display-name behavior for omitted/false completion and rejects wrong-type flags", async () => {
    const user = await provision({ capable: true });
    const legacy = await rename(user, "LegacyRename");
    assert.equal(legacy.status, 200);
    assert.equal((await legacy.json()).user.nameSetupCompletedAt, null);

    const explicitFalse = await rename(user, "LegacyRename2", {
      completeDiscoverableNameSetup: false,
    });
    assert.equal(explicitFalse.status, 200);
    assert.equal((await explicitFalse.json()).user.nameSetupCompletedAt, null);

    const invalid = await rename(user, "LegacyRename3", {
      completeDiscoverableNameSetup: "true",
    });
    const invalidBody = await invalid.json();
    assert.equal(invalid.status, 400);
    assert.equal(invalidBody.code, "INVALID_DISCOVERABLE_SETUP_FLAG");

    const missingPageOne = await rename(user, "LegacyRename3", {
      completeDiscoverableNameSetup: true,
    });
    const missingBody = await missingPageOne.json();
    assert.equal(missingPageOne.status, 400);
    assert.equal(missingBody.code, "DISCOVERABLE_NAME_REQUIRED");
  });

  it("POST search finds handle/first/last/combined names, deduplicates, and returns only approved fields", async () => {
    const target = await provision({ capable: true });
    await completeIdentity(target, {
      firstName: "Nathan",
      lastName: "Chari",
      displayName: "NathanRunner",
    });
    const searcher = await provision({ capable: true });

    for (const q of ["NathanRunner", "Nathan", "Chari", "Nathan Chari"] ) {
      const response = await postSearch(searcher, q);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ q, body }));
      assert.deepEqual(body.users, [
        {
          id: target.id,
          displayName: "NathanRunner",
          profilePhotoUrl: null,
          discoverableName: "Nathan Chari",
        },
      ]);
    }
  });

  it("keeps incomplete users handle-findable but never real-name-findable", async () => {
    const incomplete = await provision({ capable: true });
    assert.equal((await rename(incomplete, "KnownHandle")).status, 200);
    assert.equal((await pageOne(incomplete, "Private", "Person")).status, 200);
    const searcher = await provision({ capable: true });

    const byHandle = await postSearch(searcher, "KnownHandle");
    const handleBody = await byHandle.json();
    assert.equal(byHandle.status, 200);
    assert.deepEqual(handleBody.users, [
      {
        id: incomplete.id,
        displayName: "KnownHandle",
        profilePhotoUrl: null,
      },
    ]);

    const byName = await postSearch(searcher, "Private Person");
    assert.deepEqual(await byName.json(), { users: [] });
  });

  it("excludes self/review users, caps at 20, and applies the exact total rank order", async () => {
    const searcher = await provision({ capable: true });
    await completeIdentity(searcher, {
      firstName: "Nathan",
      lastName: "Self",
      displayName: "NathanSelf",
    });

    const fixtures = [
      ["Nathan", "Else", "Nathan"],
      ["Nathan", null, "AExactReal"],
      ["Nathaniel", "Real", "NathanAble"],
      ["Nathan", "Chari", "ZPrefixReal"],
      ["Joe", "Nathan", "ASubReal"],
      ["Super", "Runner", "SuperNathan"],
    ];
    const expected = [];
    for (const [firstName, lastName, displayName] of fixtures) {
      const user = await provision({ capable: true });
      await completeIdentity(user, { firstName, lastName, displayName });
      expected.push({ id: user.id, displayName });
    }

    const review = await provision({ capable: true });
    await completeIdentity(review, {
      firstName: "Nathan",
      lastName: "Review",
      displayName: "NathanReview",
    });
    await prisma.user.update({
      where: { id: review.id },
      data: { isReviewAccount: true },
    });

    for (let i = 0; i < 20; i += 1) {
      const extra = await provision({ capable: true });
      await completeIdentity(extra, {
        firstName: `Other${String.fromCharCode(65 + (i % 20))}`,
        lastName: null,
        displayName: `ZZNathan${String(i).padStart(2, "0")}`,
      });
    }

    const response = await postSearch(searcher, "Nathan");
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.users.length, 20);
    assert.equal(body.users.some((user) => user.id === searcher.id), false);
    assert.equal(body.users.some((user) => user.id === review.id), false);
    assert.deepEqual(
      body.users.slice(0, expected.length).map((user) => user.id),
      expected.map((user) => user.id),
      "exact handle, exact real name, handle prefix, real-name prefix, then substring"
    );
  });

  it("validates normalized minimum length and body type before consuming quota", async () => {
    const user = await provision({ capable: true });
    for (const body of [{}, { q: null }, { q: 12 }, { q: [] }]) {
      const response = await request(server.baseUrl, "POST", "/friends/search", {
        token: user.token,
        headers: featureHeaders(),
        body,
      });
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.code, "INVALID_SEARCH_QUERY");
    }

    for (const q of ["", " ", "é", "---"]) {
      const response = await postSearch(user, q);
      const payload = await response.json();
      assert.equal(response.status, 400);
      assert.equal(payload.code, "SEARCH_QUERY_TOO_SHORT");
    }

    for (let i = 0; i < 30; i += 1) {
      const response = await postSearch(user, "valid query");
      assert.equal(response.status, 200, `valid attempt ${i + 1}`);
    }
  });

  it("enforces 30 searches per user per UTC minute with integer Retry-After and account isolation", async () => {
    const first = await provision({ capable: true });
    const second = await provision({ capable: true });
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await postSearch(first, "zz")).status, 200);
    }
    const limited = await postSearch(first, "zz");
    const body = await limited.json();
    assert.equal(limited.status, 429);
    assert.deepEqual(body, {
      error: "Too many searches",
      code: "SEARCH_RATE_LIMITED",
    });
    const retryAfter = Number(limited.headers.get("retry-after"));
    assert.equal(Number.isInteger(retryAfter), true);
    assert.ok(retryAfter >= 1 && retryAfter <= 60);
    assert.equal((await postSearch(second, "zz")).status, 200);
  });

  it("resets quota in a new fixed UTC-minute window", async () => {
    const user = await provision({ capable: true });
    for (let i = 0; i < 30; i += 1) {
      assert.equal((await postSearch(user, "zz")).status, 200);
    }
    await prisma.friendSearchRateWindow.update({
      where: { userId: user.id },
      data: { windowStart: new Date(Date.now() - 61_000) },
    });
    assert.equal((await postSearch(user, "zz")).status, 200);
    const row = await prisma.friendSearchRateWindow.findUnique({
      where: { userId: user.id },
    });
    assert.equal(row.count, 1);
  });

  it("keeps legacy GET display-name-only with its frozen response shape", async () => {
    const target = await provision({ capable: true });
    await completeIdentity(target, {
      firstName: "Nathan",
      lastName: "Chari",
      displayName: "CometWalker",
    });
    const searcher = await provision({ capable: true });

    const byRealName = await request(
      server.baseUrl,
      "GET",
      "/friends/search?q=Nathan",
      { token: searcher.token }
    );
    assert.deepEqual(await byRealName.json(), { users: [] });

    const byHandle = await request(
      server.baseUrl,
      "GET",
      "/friends/search?q=Comet",
      { token: searcher.token }
    );
    const body = await byHandle.json();
    assert.equal(byHandle.status, 200);
    assert.deepEqual(body.users, [
      { id: target.id, displayName: "CometWalker", profilePhotoUrl: null },
    ]);
  });

  it("invalidates all auth-me variants on Page 1 and auth-me + cosmetics on Page 2", async (t) => {
    if (!liveRedis) return t.skip("no local test Redis available");
    process.env.REDIS_URL = liveRedis.url;
    process.env.CACHE_ENV_PREFIX = "identity-contract:";
    await cache.close();
    derivedCache.reset();
    redisProbe ||= new IORedis(liveRedis.url);
    await redisProbe.flushdb();
    await setFlag("redisCacheAuthMeEnabled", true);

    const user = await provision({ capable: true });
    await request(server.baseUrl, "GET", "/auth/me", { token: user.token });
    assert.ok(
      (await redisProbe.keys("identity-contract:v1:user:authme:*")).length > 0
    );

    const first = await pageOne(user, "Nathan", "Chari");
    assert.equal(first.status, 200);
    assert.deepEqual(
      await redisProbe.keys("identity-contract:v1:user:authme:*"),
      []
    );

    await request(server.baseUrl, "GET", "/auth/me", { token: user.token });
    const cosmeticsKey = `identity-contract:${cacheKeys.userCosmetics(user.id)}`;
    await redisProbe.set(cosmeticsKey, "warm");
    const second = await rename(user, "NathanChari", {
      completeDiscoverableNameSetup: true,
    });
    assert.equal(second.status, 200);
    assert.deepEqual(
      await redisProbe.keys("identity-contract:v1:user:authme:*"),
      []
    );
    assert.equal(await redisProbe.exists(cosmeticsKey), 0);
  });

  it("account deletion removes discoverable PII and cascades quota/suppression rows", async () => {
    const first = await provision({ capable: true });
    const second = await provision({ capable: true });
    await completeIdentity(first, {
      firstName: "Delete",
      lastName: "Me",
      displayName: "DeleteMeNow",
    });
    assert.equal((await postSearch(first, "zz")).status, 200);
    const send = await request(server.baseUrl, "POST", "/friends/request", {
      token: first.token,
      body: { addresseeId: second.id },
    });
    const friendshipId = (await send.json()).friendship.id;
    assert.equal(
      (
        await request(
          server.baseUrl,
          "PUT",
          `/friends/request/${friendshipId}`,
          { token: second.token, body: { accept: false } }
        )
      ).status,
      200
    );

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: first.token,
    });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.user.count({ where: { id: first.id } }), 0);
    assert.equal(
      await prisma.friendSearchRateWindow.count({ where: { userId: first.id } }),
      0
    );
    assert.equal(
      await prisma.friendshipAutoLinkSuppression.count({
        where: { OR: [{ userAId: first.id }, { userBId: first.id }] },
      }),
      0
    );
  });
});
