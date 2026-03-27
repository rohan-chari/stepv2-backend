const { Friendship } = require("../models/friendship");
const { Steps } = require("../models/steps");

async function getFriendsList(userId) {
  const friendships = await Friendship.findFriends(userId);

  return friendships.map((f) => {
    const friend = f.requesterId === userId ? f.addressee : f.requester;
    return { id: friend.id, displayName: friend.displayName, friendshipId: f.id };
  });
}

async function getPendingRequests(userId) {
  const [incoming, outgoing] = await Promise.all([
    Friendship.findPendingIncoming(userId),
    Friendship.findPendingOutgoing(userId),
  ]);

  return {
    incoming: incoming.map((f) => ({
      friendshipId: f.id,
      user: { id: f.requester.id, displayName: f.requester.displayName },
    })),
    outgoing: outgoing.map((f) => ({
      friendshipId: f.id,
      user: { id: f.addressee.id, displayName: f.addressee.displayName },
    })),
  };
}

async function getIncomingFriendRequestCount(userId) {
  return Friendship.countPendingIncoming(userId);
}

async function getFriendsWithSteps(userId, date) {
  const friendships = await Friendship.findFriendsWithStepGoals(userId);

  const friends = friendships.map((f) => {
    const friend = f.requesterId === userId ? f.addressee : f.requester;
    return { id: friend.id, displayName: friend.displayName, stepGoal: friend.stepGoal };
  });

  const stepsResults = await Promise.all(
    friends.map((f) => Steps.findByUserIdAndDate(f.id, date))
  );

  return friends.map((f, i) => ({
    ...f,
    steps: stepsResults[i]?.steps ?? 0,
  }));
}

module.exports = { getFriendsList, getPendingRequests, getIncomingFriendRequestCount, getFriendsWithSteps };
