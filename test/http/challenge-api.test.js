const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function authMocks(overrides = {}) {
  return {
    async verifyAppleIdentityToken(token) {
      assert.equal(token, "apple-token");
      return { sub: "apple-user-123" };
    },
    async ensureAppleUser() {
      return {
        id: "user-1",
        appleId: "apple-user-123",
        email: "walker@example.com",
        displayName: "Trail Walker",
      };
    },
    ...overrides,
  };
}

// 6.1 — All challenge endpoints require auth
test("All challenge and stake endpoints return 401 without auth token", async () => {
  const server = await startServer();

  try {
    const endpoints = [
      { method: "GET", path: "/challenges/current" },
      { method: "POST", path: "/challenges/initiate" },
      { method: "GET", path: "/challenges/history" },
      { method: "POST", path: "/challenges/test-id/propose-stake" },
      { method: "PUT", path: "/challenges/test-id/respond-stake" },
      { method: "GET", path: "/challenges/test-id/progress" },
      { method: "GET", path: "/stakes" },
      { method: "GET", path: "/challenges/streaks" },
    ];

    for (const { method, path } of endpoints) {
      const response = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers:
          method === "POST" || method === "PUT"
            ? { "content-type": "application/json" }
            : {},
        body:
          method === "POST" || method === "PUT"
            ? JSON.stringify({})
            : undefined,
      });

      assert.equal(
        response.status,
        401,
        `${method} ${path} should return 401 without auth`
      );
      const body = await response.json();
      assert.equal(body.error, "Authorization bearer token is required");
    }
  } finally {
    await server.close();
  }
});

// 6.2 — GET /challenges/current returns challenge and instances
test("GET /challenges/current returns the weekly challenge and user's instances", async () => {
  const server = await startServer(
    authMocks({
      async getCurrentChallenge(userId) {
        assert.equal(userId, "user-1");
        return {
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
            description: "Whoever takes more steps this week wins.",
            type: "head_to_head",
            resolutionRule: "higher_total",
            thresholdValue: null,
          },
          weekOf: "2026-03-16",
          instances: [
            {
              id: "instance-1",
              userAId: "user-1",
              userBId: "user-2",
              status: "active",
              stakeStatus: "agreed",
              stakeId: "stake-1",
              userATotalSteps: 15000,
              userBTotalSteps: 12000,
            },
            {
              id: "instance-2",
              userAId: "user-1",
              userBId: "user-3",
              status: "pending_stake",
              stakeStatus: "proposing",
              stakeId: null,
              userATotalSteps: 0,
              userBTotalSteps: 0,
            },
          ],
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/current`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.challenge.title, "Beat Your Partner");
    assert.equal(body.challenge.type, "head_to_head");
    assert.equal(body.weekOf, "2026-03-16");
    assert.equal(body.instances.length, 2);
    assert.equal(body.instances[0].status, "active");
    assert.equal(body.instances[1].status, "pending_stake");
  } finally {
    await server.close();
  }
});

// 6.3 — GET /challenges/current with no active week
test("GET /challenges/current returns null challenge when no active week", async () => {
  const server = await startServer(
    authMocks({
      async getCurrentChallenge() {
        return {
          challenge: null,
          weekOf: null,
          instances: [],
          nextDropAt: "2026-03-23T14:00:00.000Z",
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/current`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.challenge, null);
    assert.deepEqual(body.instances, []);
    assert.ok(body.nextDropAt, "Should include next scheduled drop time");
  } finally {
    await server.close();
  }
});

// 6.4 — POST /challenges/initiate validates friendship
test("POST /challenges/initiate validates friendship: 403 for non-friend, 201 for valid friend", async () => {
  let callCount = 0;

  const server = await startServer(
    authMocks({
      async initiateChallenge(payload) {
        callCount++;

        if (payload.friendUserId === "not-a-friend") {
          const error = new Error("You can only challenge accepted friends");
          error.name = "ChallengeInitiationError";
          error.statusCode = 403;
          throw error;
        }

        return {
          id: "instance-1",
          challengeId: "challenge-1",
          weekOf: "2026-03-16",
          userAId: "user-1",
          userBId: payload.friendUserId,
          status: "pending_stake",
        };
      },
    })
  );

  try {
    // Non-friend → 403
    const badRes = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "not-a-friend" }),
    });
    assert.equal(badRes.status, 403);

    // Valid friend → 201
    const goodRes = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-2" }),
    });
    assert.equal(goodRes.status, 201);
    const goodBody = await goodRes.json();
    assert.equal(goodBody.instance.userBId, "user-2");
    assert.equal(callCount, 2);
  } finally {
    await server.close();
  }
});

