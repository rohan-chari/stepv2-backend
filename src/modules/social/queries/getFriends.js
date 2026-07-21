const { Friendship } = require("../models/friendship");
const { Steps } = require("../../steps/models/steps");
const { characterPresentation } = require("../../cosmetics");
const { TEAM_RACES_FEATURE } = require("../../races/teamRaces");

// TR-708: a friend is team-race-eligible once any client of theirs has declared
// the team_races token (TR-706 records these stickily, so this never flickers
// back to false). No recorded tokens => ineligible (pessimistic default —
// dormant accounts show "needs app update" until they next connect).
function isTeamRaceEligible(friend) {
  return Array.isArray(friend?.clientFeatures)
    ? friend.clientFeatures.includes(TEAM_RACES_FEATURE)
    : false;
}

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
        // TR-708: always present, context-free. The friend picker grays out
        // ineligible friends instead of failing at invite time.
        teamRaceEligible: isTeamRaceEligible(friend),
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
      // TR-708: same flag on the with-steps list (invite picker source).
      teamRaceEligible: isTeamRaceEligible(friend),
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
