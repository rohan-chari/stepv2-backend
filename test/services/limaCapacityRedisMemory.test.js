const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("capacity Redis reserves process overhead without changing its 100MB data limit", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../scripts/lima-capacity.js"),
    "utf8",
  );

  assert.match(source, /--memory=256m/);
  assert.match(source, /--maxmemory 100mb/);
  assert.match(source, /--maxmemory-policy allkeys-lru/);
});
