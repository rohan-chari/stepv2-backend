const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const srcRoot = path.join(__dirname, "../../src/modules");

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.name.endsWith(".js") ? [target] : [];
  });
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

it("keeps every production outbox writer behind the shared receipt-aware repository", () => {
  const directWriters = javascriptFiles(srcRoot).filter((file) =>
    /INSERT\s+INTO\s+domain_event_outbox/i.test(withoutComments(fs.readFileSync(file, "utf8"))));
  assert.deepEqual(directWriters.map((file) => path.relative(srcRoot, file)), [
    "domainEvents/models/domainEventOutbox.js",
  ]);
  for (const file of [
    "steps/services/globalStepEventEntitlement.js",
    "steps/services/globalEventTimezoneReconciliation.js",
  ]) {
    const source = fs.readFileSync(path.join(srcRoot, file), "utf8");
    assert.match(source, /bulkAppendDomainEvents/);
  }
});

it("inventories Prisma writers as well as raw SQL, including the verified entitlement restoration path", () => {
  const writers = javascriptFiles(srcRoot).filter((file) =>
    /domainEventOutbox\.(?:create|createMany|upsert)\s*\(/.test(withoutComments(fs.readFileSync(file, "utf8"))));
  assert.deepEqual(writers.map((file) => path.relative(srcRoot, file)), [
    "domainEvents/models/domainEventOutbox.js",
    "steps/services/globalStepEventEntitlement.js",
  ]);
  // The entitlement exception restores the original receipt UUID, then enters
  // bulkAppendDomainEvents in the same transaction to verify the full envelope.
  // Its rollback, collision and receipt-only semantics are integration-tested.
  const restore = fs.readFileSync(path.join(srcRoot, "steps/services/globalStepEventEntitlement.js"), "utf8");
  assert.match(restore, /bulkAppendDomainEvents\(tx,/);
});
