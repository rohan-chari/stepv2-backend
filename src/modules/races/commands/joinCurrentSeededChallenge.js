const { AppError } = require('../../../shared/errors/AppError');
const { buildSeededChallengeAdmission } = require('../services/seededChallengeAdmission');
function buildJoinCurrentSeededChallenge(dependencies = {}) {
  const admission = buildSeededChallengeAdmission(dependencies);
  return async ({ user, seedKind, body, clientFeatures }) => {
    if (!clientFeatures?.has('seeded_race_buckets')) throw new AppError('Update the app to join this challenge', 'UPDATE_REQUIRED', 400);
    if (!body || Object.keys(body).some(key => key !== 'requestId') || typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) throw new AppError('A valid requestId is required', 'INVALID_REQUEST', 400);
    if (user.isReviewAccount === true) throw new AppError('This account cannot enter live challenges', 'CHALLENGE_NOT_ELIGIBLE', 403);
    return admission.admit({ userId: user.id, seedKind, requestId: body.requestId.toLowerCase() });
  };
}
module.exports = { buildJoinCurrentSeededChallenge };
