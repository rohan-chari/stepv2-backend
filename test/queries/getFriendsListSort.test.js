const assert = require("node:assert/strict");
const test = require("node:test");

// getFriendsList imports the Friendship model directly. Mock the module and
// re-require the query (same monkey-patch pattern as
// getFriendsWithStepsSort.test.js) so we can assert the alphabetical ordering
// of the main friends list without a real DB.
function withMockedFriends(friendships, fn) {
  const friendshipModule = require("../../src/modules/social/models/friendship");
  const originalFriendship = friendshipModule.Friendship;

  Object.assign(friendshipModule, {
    Friendship: {
      async findFriends() {
        return friendships;
      },
    },
  });

  try {
    delete require.cache[require.resolve("../../src/modules/social/queries/getFriends")];
    const mod = require("../../src/modules/social/queries/getFriends");
    return fn(mod);
  } finally {
    Object.assign(friendshipModule, { Friendship: originalFriendship });
    delete require.cache[require.resolve("../../src/modules/social/queries/getFriends")];
  }
}

// The viewer is "me"; each friendship pairs "me" with a friend. We vary which
// side "me" sits on (requester vs addressee) to prove the sort keys off the
// friend's displayName regardless of friendship direction.
function friendshipWith(friend, { meIsRequester = true } = {}) {
  const me = { id: "me", displayName: "Me", equippedAccessories: [] };
  const friendUser = {
    id: friend.id,
    displayName: friend.displayName,
    equippedAccessories: [],
  };
  return meIsRequester
    ? { id: `f-${friend.id}`, requesterId: "me", requester: me, addresseeId: friend.id, addressee: friendUser }
    : { id: `f-${friend.id}`, requesterId: friend.id, requester: friendUser, addresseeId: "me", addressee: me };
}

test("getFriendsList returns friends alphabetically by displayName", async () => {
  const friendships = [
    friendshipWith({ id: "u-charlie", displayName: "Charlie" }),
    friendshipWith({ id: "u-alice", displayName: "Alice" }, { meIsRequester: false }),
    friendshipWith({ id: "u-bob", displayName: "Bob" }),
  ];

  await withMockedFriends(friendships, async ({ getFriendsList }) => {
    const result = await getFriendsList("me");
    assert.deepEqual(
      result.map((f) => f.displayName),
      ["Alice", "Bob", "Charlie"]
    );
  });
});

test("getFriendsList sorts case-insensitively", async () => {
  const friendships = [
    friendshipWith({ id: "u-zoe", displayName: "zoe" }),
    friendshipWith({ id: "u-adam", displayName: "Adam" }),
    friendshipWith({ id: "u-bella", displayName: "bella" }),
  ];

  await withMockedFriends(friendships, async ({ getFriendsList }) => {
    const result = await getFriendsList("me");
    assert.deepEqual(
      result.map((f) => f.displayName),
      ["Adam", "bella", "zoe"]
    );
  });
});

test("getFriendsList tolerates a missing displayName (older/partial row)", async () => {
  const friendships = [
    friendshipWith({ id: "u-beth", displayName: "Beth" }),
    friendshipWith({ id: "u-null", displayName: null }),
    friendshipWith({ id: "u-amy", displayName: "Amy" }),
  ];

  await withMockedFriends(friendships, async ({ getFriendsList }) => {
    // Should not throw; null name sorts first (treated as empty string).
    const result = await getFriendsList("me");
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((f) => f.displayName), [null, "Amy", "Beth"]);
  });
});
