#!/usr/bin/env node

const {
  extractCapacityTelemetryEvidence,
} = require("../src/shared/observability/capacityTelemetryEvidence");

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const entries = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`invalid JSON on input line ${index + 1}`);
        }
      });
    const evidence = extractCapacityTelemetryEvidence(entries, {
      runId: argument("--run-id"),
      repeat: argument("--repeat"),
    });
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
});
