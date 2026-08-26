const { prisma: defaultPrisma } = require("../../../db");
const crypto = require("node:crypto");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");

const STAFF_REPLY_LIMIT_PER_HOUR = 60;
const THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

class StaffReplyError extends Error {
  constructor(message, { code, statusCode }) {
    super(message);
    this.name = "StaffReplyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function buildSendStaffReply(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  const transaction = dependencies.transaction || ((work) => prisma.$transaction(work));
  return async function sendStaffReply({ threadId, text, idempotencyKey, now = new Date(), tx = null }) {
    const work = async (client) => {
      const thread = await client.feedbackThread.findFirst({
        where: { id: threadId, expiresAt: { gt: now } },
      });
      if (!thread) throw new StaffReplyError("Thread not found", { code: "NOT_FOUND", statusCode: 404 });
      const existing = await client.feedbackMessage.findUnique({
        where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
      });
      if (existing) return { message: existing, created: false, recipientUserId: thread.userId };
      const recent = await client.feedbackMessage.count({
        where: {
          senderKind: "STAFF",
          createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
        },
      });
      if (recent >= STAFF_REPLY_LIMIT_PER_HOUR) {
        throw new StaffReplyError("Too many support replies", { code: "RATE_LIMITED", statusCode: 429 });
      }
      let message;
      if (typeof client.feedbackMessage.createMany === "function") {
        const messageId = crypto.randomUUID();
        const inserted = await client.feedbackMessage.createMany({
          data: [{ id: messageId, threadId, senderKind: "STAFF", text, idempotencyKey }],
          skipDuplicates: true,
        });
        message = await client.feedbackMessage.findUnique({
          where: { threadId_idempotencyKey: { threadId, idempotencyKey } },
        });
        if (inserted.count !== 1) {
          return { message, created: false, recipientUserId: thread.userId };
        }
      } else {
        message = await client.feedbackMessage.create({
          data: { threadId, senderKind: "STAFF", text, idempotencyKey },
        });
      }
      await client.feedbackThread.update({
        where: { id: threadId },
        data: {
          lastMessageAt: now,
          lastStaffReplyAt: message.createdAt || now,
          lastStaffReplyMessageId: message.id,
          expiresAt: new Date(now.getTime() + THREAD_RETENTION_MS),
          staffReadAt: now,
          userReadAt: null,
        },
      });
      await appendDomainEvent(client, {
        eventKey: `SUPPORT_REPLY_CREATED_V1:${message.id}`,
        eventType: "SUPPORT_REPLY_CREATED_V1",
        schemaVersion: 1,
        aggregateType: "FEEDBACK_THREAD",
        aggregateId: threadId,
        occurredAt: message.createdAt || now,
        payload: { messageId: message.id, threadId, userId: thread.userId },
        audience: [{ recipientId: thread.userId, facts: {} }],
      });
      return { message, created: true, recipientUserId: thread.userId };
    };
    return tx ? work(tx) : transaction(work);
  };
}

module.exports = {
  STAFF_REPLY_LIMIT_PER_HOUR,
  StaffReplyError,
  buildSendStaffReply,
};
