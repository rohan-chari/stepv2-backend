const { prisma: defaultPrisma } = require("../../../db");
const { withAdvisoryLock } = require("../../../shared/db/withAdvisoryLock");
const {
  canonicalUserPair,
} = require("../models/friendshipAutoLinkSuppression");

function friendshipPairLockKey(left, right) {
  const pair = canonicalUserPair(left, right);
  if (!pair) return null;
  return `friendship-pair:${pair.userAId}:${pair.userBId}`;
}

async function lockFriendshipPair(transactionClient, left, right) {
  const key = friendshipPairLockKey(left, right);
  if (!key) return null;
  await transactionClient.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${key}))
  `;
  return canonicalUserPair(left, right);
}

async function withFriendshipPairLock(
  left,
  right,
  callback,
  { prisma = defaultPrisma } = {}
) {
  const key = friendshipPairLockKey(left, right);
  if (!key) return callback(null, null);
  const pair = canonicalUserPair(left, right);
  return withAdvisoryLock(key, (tx) => callback(tx, pair), { prisma });
}

module.exports = {
  friendshipPairLockKey,
  lockFriendshipPair,
  withFriendshipPairLock,
};