// 6.5 — GET /challenges/history returns paginated results
test("GET /challenges/history returns results in reverse chronological order with pagination", async () => {
  const server = await startServer(
    authMocks({
      async getChallengeHistory(userId, { page, limit }) {
        assert.equal(userId, "user-1");
        assert.equal(page, 1);
        assert.equal(limit, 10);

        return {
          instances: [
            {
              id: "instance-25",
              weekOf: "2026-03-16",
              status: "completed",
              winnerUserId: "user-1",
              userATotalSteps: 55000,
              userBTotalSteps: 48000,
            },
            {
              id: "instance-24",
              weekOf: "2026-03-09",
              status: "completed",
              winnerUserId: "user-2",
              userATotalSteps: 42000,
              userBTotalSteps: 51000,
            },
          ],
          pagination: {
            page: 1,
            limit: 10,
            total: 25,
            totalPages: 3,
          },
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/history?page=1&limit=10`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instances.length, 2);
    assert.ok(body.pagination, "Should include pagination metadata");
    assert.equal(body.pagination.total, 25);
    assert.equal(body.pagination.totalPages, 3);

    // Results should be in reverse chronological order
    assert.ok(
      body.instances[0].weekOf >= body.instances[1].weekOf,
      "Results should be in reverse chronological order"
    );
  } finally {
    await server.close();
  }
});

// 6.6 — GET /challenges/:instanceId/progress returns both users' steps
test("GET /challenges/:instanceId/progress returns both users' current step totals", async () => {
  const server = await startServer(
    authMocks({
      async getChallengeProgress(userId, instanceId) {
        assert.equal(userId, "user-1");
        assert.equal(instanceId, "instance-1");
        return {
          instanceId: "instance-1",
          status: "active",
          challenge: {
            id: "challenge-1",
            title: "Beat Your Partner",
            type: "head_to_head",
            resolutionRule: "higher_total",
          },
          stake: {
            id: "stake-1",
            name: "Buy Ice Cream",
          },
          userA: { userId: "user-1", displayName: "Trail Walker", totalSteps: 32000 },
          userB: { userId: "user-2", displayName: "Trail Buddy", totalSteps: 28500 },
          weekOf: "2026-03-16",
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/progress`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.progress.instanceId, "instance-1");
    assert.equal(body.progress.status, "active");
    assert.equal(body.progress.userA.totalSteps, 32000);
    assert.equal(body.progress.userB.totalSteps, 28500);
    assert.ok(body.progress.challenge, "Should include challenge metadata");
    assert.ok(body.progress.stake, "Should include stake info");
    assert.equal(body.progress.challenge.title, "Beat Your Partner");
  } finally {
    await server.close();
  }
});

// 6.7 — GET /stakes returns full catalog
test("GET /stakes returns active stakes with all required fields", async () => {
  const server = await startServer(
    authMocks({
      async getStakeCatalog() {
        return [
          {
            id: "stake-1",
            name: "Buy Ice Cream",
            description: "Loser treats the winner to ice cream",
            category: "food",
            relationshipTags: ["partner", "friend", "family"],
            format: "in_person",
            active: true,
          },
          {
            id: "stake-2",
            name: "Movie Tickets",
            description: "Loser buys the winner movie tickets",
            category: "activity",
            relationshipTags: ["friend"],
            format: "in_person",
            active: true,
          },
        ];
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/stakes`, {
      headers: { authorization: "Bearer apple-token" },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.stakes));
    assert.equal(body.stakes.length, 2);

    // Verify all required fields are present
    for (const stake of body.stakes) {
      assert.ok(stake.id, "Stake should have id");
      assert.ok(stake.name, "Stake should have name");
      assert.ok(stake.category, "Stake should have category");
      assert.ok(Array.isArray(stake.relationshipTags), "Stake should have relationshipTags array");
      assert.ok(stake.format, "Stake should have format");
    }

    // Inactive stakes should not be present (mock only returns active)
    assert.ok(
      body.stakes.every((s) => s.active !== false),
      "No inactive stakes should be returned"
    );
  } finally {
    await server.close();
  }
});

// 6.8 — PUT /friends/:friendshipId/relationship-type validates ownership
test("PUT /friends/:friendshipId/relationship-type returns 403 for non-participant", async () => {
  const error = new Error("You are not a participant in this friendship");
  error.name = "RelationshipTypeError";
  error.statusCode = 403;

  const server = await startServer(
    authMocks({
      async updateRelationshipType() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/friends/f-1/relationship-type`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ relationshipType: "partner" }),
      }
    );

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /not a participant/);
  } finally {
    await server.close();
  }
});
