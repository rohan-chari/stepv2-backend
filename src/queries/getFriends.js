const { Friendship } = require("../models/friendship");
const { Steps } = require("../models/steps");
const { characterPresentation } = require("../utils/shopCosmetics");

async function getFriendsList(userId, supportsCharacters = false) {
  const friendships = await Friendship.findFriends(userId);

  return friendships
    .map((f) => {
      const friend = f.requesterId === userId ? f.addressee : f.requester;
      return {
        id: friend.id,
        displayName: friend.displayName,
        profilePhotoUrl: friend.profilePhotoUrl,
        ...characterPresentation(friend, supportsCharacters),
        friendshipId: f.id,
      };
    })
    // Alphabetical, mirroring getFriendsWithSteps below: the friend's
    // displayName lives on the related user (requester/addressee depending on
    // direction), so there's no single column to ORDER BY in the Prisma
    // query — sort here after mapping. Case-insensitive; null-safe.
    .sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? "", undefined, {
        sensitivity: "base",
      })
    );
}

async function getPendingRequests(userId) {
  const [incoming, outgoing] = await Promise.all([
    Friendship.findPendingIncoming(userId),
    Friendship.findPendingOutgoing(userId),
  ]);

  return {
    incoming: incoming.map((f) => ({
      friendshipId: f.id,
      user: {
        id: f.requester.id,
        displayName: f.requester.displayName,
        profilePhotoUrl: f.requester.profilePhotoUrl,
      },
    })),
    outgoing: outgoing.map((f) => ({
      friendshipId: f.id,
      user: {
        id: f.addressee.id,
        displayName: f.addressee.displayName,
        profilePhotoUrl: f.addressee.profilePhotoUrl,
      },
    })),
  };
}

async function getIncomingFriendRequestCount(userId) {
  return Friendship.countPendingIncoming(userId);
}

async function getFriendsWithSteps(userId, date, supportsCharacters = false) {
  const friendships = await Friendship.findAcceptedFriendsWithDisplay(userId);

  const friends = friendships.map((f) => {
    const friend = f.requesterId === userId ? f.addressee : f.requester;
    return {
      id: friend.id,
      displayName: friend.displayName,
      profilePhotoUrl: friend.profilePhotoUrl,
      ...characterPresentation(friend, supportsCharacters),
    };
  });

  const stepsResults = await Promise.all(
    friends.map((f) => Steps.findByUserIdAndDate(f.id, date))
  );

  return friends
    .map((f, i) => ({
      ...f,
      steps: stepsResults[i]?.steps ?? 0,
      // 1.1.4 compat — pre-step-goal-removal clients render this on friend cards.
      stepGoal: 5000,
    }))
    // Alphabetical by name so the invite-friends list is easy to scan. The
    // friend's displayName lives on the related user (requester/addressee
    // depending on direction), so there's no single column to ORDER BY in the
    // Prisma query — sort here after mapping. Case-insensitive; null-safe.
    .sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? "", undefined, {
        sensitivity: "base",
      })
    );
}

module.exports = { getFriendsList, getPendingRequests, getIncomingFriendRequestCount, getFriendsWithSteps };
