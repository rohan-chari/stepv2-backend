const { ChallengeInstance } = require("../models/challengeInstance");

async function getChallengeHistory(userId, { page = 1, limit = 10 } = {}) {
  const { instances, total } = await ChallengeInstance.findHistoryForUser(
    userId,
    { page, limit }
  );

  return {
    instances,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

module.exports = { getChallengeHistory };
