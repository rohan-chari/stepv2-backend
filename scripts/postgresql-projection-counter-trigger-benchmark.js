#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { prisma } = require("../src/db");

function parseArgs(argv) {
  return Object.fromEntries(argv.flatMap((value, index) =>
    value.startsWith("--") ? [[value.slice(2), argv[index + 1]]] : []));
}

function assertSafeDatabase(raw) {
  const url = new URL(raw);
  const database = url.pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      !/(?:_test|_capacity)$/.test(database)) {
    throw new Error("benchmark requires a local *_test or *_capacity database");
  }
  return { host: url.hostname, database };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("--output is required");
  if (fs.existsSync(args.output)) throw new Error("output already exists");
  const target = assertSafeDatabase(process.env.DATABASE_URL || "");
  const runId = crypto.randomUUID();
  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { appleId: `trigger-benchmark-${runId}` } });
      const event = await tx.domainEventOutbox.create({ data: {
        eventKey: `trigger-benchmark:${runId}`, eventType: "FRIEND_REQUEST_SENT_V1",
        schemaVersion: 1, aggregateType: "BENCHMARK", aggregateId: runId,
        payload: {}, occurredAt: new Date(), availableAt: new Date(),
        projectionCount: 0, terminalProjectionCount: 0, failedProjectionCount: 0,
        projectionCountsValidAt: new Date(),
      } });
      const projection = await tx.domainEventNotificationProjection.create({ data: {
        domainEventId: event.id, recipientUserId: user.id,
        deliveryKey: `trigger-benchmark:${runId}`, projectionKind: "VISIBLE",
        status: "PENDING", availableAt: new Date(),
      } });
      const before = await tx.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
      const noDeltaPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
         UPDATE domain_event_notification_projections
            SET updated_at=updated_at WHERE id=$1::uuid`,
        projection.id,
      );
      const afterNoDelta = await tx.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
      const deltaPlan = await tx.$queryRawUnsafe(
        `EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
         UPDATE domain_event_notification_projections
            SET status='COMPLETED',updated_at=CURRENT_TIMESTAMP WHERE id=$1::uuid`,
        projection.id,
      );
      const afterDelta = await tx.domainEventOutbox.findUniqueOrThrow({ where: { id: event.id } });
      if (afterNoDelta.updatedAt.getTime() !== before.updatedAt.getTime() ||
          afterNoDelta.terminalProjectionCount !== before.terminalProjectionCount) {
        throw new Error("no-delta trigger path wrote the parent row");
      }
      if (afterDelta.terminalProjectionCount !== before.terminalProjectionCount + 1) {
        throw new Error("terminal delta did not update the parent counter");
      }
      const plan = (rows) => rows[0]["QUERY PLAN"][0];
      const evidence = {
        noDelta: {
          executionTimeMs: plan(noDeltaPlan)["Execution Time"],
          planningTimeMs: plan(noDeltaPlan)["Planning Time"],
          plan: plan(noDeltaPlan).Plan,
          parentWriteObserved: false,
        },
        delta: {
          executionTimeMs: plan(deltaPlan)["Execution Time"],
          planningTimeMs: plan(deltaPlan)["Planning Time"],
          plan: plan(deltaPlan).Plan,
          parentTerminalCounterDelta: 1,
        },
      };
      await tx.domainEventNotificationProjection.delete({ where: { id: projection.id } });
      await tx.domainEventOutbox.delete({ where: { id: event.id } });
      await tx.user.delete({ where: { id: user.id } });
      return evidence;
    });
    const artifact = {
      schema: "postgresql-projection-counter-trigger-benchmark-v1",
      capturedAt: new Date().toISOString(), target, fixtureRemoved: true,
      ...result,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(args.output, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
