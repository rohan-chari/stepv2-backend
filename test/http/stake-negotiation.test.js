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

function authMocksAs(userId, displayName, overrides = {}) {
  return {
    async verifyAppleIdentityToken(token) {
      return { sub: `apple-${userId}` };
    },
    async ensureAppleUser() {
      return {
        id: userId,
        appleId: `apple-${userId}`,
        displayName,
      };
    },
    ...overrides,
  };
}

function authMocks(overrides = {}) {
  return authMocksAs("user-1", "Trail Walker", overrides);
}

// 2.1 — Propose a stake
test("POST /challenges/:instanceId/propose-stake sets proposed stake on instance", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocks({
      async proposeStake(payload) {
        receivedPayload = payload;
        return {
          id: "instance-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-1",
          proposedStakeId: "stake-ice-cream",
          stakeId: null,
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/propose-stake`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stakeId: "stake-ice-cream" }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instance.proposedById, "user-1");
    assert.equal(body.instance.proposedStakeId, "stake-ice-cream");
    assert.equal(body.instance.stakeStatus, "proposing");
    assert.deepEqual(receivedPayload, {
      userId: "user-1",
      instanceId: "instance-1",
      stakeId: "stake-ice-cream",
    });
  } finally {
    await server.close();
  }
});

// 2.2 — Accept a stake
test("PUT /challenges/:instanceId/respond-stake with accept=true locks in the stake", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocksAs("user-2", "Trail Buddy", {
      async respondToStake(payload) {
        receivedPayload = payload;
        return {
          id: "instance-1",
          status: "active",
          stakeStatus: "agreed",
          stakeId: "stake-ice-cream",
          proposedById: "user-1",
          proposedStakeId: "stake-ice-cream",
        };
      },
    })
  );

  try {
    const response = await fetch(
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

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instance.stakeId, "stake-ice-cream");
    assert.equal(body.instance.stakeStatus, "agreed");
    assert.equal(body.instance.status, "active");
    assert.deepEqual(receivedPayload, {
      userId: "user-2",
      instanceId: "instance-1",
      accept: true,
    });
  } finally {
    await server.close();
  }
});

// 2.3 — Counter a stake
test("PUT /challenges/:instanceId/respond-stake with accept=false and counterStakeId counters", async () => {
  let receivedPayload;

  const server = await startServer(
    authMocksAs("user-2", "Trail Buddy", {
      async respondToStake(payload) {
        receivedPayload = payload;
        return {
          id: "instance-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-2",
          proposedStakeId: "stake-dinner",
          stakeId: null,
        };
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/respond-stake`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: false,
          counterStakeId: "stake-dinner",
        }),
      }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instance.proposedById, "user-2");
    assert.equal(body.instance.proposedStakeId, "stake-dinner");
    assert.equal(body.instance.stakeStatus, "proposing");
    assert.equal(body.instance.stakeId, null);
    assert.deepEqual(receivedPayload, {
      userId: "user-2",
      instanceId: "instance-1",
      accept: false,
      counterStakeId: "stake-dinner",
    });
  } finally {
    await server.close();
  }
});

// 2.4 — Multi-round negotiation
test("Multi-round negotiation: A proposes → B counters → A counters → B accepts", async () => {
  // Test from User A's perspective (propose and counter)
  const serverA = await startServer(
    authMocksAs("user-a", "User A", {
      async proposeStake(payload) {
        assert.equal(payload.userId, "user-a");
        assert.equal(payload.stakeId, "stake-1");
        return {
          id: "instance-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-a",
          proposedStakeId: "stake-1",
          stakeId: null,
        };
      },
      async respondToStake(payload) {
        assert.equal(payload.userId, "user-a");
        assert.equal(payload.accept, false);
        assert.equal(payload.counterStakeId, "stake-3");
        return {
          id: "instance-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-a",
          proposedStakeId: "stake-3",
          stakeId: null,
        };
      },
    })
  );

  // Test from User B's perspective (counter and accept)
  const serverB = await startServer(
    authMocksAs("user-b", "User B", {
      async respondToStake(payload) {
        assert.equal(payload.userId, "user-b");

        if (payload.accept) {
          // Final accept — locks in stake-3 (User A's last counter)
          return {
            id: "instance-1",
            status: "active",
            stakeStatus: "agreed",
            stakeId: "stake-3",
            proposedById: "user-a",
            proposedStakeId: "stake-3",
          };
        }

        // Counter with stake-2
        assert.equal(payload.counterStakeId, "stake-2");
        return {
          id: "instance-1",
          status: "pending_stake",
          stakeStatus: "proposing",
          proposedById: "user-b",
          proposedStakeId: "stake-2",
          stakeId: null,
        };
      },
    })
  );

  try {
    // Round 1: User A proposes stake-1
    const r1 = await fetch(
      `${serverA.baseUrl}/challenges/instance-1/propose-stake`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stakeId: "stake-1" }),
      }
    );
    assert.equal(r1.status, 200);
    const r1Body = await r1.json();
    assert.equal(r1Body.instance.proposedById, "user-a");
    assert.equal(r1Body.instance.proposedStakeId, "stake-1");

    // Round 2: User B counters with stake-2
    const r2 = await fetch(
      `${serverB.baseUrl}/challenges/instance-1/respond-stake`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: false, counterStakeId: "stake-2" }),
      }
    );
    assert.equal(r2.status, 200);
    const r2Body = await r2.json();
    assert.equal(r2Body.instance.proposedById, "user-b");
    assert.equal(r2Body.instance.proposedStakeId, "stake-2");

    // Round 3: User A counters with stake-3
    const r3 = await fetch(
      `${serverA.baseUrl}/challenges/instance-1/respond-stake`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: false, counterStakeId: "stake-3" }),
      }
    );
    assert.equal(r3.status, 200);
    const r3Body = await r3.json();
    assert.equal(r3Body.instance.proposedById, "user-a");
    assert.equal(r3Body.instance.proposedStakeId, "stake-3");

    // Round 4: User B accepts stake-3
    const r4 = await fetch(
      `${serverB.baseUrl}/challenges/instance-1/respond-stake`,
      {
        method: "PUT",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ accept: true }),
      }
    );
    assert.equal(r4.status, 200);
    const r4Body = await r4.json();
    assert.equal(r4Body.instance.status, "active");
    assert.equal(r4Body.instance.stakeStatus, "agreed");
    assert.equal(r4Body.instance.stakeId, "stake-3");
  } finally {
    await serverA.close();
    await serverB.close();
  }
});

