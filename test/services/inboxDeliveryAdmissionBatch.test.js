const test = require("node:test");
const assert = require("node:assert/strict");

const {
  admissionWakeAt,
  persistAdmittedAttemptResults,
  persistAdmittedPageResults,
} = require("../../src/modules/inbox/jobs/inboxDelivery");

test("admission wake waits for future work instead of spinning on a stale token", () => {
  const staleToken = new Date("2026-08-31T12:00:00Z");
  const futureWork = new Date("2026-08-31T12:01:00Z");
  assert.equal(
    admissionWakeAt({
      hasPending: true,
      nextTokenAt: staleToken,
      nextAvailableAt: futureWork,
    }, new Date("2026-08-31T12:00:30Z").getTime()).toISOString(),
    futureWork.toISOString(),
  );
  assert.equal(admissionWakeAt({ hasPending: false, nextTokenAt: staleToken }), null);
});

test("admission wake coalesces ten-millisecond tokens into bounded pages", () => {
  const now = new Date("2026-08-31T12:00:00.000Z");
  const nextToken = new Date("2026-08-31T12:00:00.010Z");
  assert.equal(
    admissionWakeAt({
      hasPending: true,
      nextTokenAt: nextToken,
      nextAvailableAt: now,
    }, now.getTime()).toISOString(),
    "2026-08-31T12:00:00.100Z",
  );
});

test("admitted provider outcomes persist device attempts and tokens in bounded set-based writes", async () => {
  const writes = [];
  const prisma = {
    $transaction: async (work) => work({
      $executeRawUnsafe: async (sql, payload) => {
        writes.push({ sql, rows: JSON.parse(payload) });
        return JSON.parse(payload).length;
      },
    }),
  };
  const at = "2026-08-30T19:00:00.000Z";
  const outcomes = [0, 1, 2].map((index) => ({
    attemptMutation: {
      id: `attempt-${index}`,
      outbox_id: `outbox-${index}`,
      lease_token: `lease-${index}`,
      disposition: "ACCEPTED",
      attempt_increment: 1,
      replace_error: true,
      last_error_code: null,
      accepted_at: at,
      next_attempt_at: null,
      provider_message_id: `message-${index}`,
      provider_environment: "production",
      provider_responded_at: at,
      first_attempted_at: at,
    },
    tokenMutation: {
      id: `token-${index}`,
      outbox_id: `outbox-${index}`,
      attempt_id: `attempt-${index}`,
      lease_token: `lease-${index}`,
      ownership_generation: 1,
      accepted_at: at,
      provider_environment: "production",
      invalidate: false,
      mutated_at: at,
    },
  }));

  const updated = await persistAdmittedAttemptResults(prisma, outcomes);

  assert.deepEqual(updated, {
    attemptedAttempts: 3,
    updatedAttempts: 3,
    attemptedTokens: 3,
    updatedTokens: 3,
    leaseLost: false,
  });
  assert.equal(writes.length, 2, "one attempt batch plus one token batch");
  assert.match(writes[0].sql, /jsonb_to_recordset/);
  assert.match(writes[1].sql, /jsonb_to_recordset/);
  assert.match(writes[0].sql, /ADMISSION_LEASED/);
  assert.match(writes[0].sql, /lease_token=input\.lease_token/);
  assert.match(writes[0].sql, /outbox\.id=input\.outbox_id/);
  assert.match(writes[1].sql, /ADMISSION_LEASED/);
  assert.match(writes[1].sql, /lease_token=input\.lease_token/);
  assert.match(writes[1].sql, /attempt\.id=input\.attempt_id/);
  assert.equal(writes[0].rows.length, outcomes.length);
  assert.equal(writes[1].rows.length, outcomes.length);
});

test("an admitted recipient page finalizes in a bounded number of database writes", async () => {
  const writes = [];
  const execute = async (sql, payload) => {
    const rows = JSON.parse(payload);
    writes.push({ sql, rows });
    if (/RETURNING outbox\.id/.test(sql)) {
      return rows.map((row) => ({ id: row.outbox_id, status: "DELIVERED" }));
    }
    return rows.length;
  };
  const prisma = {
    $transaction: async (work) => work({
      $executeRawUnsafe: execute,
      $queryRawUnsafe: execute,
    }),
  };
  const at = "2026-08-30T19:00:00.000Z";
  const page = [0, 1, 2].map((index) => ({
    row: {
      id: `outbox-${index}`,
      leaseToken: `lease-${index}`,
      acceptedTokens: [],
    },
    outcomes: [{
      accepted: true,
      attemptMutation: {
        id: `attempt-${index}`, outbox_id: `outbox-${index}`,
        lease_token: `lease-${index}`, disposition: "ACCEPTED",
        attempt_increment: 1, replace_error: true, last_error_code: null,
        accepted_at: at, next_attempt_at: null,
        provider_message_id: `message-${index}`,
        provider_environment: "production", provider_responded_at: at,
        first_attempted_at: at,
      },
      tokenMutation: {
        id: `token-${index}`, outbox_id: `outbox-${index}`,
        attempt_id: `attempt-${index}`, lease_token: `lease-${index}`,
        ownership_generation: 1, accepted_at: at,
        provider_environment: "production", invalidate: false, mutated_at: at,
      },
    }],
    acceptedTokens: [`fingerprint-${index}`],
    providerAccepted: true,
    attributionDeliveryId: null,
    attributionAccepted: false,
  }));

  const result = await persistAdmittedPageResults(prisma, page, new Date(at));

  assert.equal(writes.length, 3, "attempts, tokens, and outboxes are each written once per page");
  assert.equal(writes[0].rows.length, 3);
  assert.equal(writes[1].rows.length, 3);
  assert.equal(writes[2].rows.length, 3);
  assert.deepEqual(result, { delivered: 3, retried: 0, leaseLost: 0 });
  assert.match(writes[2].sql, /jsonb_to_recordset/);
  assert.match(writes[2].sql, /ADMISSION_RETRY/);
  assert.match(writes[2].sql, /DELIVERED/);
});
