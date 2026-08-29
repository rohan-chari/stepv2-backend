#!/usr/bin/env node
process.env.DOTENV_CONFIG_QUIET = "true";

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    confirmation: argv
      .find((value) => value.startsWith("--confirm="))
      ?.slice("--confirm=".length),
    reportDigest: argv
      .find((value) => value.startsWith("--report-digest="))
      ?.slice("--report-digest=".length),
  };
}

async function main(argv = process.argv.slice(2)) {
  const {
    buildDuplicateLeechRepair,
  } = require("../src/modules/powerups/services/duplicateLeechRepair");
  const options = parseArgs(argv);
  const repair = buildDuplicateLeechRepair();
  const result = options.apply
    ? await repair.apply(options)
    : await repair.audit();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { main, parseArgs };
