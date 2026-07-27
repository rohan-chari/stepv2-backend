const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  prisma,
  cleanDatabase,
  request,
  getSharedServer,
} = require("./setup");

// Home SETUP section — rename-chip server persistence
// (docs/home-setup-section-requirements.md §4, §7 "Backend").
//
// Real HTTP, real DB, real handler chain. Never against prod: `npm run
// test:integration` pins DATABASE_URL to the local steps-tracker-integration DB.
describe("rename chip state", () => {
  let server;
  let nextAppleId = 0;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function appleSub() {
    return `apple-rename-chip-${++nextAppleId}-${Date.now()}`;
  }

  async function signIn(sub) {
    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: sub },
    });
    assert.equal(res.status, 200, "sign-in should succeed");
    const body = await res.json();
    return { userId: body.user.id, token: body.sessionToken, user: body.user };
  }

  async function post(path, token) {
    return request(server.baseUrl, "POST", path, token ? { token } : {});
  }

  async function getMe(token) {
    const res = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(res.status, 200);
    const body = await res.json();
    return body.user;
  }

  // ── §7 Backend 1 ──────────────────────────────────────────────────────────

  it("GET /auth/me returns count 0 and dismissedAt null for a fresh user", async () => {
    const { token } = await signIn(appleSub());

    const user = await getMe(token);

    assert.equal(user.renameChipShownCount, 0);
    assert.equal(user.renameChipDismissedAt, null);
    // Guard against a future `select:` whitelist silently dropping the keys.
    assert.ok(
      Object.prototype.hasOwnProperty.call(user, "renameChipShownCount"),
      "renameChipShownCount must be present on /auth/me"
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(user, "renameChipDismissedAt"),
      "renameChipDismissedAt must be present on /auth/me"
    );
  });

  // ── §7 Backend 2 ──────────────────────────────────────────────────────────

  it("POST /auth/apple returns both new keys on the user envelope", async () => {
    const { user } = await signIn(appleSub());

    assert.ok(
      Object.prototype.hasOwnProperty.call(user, "renameChipShownCount"),
      "renameChipShownCount must be present on /auth/apple"
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(user, "renameChipDismissedAt"),
      "renameChipDismissedAt must be present on /auth/apple"
    );
    assert.equal(user.renameChipShownCount, 0);
    assert.equal(user.renameChipDismissedAt, null);
  });

  // ── §7 Backend 3 ──────────────────────────────────────────────────────────

  it("POST /auth/me/rename-chip/shown increments 0 -> 1 -> 2", async () => {
    const { token } = await signIn(appleSub());

    const first = await post("/auth/me/rename-chip/shown", token);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.user.renameChipShownCount, 1);
    assert.equal(firstBody.user.renameChipDismissedAt, null);

    const second = await post("/auth/me/rename-chip/shown", token);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.user.renameChipShownCount, 2);

    // and it is durable
    const me = await getMe(token);
    assert.equal(me.renameChipShownCount, 2);
  });

  // ── §7 Backend 4 ──────────────────────────────────────────────────────────

  it("clamps the count at 99", async () => {
    const { userId, token } = await signIn(appleSub());
    await prisma.user.update({
      where: { id: userId },
      data: { renameChipShownCount: 99 },
    });

    const res = await post("/auth/me/rename-chip/shown", token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.renameChipShownCount, 99);

    const me = await getMe(token);
    assert.equal(me.renameChipShownCount, 99);
  });

  // ── §7 Backend 5 ──────────────────────────────────────────────────────────

  it("POST /auth/me/rename-chip/dismiss stamps once and is idempotent", async () => {
    const { token } = await signIn(appleSub());

    const first = await post("/auth/me/rename-chip/dismiss", token);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const stamp = firstBody.user.renameChipDismissedAt;
    assert.equal(typeof stamp, "string");
    assert.ok(
      Number.isFinite(Date.parse(stamp)),
      `renameChipDismissedAt should be a parseable ISO timestamp, got ${stamp}`
    );

    const second = await post("/auth/me/rename-chip/dismiss", token);
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(
      secondBody.user.renameChipDismissedAt,
      stamp,
      "a second dismiss must return the existing timestamp, not re-stamp"
    );

    const me = await getMe(token);
    assert.equal(me.renameChipDismissedAt, stamp);
  });

  // ── §7 Backend 6 ──────────────────────────────────────────────────────────

  it("shown after dismiss is a 200 no-op", async () => {
    const { token } = await signIn(appleSub());

    await post("/auth/me/rename-chip/shown", token);
    const dismissRes = await post("/auth/me/rename-chip/dismiss", token);
    const dismissBody = await dismissRes.json();
    assert.equal(dismissBody.user.renameChipShownCount, 1);
    const stamp = dismissBody.user.renameChipDismissedAt;

    const shownRes = await post("/auth/me/rename-chip/shown", token);
    assert.equal(shownRes.status, 200);
    const shownBody = await shownRes.json();
    assert.equal(shownBody.user.renameChipShownCount, 1, "count must not move");
    assert.equal(shownBody.user.renameChipDismissedAt, stamp);

    const me = await getMe(token);
    assert.equal(me.renameChipShownCount, 1);
    assert.equal(me.renameChipDismissedAt, stamp);
  });

  // ── §7 Backend 7 ──────────────────────────────────────────────────────────

  it("both routes 401 without a bearer token", async () => {
    const shown = await post("/auth/me/rename-chip/shown", null);
    assert.equal(shown.status, 401);

    const dismiss = await post("/auth/me/rename-chip/dismiss", null);
    assert.equal(dismiss.status, 401);
  });

  // ── §7 Backend 8 — THE regression test for the reported bug ───────────────

  it("dismissal survives a sign-out / sign-in cycle (same Apple sub)", async () => {
    const sub = appleSub();
    const { token } = await signIn(sub);

    await post("/auth/me/rename-chip/shown", token);
    const dismissRes = await post("/auth/me/rename-chip/dismiss", token);
    const stamp = (await dismissRes.json()).user.renameChipDismissedAt;
    assert.ok(stamp);

    // Sign out on the device (client-side only), then sign back in with the
    // same Apple identity — the real path a returning user takes.
    const { user: resignedUser, token: newToken } = await signIn(sub);

    assert.equal(
      resignedUser.renameChipDismissedAt,
      stamp,
      "the dismissal must ride the /auth/apple user envelope"
    );
    assert.equal(resignedUser.renameChipShownCount, 1);

    const me = await getMe(newToken);
    assert.equal(me.renameChipDismissedAt, stamp);
    assert.equal(me.renameChipShownCount, 1);
  });

  // ── §7 Backend 9 ──────────────────────────────────────────────────────────

  it("does not remove any existing field from the /auth/me payload", async () => {
    const { token } = await signIn(appleSub());

    const user = await getMe(token);

    for (const key of [
      "id",
      "displayName",
      "profilePhotoUrl",
      "profilePhotoPromptDismissedAt",
      "coins",
      "stepGoal",
      "hiddenFromLeaderboard",
      "autoJoinFeaturedRaces",
      "isAdmin",
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(user, key),
        `existing key ${key} must still be present on /auth/me`
      );
    }
  });
});
