const { Buffer } = require("node:buffer");
const {
  canonicalUserPair,
} = require("../../social/models/friendshipAutoLinkSuppression");
const {
  lockFriendshipPair,
} = require("../../social/services/friendshipPairLock");

async function assertRaceInviteRelationshipAllowed(
  tx,
  creatorUserId,
  requesterUserId,
  { acquireLock = true } = {},
) {
  const pair = canonicalUserPair(creatorUserId, requesterUserId);
  if (!pair) return;
  if (acquireLock) {
    await lockFriendshipPair(tx, creatorUserId, requesterUserId);
  }
  const [friendships, suppression] = await Promise.all([
    tx.friendship.findMany({
      where: {
        OR: [
          { requesterId: creatorUserId, addresseeId: requesterUserId },
          { requesterId: requesterUserId, addresseeId: creatorUserId },
        ],
      },
      select: { status: true },
    }),
    tx.friendshipAutoLinkSuppression.findUnique({
      where: { userAId_userBId: pair },
      select: { reason: true },
    }),
  ]);
  // A current accepted friendship is canonical even if an old suppression row
  // remains as audit history. Otherwise a declined row or suppression means a
  // deliberate relationship boundary and must prevent an indirect race invite.
  if (friendships.some((row) => row.status === "ACCEPTED")) return;
  if (suppression || friendships.some((row) => row.status === "DECLINED")) {
    throw new RaceJoinRequestError(
      "This relationship does not allow race invitations",
      409,
      "BLOCKED_RELATIONSHIP",
    );
  }
}

function serializeJoinRequest(row) {
  return {
    id: row.id,
    raceId: row.raceId,
    sharedByUserId: row.sharedByUserId ?? null,
    requesterUserId: row.requesterUserId,
    creatorUserId: row.creatorUserId,
    status: row.status,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt ?? null,
    failureCode: row.failureCode ?? null,
  };
}

function encodeJoinRequestCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  })).toString("base64url");
}

function decodeJoinRequestCursor(value) {
  if (value == null || value === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.id !== "string" ||
        typeof parsed.createdAt !== "string" ||
        Number.isNaN(Date.parse(parsed.createdAt))) {
      throw new Error("invalid");
    }
    return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
  } catch {
    throw new RaceJoinRequestError("Invalid cursor", 400, "INVALID_CURSOR");
  }
}

class RaceJoinRequestError extends Error {
  constructor(message, statusCode, code, meta = null) {
    super(message);
    this.name = "RaceJoinRequestError";
    this.statusCode = statusCode;
    this.code = code;
    this.meta = meta;
  }
}

module.exports = {
  RaceJoinRequestError,
  assertRaceInviteRelationshipAllowed,
  serializeJoinRequest,
  encodeJoinRequestCursor,
  decodeJoinRequestCursor,
};
