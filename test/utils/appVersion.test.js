const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseVersion,
  compareVersions,
  evaluateVersionGate,
} = require("../../src/utils/appVersion");

test("parseVersion parses dotted numeric versions", () => {
  assert.deepEqual(parseVersion("1.4.2"), [1, 4, 2]);
  assert.deepEqual(parseVersion("1.4"), [1, 4]);
  assert.deepEqual(parseVersion("2"), [2]);
});

test("parseVersion strips build/pre-release suffixes", () => {
  assert.deepEqual(parseVersion("1.4.2+45"), [1, 4, 2]);
  assert.deepEqual(parseVersion("1.4.2-beta.1"), [1, 4, 2]);
});

test("parseVersion returns null for unusable input", () => {
  assert.equal(parseVersion("unknown"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion("abc"), null);
});

test("compareVersions orders by numeric segments", () => {
  assert.equal(compareVersions("1.4.0", "1.4.1"), -1);
  assert.equal(compareVersions("1.4.1", "1.4.0"), 1);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
});

test("compareVersions treats missing trailing segments as zero", () => {
  assert.equal(compareVersions("1.4", "1.4.0"), 0);
  assert.equal(compareVersions("1.4.1", "1.4"), 1);
});

test("compareVersions compares numerically, not lexically", () => {
  assert.equal(compareVersions("1.4.10", "1.4.9"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
});

test("compareVersions returns null when either side is unparseable", () => {
  assert.equal(compareVersions("unknown", "1.4.0"), null);
  assert.equal(compareVersions("1.4.0", ""), null);
});

test("evaluateVersionGate flags a required update below the floor", () => {
  const result = evaluateVersionGate({
    appVersion: "1.3.6",
    minSupportedVersion: "1.4.0",
    latestVersion: "1.4.2",
  });
  assert.deepEqual(result, { updateRequired: true, updateAvailable: true });
});

test("evaluateVersionGate flags only an optional update between floor and latest", () => {
  const result = evaluateVersionGate({
    appVersion: "1.4.0",
    minSupportedVersion: "1.4.0",
    latestVersion: "1.4.2",
  });
  assert.deepEqual(result, { updateRequired: false, updateAvailable: true });
});

test("evaluateVersionGate clears both when on the latest version", () => {
  const result = evaluateVersionGate({
    appVersion: "1.4.2",
    minSupportedVersion: "1.4.0",
    latestVersion: "1.4.2",
  });
  assert.deepEqual(result, { updateRequired: false, updateAvailable: false });
});

test("evaluateVersionGate fails open when the app version is unknown", () => {
  // A missing/garbled X-App-Version header must never lock a user out.
  const result = evaluateVersionGate({
    appVersion: "unknown",
    minSupportedVersion: "1.4.0",
    latestVersion: "1.4.2",
  });
  assert.deepEqual(result, { updateRequired: false, updateAvailable: false });
});

test("evaluateVersionGate fails open when the floor is unset/garbled", () => {
  const result = evaluateVersionGate({
    appVersion: "1.0.0",
    minSupportedVersion: "",
    latestVersion: "",
  });
  assert.deepEqual(result, { updateRequired: false, updateAvailable: false });
});

test("evaluateVersionGate treats the floor as inclusive", () => {
  // Being exactly on the floor is supported, not blocked.
  const result = evaluateVersionGate({
    appVersion: "1.4.0",
    minSupportedVersion: "1.4.0",
    latestVersion: "1.4.0",
  });
  assert.equal(result.updateRequired, false);
});
