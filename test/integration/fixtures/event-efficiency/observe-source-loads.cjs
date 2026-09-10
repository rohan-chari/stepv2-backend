// Observation plus deterministic driver latency; scoring and persistence use
// the unmodified production worker entrypoint and the real disposable DB.
const path = require("node:path");
const root = process.env.EVENT_EFFICIENCY_CODE_ROOT || path.resolve(__dirname, "../../../..");
const { Client } = require(path.join(root, "node_modules/pg"));
const original = Client.prototype.query;
Client.prototype.query = function (...args) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
  const source = /JOIN step_samples sample/.test(sql);
  if (source) process.send?.({ kind: "source-start" });
  if (source && typeof args[args.length - 1] === "function") {
    const callback = args[args.length - 1];
    args[args.length - 1] = (...values) => setTimeout(() => callback(...values), 500);
    return original.apply(this, args);
  }
  const result = original.apply(this, args);
  if (source && result?.then) return result.then(async value => {
    await new Promise(resolve => setTimeout(resolve, 500));
    return value;
  });
  return result;
};
const { prisma } = require(path.join(root, "src/db"));
prisma.$on("query", event => process.send?.({ kind: "query", query: event.query, params: event.params }));
