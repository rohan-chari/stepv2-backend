const crypto = require("node:crypto");
const { AppError, ConflictError, ValidationError } = require("../../../shared/errors/AppError");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hashJson(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
    return input;
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function createGiveawayIdempotency({ db, env = process.env }) {
  function requireKey(key) {
    if (!UUID_V4.test(String(key || ""))) throw new ValidationError("A UUIDv4 Idempotency-Key is required", "INVALID_IDEMPOTENCY_KEY");
  }

  async function withIdempotency({ actorId, method, contestId = null, key, body }, work) {
    requireKey(key);
    let bodyForHash = body || {};
    if (typeof body?.providerReference === "string") {
      const secret = env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET;
      if (!secret) throw new AppError("Provider reference protection unavailable", "INTERNAL_ERROR", 500);
      bodyForHash = {
        ...body,
        providerReference: `hmac:${crypto.createHmac("sha256", secret).update(body.providerReference).digest("hex")}`,
      };
    }
    const requestHash = hashJson({ method, contestId, body: bodyForHash });
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`giveaway-idempotency:${actorId}:${key}`}))`;
      const existing = await tx.giveawayIdempotencyReceipt.findUnique({
        where: { actorId_idempotencyKey: { actorId, idempotencyKey: key } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictError("Idempotency key was used for another request", "IDEMPOTENCY_CONFLICT");
        }
        if (existing.responseBody == null) throw new ConflictError("Request is still processing", "IDEMPOTENCY_IN_PROGRESS");
        return existing.responseBody;
      }
      const receipt = await tx.giveawayIdempotencyReceipt.create({ data: {
        actorId, idempotencyKey: key, method, contestId, requestHash,
      } });
      const response = await work(tx, requestHash);
      await tx.giveawayIdempotencyReceipt.update({
        where: { id: receipt.id }, data: { responseBody: response },
      });
      return response;
    });
  }

  return { requireKey, withIdempotency };
}

module.exports = { UUID_V4, createGiveawayIdempotency, hashJson };