// 2.5 — Cannot propose on someone else's instance
test("POST /challenges/:instanceId/propose-stake returns 403 for non-participant", async () => {
  const error = new Error("You are not a participant in this challenge");
  error.name = "StakeNegotiationError";
  error.statusCode = 403;

  const server = await startServer(
    authMocksAs("user-c", "Outsider", {
      async proposeStake() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/propose-stake`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stakeId: "stake-1" }),
      }
    );

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /not a participant/);
  } finally {
    await server.close();
  }
});

// 2.6 — Cannot propose with invalid stake ID
test("POST /challenges/:instanceId/propose-stake returns 400 for invalid stakeId", async () => {
  const error = new Error("Stake not found or inactive");
  error.name = "StakeNegotiationError";

  const server = await startServer(
    authMocks({
      async proposeStake() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/propose-stake`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stakeId: "nonexistent-stake" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /not found|inactive/);
  } finally {
    await server.close();
  }
});

// 2.7 — Cannot accept your own proposal
test("PUT /challenges/:instanceId/respond-stake returns 400 when accepting own proposal", async () => {
  const error = new Error(
    "You cannot accept your own proposal — only the other user can respond"
  );
  error.name = "StakeNegotiationError";

  const server = await startServer(
    authMocks({
      async respondToStake() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(
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

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /cannot accept your own/);
  } finally {
    await server.close();
  }
});

// 2.8 — Cannot propose on an already-active challenge
test("POST /challenges/:instanceId/propose-stake returns 400 on already-active challenge", async () => {
  const error = new Error(
    "Stake negotiation is closed — challenge is already active"
  );
  error.name = "StakeNegotiationError";

  const server = await startServer(
    authMocks({
      async proposeStake() {
        throw error;
      },
    })
  );

  try {
    const response = await fetch(
      `${server.baseUrl}/challenges/instance-1/propose-stake`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer apple-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ stakeId: "stake-1" }),
      }
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /already active/);
  } finally {
    await server.close();
  }
});

// 2.9 — Skipped challenge on no agreement
test("Unresolved pending_stake instance is marked as skipped after resolution", async () => {
  const { resolveWeeklyChallenges } = require("../../src/services/challengeResolution");

  const pendingInstance = {
    id: "instance-1",
    challengeId: "challenge-week-1",
    weekOf: "2026-03-16",
    userAId: "user-1",
    userBId: "user-2",
    status: "pending_stake",
    stakeStatus: "proposing",
    stakeId: null,
    winnerUserId: null,
  };

  const updatedInstances = [];

  await resolveWeeklyChallenges({
    findActiveAndPendingInstances() {
      return [pendingInstance];
    },
    getDailySteps() {
      return [];
    },
    updateInstance(id, fields) {
      updatedInstances.push({ id, ...fields });
    },
  });

  assert.equal(updatedInstances.length, 1);
  assert.equal(updatedInstances[0].id, "instance-1");
  assert.equal(updatedInstances[0].status, "completed");
  assert.equal(updatedInstances[0].stakeStatus, "skipped");
  assert.equal(updatedInstances[0].winnerUserId, null);
});
