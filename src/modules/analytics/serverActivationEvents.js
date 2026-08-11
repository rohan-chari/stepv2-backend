const { prisma } = require("../../db");

const SERVER_APP_VERSION = "0.0";
const SERVER_PLATFORM = "other";

async function recordServerActivationEvent({
  db = prisma,
  id,
  userId,
  name,
  context = {},
  occurredAt = new Date(),
}) {
  if (!userId) return false;
  const result = await db.activationEvent.createMany({
    data: [{
      id,
      userId,
      name,
      context,
      appVersion: SERVER_APP_VERSION,
      platform: SERVER_PLATFORM,
      occurredAt,
    }],
    skipDuplicates: true,
  });
  return result.count === 1;
}

module.exports = { recordServerActivationEvent };
