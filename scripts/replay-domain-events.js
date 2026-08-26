#!/usr/bin/env node

require("dotenv").config();

const { buildReplayDomainEvent } = require("../src/modules/domainEvents/commands/replayDomainEvent");
const { prisma } = require("../src/db");

function valuesFor(flag, argv = process.argv.slice(2)) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) values.push(argv[++index]);
  }
  return values;
}

async function main() {
  const eventIds = valuesFor("--event");
  const projectionIds = valuesFor("--projection");
  if (eventIds.length === 0 && projectionIds.length === 0) {
    throw new Error("Usage: replay-domain-events.js [--event UUID] [--projection UUID]");
  }
  const replay = buildReplayDomainEvent({ prisma });
  const result = await replay({ eventIds, projectionIds });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
