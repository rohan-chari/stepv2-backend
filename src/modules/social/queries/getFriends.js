const { Friendship } = require("../models/friendship");
const dailyStepsCache = require("../../steps/services/dailyStepsCache");
const { appSettings } = require("../../../shared/config/appSettings");
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

  // C4 (spec §5 Phase E): one indexed `steps` lookup PER FRIEND is the whole
  // cost of this endpoint, and the same friend's total is read by every one of
  // their friends. Cache it per friend+date with a 60s TTL, invalidated by that
  // friend's step sync. Flag off (or Redis unavailable) => `getMany` runs
  // exactly the per-user lookups this line used to do.
  //
  // Defensive read (CLAUDE.md): the flag lookup can never throw the request —
  // an unreadable app_settings row means "cache off", i.e. today's behavior.
  let cacheEnabled = false;
  try {
    cacheEnabled = (await appSettings.getFlag("redisCacheUserBitsEnabled")) === true;
  } catch {
    cacheEnabled = false;
  }
  const stepsByUser = await dailyStepsCache.getMany(
    friends.map((f) => f.id),
    date,
    cacheEnabled
  );

  return friends
    .map((f) => ({
      ...f,
      steps: stepsByUser.get(f.id) ?? 0,
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
