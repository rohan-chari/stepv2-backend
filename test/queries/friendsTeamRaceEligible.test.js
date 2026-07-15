const assert = require("node:assert/strict");
const test = require("node:test");

// TR-708: the friends list APIs always include a per-friend teamRaceEligible
// flag (context-free) reflecting the friend's LAST-SEEN client features.
// getFriends imports Friendship/Steps directly; mock + re-require (same
// pattern as getFriendsListSort.test.js).
function withMockedFriendships(friendships, fn) {
  const friendshipModule = require("../../src/models/friendship");
  const stepsModule = require("../../src/models/steps");
  const originalFriendship = friendshipModule.Friendship;
  const originalSteps = stepsModule.Steps;

  Object.assign(friendshipModule, {
    Friendship: {
      async findFriends() {
        return friendships;
      },
      async findAcceptedFriendsWithDisplay() {
        return friendships;
      },
    },
  });
  Object.assign(stepsModule, {
    Steps: {
      async findByUserIdAndDate() {
        return { steps: 100 };
      },
    },
  });

  try {
    delete require.cache[require.resolve("../../src/queries/getFriends")];
    const mod = require("../../src/queries/getFriends");
    return fn(mod);
  } finally {
    Object.assign(friendshipModule, { Friendship: originalFriendship });
    Object.assign(stepsModule, { Steps: originalSteps });
    delete require.cache[require.resolve("../../src/queries/getFriends")];
  }
}

function friendship(id, friend) {
  return {
    id: `f-${id}`,
    requesterId: "me",
    addresseeId: friend.id,
    requester: { id: "me", displayName: "Me", profilePhotoUrl: null },
    addressee: {
      profilePhotoUrl: null,
      equippedAccessories: [],
      ...friend,
    },
  };
}

test("TR-708 getFriendsList marks friends with team_races as eligible", async () => {
  const rows = [
    friendship(1, {
      id: "friend-new",
      displayName: "Blake",
      clientFeatures: ["characters", "team_races"],
    }),
    friendship(2, {
      id: "friend-old",
      displayName: "Alex",
      clientFeatures: ["characters"],
    }),
    friendship(3, {
      id: "friend-dormant",
      displayName: "Casey",
      clientFeatures: [],
    }),
    friendship(4, {
      id: "friend-legacy-null",
      displayName: "Drew",
      // Pre-deploy rows may deserialize without the column in stale codepaths.
      clientFeatures: undefined,
    }),
  ];
  await withMockedFriendships(rows, async ({ getFriendsList }) => {
    const friends = await getFriendsList("me");
    const byId = Object.fromEntries(friends.map((f) => [f.id, f]));
    assert.equal(byId["friend-new"].teamRaceEligible, true);
    assert.equal(byId["friend-old"].teamRaceEligible, false);
    assert.equal(byId["friend-dormant"].teamRaceEligible, false);
    assert.equal(byId["friend-legacy-null"].teamRaceEligible, false);
  });
});

test("TR-708 getFriendsWithSteps carries the same flag (invite picker uses it)", async () => {
  const rows = [
    friendship(1, {
      id: "friend-new",
      displayName: "Blake",
      clientFeatures: ["team_races"],
    }),
    friendship(2, {
      id: "friend-old",
      displayName: "Alex",
      clientFeatures: [],
    }),
  ];
  await withMockedFriendships(rows, async ({ getFriendsWithSteps }) => {
    const friends = await getFriendsWithSteps("me", "2026-07-15");
    const byId = Object.fromEntries(friends.map((f) => [f.id, f]));
    assert.equal(byId["friend-new"].teamRaceEligible, true);
    assert.equal(byId["friend-old"].teamRaceEligible, false);
  });
});

test("TR-708 raw clientFeatures array is NOT leaked in the payload", async () => {
  const rows = [
    friendship(1, {
      id: "friend-new",
      displayName: "Blake",
      clientFeatures: ["team_races"],
    }),
  ];
  await withMockedFriendships(rows, async ({ getFriendsList }) => {
    const friends = await getFriendsList("me");
    assert.equal("clientFeatures" in friends[0], false);
  });
});
