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

// 1.3 — Challenge instance created on initiation with stake as proposal
test("POST /challenges/initiate creates a pending_stake instance with proposed stake", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async initiateChallenge(payload) {
        receivedPayload = payload;
        return {
          id: "instance-1",
          challengeId: "challenge-week-1",
          weekOf: "2026-03-16",
          userAId: "user-1",
          userBId: "user-2",
          stakeId: null,
          stakeStatus: "proposing",
          proposedById: "user-1",
          proposedStakeId: "stake-1",
          status: "pending_stake",
          winnerUserId: null,
          userATotalSteps: 0,
          userBTotalSteps: 0,
          resolvedAt: null,
          createdAt: "2026-03-16T14:00:00.000Z",
          updatedAt: "2026-03-16T14:00:00.000Z",
        };
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-2", stakeId: "stake-1" }),
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.instance.status, "pending_stake");
    assert.equal(body.instance.stakeStatus, "proposing");
    assert.equal(body.instance.proposedStakeId, "stake-1");
    assert.equal(body.instance.proposedById, "user-1");
    assert.equal(body.instance.stakeId, null);
    assert.equal(body.instance.userAId, "user-1");
    assert.equal(body.instance.userBId, "user-2");
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      friendUserId: "user-2",
      stakeId: "stake-1",
    });
  } finally {
    await server.close();
  }
});

// 1.4 — Duplicate pair prevention
test("POST /challenges/initiate returns 409 for duplicate pair in the same week", async () => {
  const error = new Error(
    "A challenge already exists between these users this week"
  );
  error.name = "ChallengeInitiationError";

  const server = await startServer(
    authMocks({
      async initiateChallenge() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-2", stakeId: "stake-1" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /already exists/);
  } finally {
    await server.close();
  }
});

// 1.5 — Cannot initiate with non-friend
test("POST /challenges/initiate returns 403 when users are not accepted friends", async () => {
  const error = new Error("You can only challenge accepted friends");
  error.name = "ChallengeInitiationError";
  error.statusCode = 403;

  const server = await startServer(
    authMocks({
      async initiateChallenge() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-not-friend", stakeId: "stake-1" }),
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /accepted friends/);
  } finally {
    await server.close();
  }
});

// 1.6 — Cannot initiate when no active challenge week
test("POST /challenges/initiate returns error when no challenge selected for current week", async () => {
  const error = new Error("No active challenge for the current week");
  error.name = "ChallengeInitiationError";

  const server = await startServer(
    authMocks({
      async initiateChallenge() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-2", stakeId: "stake-1" }),
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /No active challenge/);
  } finally {
    await server.close();
  }
});

// 1.7 — Multiple simultaneous challenges
test("POST /challenges/initiate allows initiating challenges with multiple friends", async () => {
  let callCount = 0;
  const friends = ["user-2", "user-3", "user-4"];

  const server = await startServer(
    authMocks({
      async initiateChallenge(payload) {
        const idx = callCount++;
        assert.equal(payload.userId, "user-1");
        assert.equal(payload.friendUserId, friends[idx]);
        assert.equal(payload.stakeId, "stake-1");
        return {
          id: `instance-${idx + 1}`,
          challengeId: "challenge-week-1",
          weekOf: "2026-03-16",
          userAId: "user-1",
          userBId: friends[idx],
          status: "pending_stake",
          proposedStakeId: "stake-1",
          stakeStatus: "proposing",
        };
      },
    })
  );

  try {
    for (let i = 0; i < friends.length; i++) {
      const response = await fetch(`${server.baseUrl}/challenges/initiate`, {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ friendUserId: friends[i], stakeId: "stake-1" }),
      });

      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.instance.id, `instance-${i + 1}`);
      assert.equal(body.instance.userBId, friends[i]);
      assert.equal(body.instance.status, "pending_stake");
    }

    assert.equal(callCount, 3, "Should have created 3 independent instances");
  } finally {
    await server.close();
  }
});

// 1.8 — Challenge becomes active after opponent accepts the proposed stake
test("Challenge transitions: initiate with stake → opponent accepts → active", async () => {
  const server = await startServer(
    authMocks({
      async initiateChallenge() {
        return {
          id: "instance-1",
          challengeId: "challenge-week-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-1",
          proposedStakeId: "stake-1",
          stakeId: null,
          userAId: "user-1",
          userBId: "user-2",
        };
      },
      async respondToStake({ accept }) {
        assert.equal(accept, true);
        return {
          id: "instance-1",
          status: "active",
          stakeStatus: "agreed",
          stakeId: "stake-1",
        };
      },
      async getChallengeProgress(userId, instanceId) {
        assert.equal(instanceId, "instance-1");
        return {
          instanceId: "instance-1",
          status: "active",
          challenge: { title: "Beat Your Partner", type: "head_to_head" },
          stake: { id: "stake-1", name: "Buy Ice Cream" },
          userA: { userId: "user-1", totalSteps: 25000 },
          userB: { userId: "user-2", totalSteps: 22000 },
        };
      },
    })
  );

  try {
    // Step 1: Initiate with stake → pending_stake
    const initRes = await fetch(`${server.baseUrl}/challenges/initiate`, {
      method: "POST",
      headers: {
        authorization: "Bearer apple-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ friendUserId: "user-2", stakeId: "stake-1" }),
    });
    assert.equal(initRes.status, 201);
    const initBody = await initRes.json();
    assert.equal(initBody.instance.status, "pending_stake");
    assert.equal(initBody.instance.proposedStakeId, "stake-1");

    // Step 2: Opponent accepts → active
    const acceptRes = await fetch(
      `${server.baseUrl}/challenges/instance-1/respond-stake`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true }),
      }
    );
    assert.equal(acceptRes.status, 200);
    const acceptBody = await acceptRes.json();
    assert.equal(acceptBody.instance.status, "active");
    assert.equal(acceptBody.instance.stakeId, "stake-1");

    // Step 3: Check progress
    const progressRes = await fetch(
      `${server.baseUrl}/challenges/instance-1/progress`,
      {
        headers: { authorization: "Bearer apple-token" },
      }
    );
    assert.equal(progressRes.status, 200);
    const progressBody = await progressRes.json();
    assert.equal(progressBody.progress.status, "active");
    assert.equal(progressBody.progress.userA.totalSteps, 25000);
  } finally {
    await server.close();
  }
});
