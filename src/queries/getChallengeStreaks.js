const { ChallengeStreak } = require("../models/challengeStreak");

async function getChallengeStreaks(userId) {
  return ChallengeStreak.findForUser(userId);
}

async function getChallengeStreakForFriend(userId, friendUserId) {
  return ChallengeStreak.findForPair(userId, friendUserId);
}

module.exports = { getChallengeStreaks, getChallengeStreakForFriend };
