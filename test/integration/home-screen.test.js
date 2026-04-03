const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

const APPLE_ID = "apple-home-user";
const EMAIL = "home@example.com";

function authOverrides() {
  return {
    verifyAppleIdentityToken: async () => ({
      sub: APPLE_ID,
      email: EMAIL,
    }),
  };
}

describe("home screen data fetch", () => {
  let server;
  let token;
  let userId;

  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();

    // Seed a challenge so GET /challenges/current doesn't blow up
    await prisma.challenge.create({
      data: {
        title: "Step Showdown",
        description: "Walk more than your opponent",
        type: "HEAD_TO_HEAD",
        resolutionRule: "most_steps",
        active: true,
      },
    });

    // Sign in and complete onboarding
    const signInRes = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "fake-token", email: EMAIL },
    });
    const signInBody = await signInRes.json();
    token = signInBody.sessionToken;
    userId = signInBody.user.id;

    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName: "HomeScreenUser" },
      token,
    });
    await request(server.baseUrl, "PUT", "/auth/me/step-goal", {
      body: { stepGoal: 10000 },
      token,
    });
  });

  it("GET /auth/session returns refreshed token and user", async () => {
    const res = await request(server.baseUrl, "GET", "/auth/session", { token });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(body.sessionToken);
    assert.equal(body.user.id, userId);
  });

  it("GET /auth/me returns full profile after onboarding", async () => {
    const res = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.user.displayName, "HomeScreenUser");
    assert.equal(body.user.stepGoal, 10000);
    assert.equal(body.user.coins, 0);
    assert.equal(body.user.incomingFriendRequests, 0);
  });

  it("POST /steps records steps and GET /steps retrieves them", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const postRes = await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 4200, date: today },
      token,
    });
    assert.equal(postRes.status, 200);

    const postBody = await postRes.json();
    assert.equal(postBody.record.steps, 4200);

    const getRes = await request(
      server.baseUrl,
      "GET",
      `/steps?date=${today}`,
      { token },
    );
    assert.equal(getRes.status, 200);

    const getBody = await getRes.json();
    assert.equal(getBody.record.steps, 4200);
  });

  it("POST /steps/samples records hourly step samples", async () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const res = await request(server.baseUrl, "POST", "/steps/samples", {
      body: {
        samples: [
          {
            periodStart: oneHourAgo.toISOString(),
            periodEnd: now.toISOString(),
            steps: 1500,
          },
        ],
      },
      token,
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.count, 1);
  });

  it("GET /friends/steps returns empty list for user with no friends", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const res = await request(
      server.baseUrl,
      "GET",
      `/friends/steps?date=${today}`,
      { token },
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.deepEqual(body.friends, []);
  });

  it("GET /challenges/current returns empty for user with no challenge", async () => {
    const res = await request(
      server.baseUrl,
      "GET",
      "/challenges/current",
      { token },
    );
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.deepEqual(body.instances, []);
  });

  it("GET /races returns empty for user with no races", async () => {
    const res = await request(server.baseUrl, "GET", "/races", { token });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.deepEqual(body.active, []);
    assert.deepEqual(body.pending, []);
    assert.deepEqual(body.completed, []);
  });

  it("POST /steps updates existing record for same date", async () => {
    const today = new Date().toISOString().slice(0, 10);

    await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 3000, date: today },
      token,
    });

    const updateRes = await request(server.baseUrl, "POST", "/steps", {
      body: { steps: 7500, date: today },
      token,
    });
    assert.equal(updateRes.status, 200);

    const getRes = await request(
      server.baseUrl,
      "GET",
      `/steps?date=${today}`,
      { token },
    );
    const body = await getRes.json();
    assert.equal(body.record.steps, 7500);
  });
});
