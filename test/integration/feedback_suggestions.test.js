// Batch 2026-08-08 item 7 — in-app suggestion box.
//
// Real HTTP against the real handler chain and the real DB. The endpoints are
// brand new, so there is no old-client compat surface to protect here; what
// these tests DO protect is the account-deletion invariant (deleteUserAccount
// runs inside one 5s transaction and must stay able to remove a user who has
// left feedback) and the 5/user/UTC-day rate limit.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

// Matches admin.test.js: the admin gate is env-driven, and the harness marks a
// user as admin by giving it the first configured ADMIN_EMAILS address.
const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser() {
  const appleId = `apple-feedback-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken, appleId };
}

async function createAdmin() {
  const admin = await createUser();
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

function submit(token, body, headers) {
  return request(server.baseUrl, "POST", "/feedback/suggestions", {
    body,
    token,
    headers,
  });
}

describe("feedback suggestions", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === POST /feedback/suggestions ===

  it("stores a suggestion and returns 201 { ok: true }", async () => {
    const user = await createUser();

    const res = await submit(user.token, {
      text: "Please add a dark mode for the race screen",
      category: "feature",
    });

    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });

    const rows = await prisma.suggestion.findMany({
      where: { userId: user.userId },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, user.userId);
    assert.equal(rows[0].text, "Please add a dark mode for the race screen");
    assert.equal(rows[0].category, "feature");
  });

  it("requires authentication", async () => {
    const res = await request(server.baseUrl, "POST", "/feedback/suggestions", {
      body: { text: "anonymous thoughts" },
    });
    assert.equal(res.status, 401);
    assert.equal(await prisma.suggestion.count(), 0);
  });

  it("accepts a suggestion with no category", async () => {
    const user = await createUser();
    const res = await submit(user.token, { text: "no category here" });
    assert.equal(res.status, 201);

    const row = await prisma.suggestion.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(row.category, null);
  });

  // === Validation ===

  it("rejects a missing, empty, or non-string text with 400", async () => {
    const user = await createUser();

    for (const body of [{}, { text: "" }, { text: "   " }, { text: 42 }, { text: null }]) {
      const res = await submit(user.token, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const payload = await res.json();
      assert.ok(payload.error, "400 responses carry an error message");
    }

    assert.equal(await prisma.suggestion.count(), 0);
  });

  it("rejects text over 2000 chars but accepts exactly 2000", async () => {
    const atLimit = await createUser();
    const overLimit = await createUser();

    const over = await submit(overLimit.token, { text: "x".repeat(2001) });
    assert.equal(over.status, 400);
    assert.equal(await prisma.suggestion.count({ where: { userId: overLimit.userId } }), 0);

    const exact = await submit(atLimit.token, { text: "y".repeat(2000) });
    assert.equal(exact.status, 201);
    const row = await prisma.suggestion.findFirst({
      where: { userId: atLimit.userId },
    });
    assert.equal(row.text.length, 2000);
  });

  it("rejects a non-string or over-long category with 400", async () => {
    const user = await createUser();

    const badType = await submit(user.token, { text: "hi", category: 7 });
    assert.equal(badType.status, 400);

    const tooLong = await submit(user.token, {
      text: "hi",
      category: "c".repeat(65),
    });
    assert.equal(tooLong.status, 400);

    assert.equal(await prisma.suggestion.count(), 0);
  });

  // === Provenance headers ===

  it("persists X-App-Version and X-Platform onto the row", async () => {
    const user = await createUser();

    const res = await submit(
      user.token,
      { text: "sent from a real build" },
      { "X-App-Version": "2.1.3", "X-Platform": "ios" }
    );
    assert.equal(res.status, 201);

    const row = await prisma.suggestion.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(row.appVersion, "2.1.3");
    assert.equal(row.platform, "ios");
  });

  it("still succeeds with null provenance when the headers are absent", async () => {
    const user = await createUser();

    const res = await submit(user.token, { text: "no headers at all" });
    assert.equal(res.status, 201);

    const row = await prisma.suggestion.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(row.appVersion, null);
    assert.equal(row.platform, null);
  });

  it("never rejects a submission for a garbage provenance header", async () => {
    const user = await createUser();

    const res = await submit(
      user.token,
      { text: "weird client" },
      { "X-App-Version": "not a version at all", "X-Platform": "toaster" }
    );
    assert.equal(res.status, 201);

    const row = await prisma.suggestion.findFirst({
      where: { userId: user.userId },
    });
    assert.equal(row.text, "weird client");
  });

  // === Rate limit: 5 per user per UTC day ===

  it("allows 5 submissions per UTC day and 429s the 6th", async () => {
    const user = await createUser();

    for (let i = 1; i <= 5; i += 1) {
      const res = await submit(user.token, { text: `idea number ${i}` });
      assert.equal(res.status, 201, `submission ${i} should succeed`);
    }

    const sixth = await submit(user.token, { text: "one too many" });
    assert.equal(sixth.status, 429);
    const payload = await sixth.json();
    assert.ok(payload.error, "429 carries an error message");

    assert.equal(
      await prisma.suggestion.count({ where: { userId: user.userId } }),
      5,
      "the rejected submission is not stored"
    );
  });

  it("scopes the rate limit per user", async () => {
    const noisy = await createUser();
    const quiet = await createUser();

    for (let i = 0; i < 5; i += 1) {
      await submit(noisy.token, { text: `spam ${i}` });
    }
    assert.equal((await submit(noisy.token, { text: "blocked" })).status, 429);

    const other = await submit(quiet.token, { text: "my first idea" });
    assert.equal(other.status, 201);
  });

  it("does not count submissions from a previous UTC day", async () => {
    const user = await createUser();

    // Five rows dated to yesterday (UTC) must leave today's quota untouched.
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      await prisma.suggestion.create({
        data: { userId: user.userId, text: `old ${i}`, createdAt: yesterday },
      });
    }

    const res = await submit(user.token, { text: "fresh day, fresh idea" });
    assert.equal(res.status, 201);
  });

  // === GET /admin/feedback/suggestions ===

  it("403s the admin list for a non-admin user", async () => {
    const user = await createUser();
    await submit(user.token, { text: "mine to read?" });

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions",
      { token: user.token }
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Admin access is required" });
  });

  it("401s the admin list without a token", async () => {
    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions"
    );
    assert.equal(res.status, 401);
  });

  it("lists suggestions newest first for an admin", async () => {
    const admin = await createAdmin();
    const author = await createUser();

    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    for (const [offset, text] of [
      [0, "oldest"],
      [1000, "middle"],
      [2000, "newest"],
    ]) {
      await prisma.suggestion.create({
        data: {
          userId: author.userId,
          text,
          appVersion: "2.1.3",
          platform: "ios",
          createdAt: new Date(base + offset),
        },
      });
    }

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions",
      { token: admin.token }
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.suggestions));
    assert.deepEqual(
      body.suggestions.map((s) => s.text),
      ["newest", "middle", "oldest"]
    );

    const first = body.suggestions[0];
    assert.equal(first.userId, author.userId);
    assert.equal(first.appVersion, "2.1.3");
    assert.equal(first.platform, "ios");
    assert.equal(typeof first.id, "string");
    assert.equal(typeof first.createdAt, "string");
    assert.ok("category" in first);
    assert.ok("displayName" in first);
  });

  it("honors the limit query parameter", async () => {
    const admin = await createAdmin();
    const author = await createUser();

    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    for (let i = 0; i < 5; i += 1) {
      await prisma.suggestion.create({
        data: {
          userId: author.userId,
          text: `idea ${i}`,
          createdAt: new Date(base + i * 1000),
        },
      });
    }

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions?limit=2",
      { token: admin.token }
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.suggestions.length, 2);
    assert.deepEqual(
      body.suggestions.map((s) => s.text),
      ["idea 4", "idea 3"]
    );
    assert.equal(
      body.nextBefore,
      body.suggestions[1].createdAt,
      "a full page hands back a cursor for the next one"
    );
  });

  it("pages backwards with the before cursor", async () => {
    const admin = await createAdmin();
    const author = await createUser();

    const base = Date.UTC(2026, 7, 8, 12, 0, 0);
    for (let i = 0; i < 4; i += 1) {
      await prisma.suggestion.create({
        data: {
          userId: author.userId,
          text: `idea ${i}`,
          createdAt: new Date(base + i * 1000),
        },
      });
    }

    const page1 = await (
      await request(
        server.baseUrl,
        "GET",
        "/admin/feedback/suggestions?limit=2",
        { token: admin.token }
      )
    ).json();

    const page2res = await request(
      server.baseUrl,
      "GET",
      `/admin/feedback/suggestions?limit=2&before=${encodeURIComponent(page1.nextBefore)}`,
      { token: admin.token }
    );
    assert.equal(page2res.status, 200);
    const page2 = await page2res.json();

    assert.deepEqual(
      page2.suggestions.map((s) => s.text),
      ["idea 1", "idea 0"]
    );
  });

  it("400s an unparseable before cursor", async () => {
    const admin = await createAdmin();

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions?before=not-a-date",
      { token: admin.token }
    );
    assert.equal(res.status, 400);
  });

  it("returns an empty list rather than 404 when there is no feedback", async () => {
    const admin = await createAdmin();

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/feedback/suggestions",
      { token: admin.token }
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { suggestions: [], nextBefore: null });
  });

  // === Account deletion (protects the 5s transaction invariant) ===

  it("deletes a user's suggestions with their account", async () => {
    const user = await createUser();

    for (let i = 0; i < 3; i += 1) {
      const res = await submit(user.token, { text: `parting thought ${i}` });
      assert.equal(res.status, 201);
    }
    assert.equal(
      await prisma.suggestion.count({ where: { userId: user.userId } }),
      3
    );

    const res = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: user.token,
    });
    assert.equal(res.status, 204);

    assert.equal(
      await prisma.suggestion.count({ where: { userId: user.userId } }),
      0
    );
    assert.equal(
      await prisma.user.findUnique({ where: { id: user.userId } }),
      null
    );
  });
});
