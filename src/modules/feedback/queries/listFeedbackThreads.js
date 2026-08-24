const { prisma: defaultPrisma } = require("../../../db");
const {
  decodeCursor,
  encodeCursor,
  parseLimit,
} = require("../../inbox/services/inbox");

async function listFeedbackThreads({
  limit: rawLimit,
  cursor: rawCursor,
  prisma = defaultPrisma,
  now = new Date(),
} = {}) {
  const limit = parseLimit(rawLimit);
  const cursor = decodeCursor(rawCursor);
  const where = {
    expiresAt: { gt: now },
    ...(cursor ? { OR: [
      { lastMessageAt: { lt: cursor.createdAt } },
      { lastMessageAt: cursor.createdAt, id: { lt: cursor.id } },
    ] } : {}),
  };

  const rows = await prisma.feedbackThread.findMany({
    where,
    take: limit + 1,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    include: {
      messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
      user: { select: { displayName: true } },
    },
  });
  const more = rows.length > limit;
  const threads = rows.slice(0, limit);

  return {
    threads: threads.map((thread) => ({
      id: thread.id,
      suggestionId: thread.suggestionId,
      preview: thread.messages[0]?.text || "",
      lastMessageAt: thread.lastMessageAt,
      userUnread: thread.staffReadAt == null,
      displayName: thread.user?.displayName ?? null,
    })),
    nextCursor: more
      ? encodeCursor({ id: threads.at(-1).id, createdAt: threads.at(-1).lastMessageAt })
      : null,
  };
}

module.exports = { listFeedbackThreads };
