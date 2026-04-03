const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const APPLE_ID = "fake-token";
const EMAIL = "fake-token@example.com";

function authOverrides() {
  return {
    verifyAppleIdentityToken: async () => ({
      sub: APPLE_ID,
      email: EMAIL,
    }),
  };
}

describe("user onboarding flow", () => {
  let server;

  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("complete onboarding: sign in → set display name → set step goal", async () => {
    // Step 1: POST /auth/apple — user taps "GET STARTED"
    const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "fake-token", email: EMAIL, name: "Test User" },
    });
    assert.equal(signInRes.status, 200);

    const signInBody = await signInRes.json();
    assert.ok(signInBody.sessionToken);
    assert.equal(signInBody.user.displayName, null);
    const token = signInBody.sessionToken;
    const userId = signInBody.user.id;

    // Verify DB record after sign-in
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    assert.equal(dbUser.appleId, APPLE_ID);
    assert.equal(dbUser.email, EMAIL);
    assert.equal(dbUser.name, "Test User");
    assert.equal(dbUser.displayName, null);
    assert.equal(dbUser.stepGoal, 5000);
    assert.equal(dbUser.coins, 0);

    // Step 2: GET /auth/check-display-name — real-time validation
    const checkRes = await request(
      server.baseUrl,
      "GET",
      "/auth/check-display-name?name=TestRunner",
      { token },
    );
    assert.equal(checkRes.status, 200);
    const checkBody = await checkRes.json();
    assert.equal(checkBody.available, true);

    // Step 3: PUT /auth/me/display-name — user taps "CONTINUE"
    const nameRes = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/display-name",
      { body: { displayName: "TestRunner" }, token },
    );
    assert.equal(nameRes.status, 200);

    const afterName = await prisma.user.findUnique({ where: { id: userId } });
    assert.equal(afterName.displayName, "TestRunner");

    // Step 4: PUT /auth/me/step-goal — user taps "CONTINUE"
    const goalRes = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/step-goal",
      { body: { stepGoal: 8000 }, token },
    );
    assert.equal(goalRes.status, 200);

    const afterGoal = await prisma.user.findUnique({ where: { id: userId } });
    assert.equal(afterGoal.stepGoal, 8000);

    // Step 5: GET /auth/me — frontend loads main shell
    const meRes = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(meRes.status, 200);

    const meBody = await meRes.json();
    assert.equal(meBody.user.displayName, "TestRunner");
    assert.equal(meBody.user.stepGoal, 8000);
  });

  it("returning user sign-in finds existing user and updates email", async () => {
    // Seed a user
    await prisma.user.create({
      data: { appleId: APPLE_ID, email: "old@example.com" },
    });

    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "fake-token", email: EMAIL },
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.sessionToken);

    // Should not create a duplicate
    const count = await prisma.user.count({ where: { appleId: APPLE_ID } });
    assert.equal(count, 1);

    // Email should be updated
    const user = await prisma.user.findFirst({ where: { appleId: APPLE_ID } });
    assert.equal(user.email, EMAIL);
  });

  it("rejects display name shorter than 8 characters", async () => {
    const { token } = await signIn();

    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/display-name",
      { body: { displayName: "short" }, token },
    );
    assert.equal(res.status, 400);
  });

  it("rejects duplicate display name with 409", async () => {
    // Create a user with a taken name
    await prisma.user.create({
      data: { appleId: "other-apple-id", displayName: "TakenName" },
    });

    const { token } = await signIn();

    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/display-name",
      { body: { displayName: "TakenName" }, token },
    );
    assert.equal(res.status, 409);
  });

  it("check-display-name returns unavailable for taken name", async () => {
    await prisma.user.create({
      data: { appleId: "other-apple-id", displayName: "TakenName" },
    });

    const { token } = await signIn();

    const res = await request(
      server.baseUrl,
      "GET",
      "/auth/check-display-name?name=TakenName",
      { token },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, false);
  });

  it("rejects step goal below 5000", async () => {
    const { token } = await signIn();

    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/step-goal",
      { body: { stepGoal: 3000 }, token },
    );
    assert.equal(res.status, 400);
  });

  it("rejects non-integer step goal", async () => {
    const { token } = await signIn();

    const res = await request(
      server.baseUrl,
      "PUT",
      "/auth/me/step-goal",
      { body: { stepGoal: 7500.5 }, token },
    );
    assert.equal(res.status, 400);
  });

  async function signIn() {
    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "fake-token", email: EMAIL },
    });
    const body = await res.json();
    return { token: body.sessionToken, userId: body.user.id };
  }
});
