const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateDisplayName,
  stripInternalSpaces,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
} = require("../../src/lib/displayNameValidator");

test("exports the locked min/max lengths", () => {
  assert.equal(DISPLAY_NAME_MIN_LENGTH, 4);
  assert.equal(DISPLAY_NAME_MAX_LENGTH, 30);
});

test("accepts a valid name", () => {
  const result = validateDisplayName("TrailWalker");
  assert.equal(result.isValid, true);
  assert.equal(result.normalized, "TrailWalker");
  assert.equal(result.error, undefined);
});

test("accepts a name exactly at the minimum length", () => {
  const result = validateDisplayName("abcd");
  assert.equal(result.isValid, true);
  assert.equal(result.normalized, "abcd");
});

test("accepts a name exactly at the maximum length", () => {
  const name = "a".repeat(30);
  const result = validateDisplayName(name);
  assert.equal(result.isValid, true);
  assert.equal(result.normalized, name);
});

test("rejects a name shorter than the minimum", () => {
  const result = validateDisplayName("abc");
  assert.equal(result.isValid, false);
  assert.match(result.error, /at least 4 characters/);
});

test("rejects a name longer than the maximum", () => {
  const result = validateDisplayName("a".repeat(31));
  assert.equal(result.isValid, false);
  assert.match(result.error, /no more than 30 characters/);
});

test("rejects a name with internal spaces", () => {
  const result = validateDisplayName("Trail Walker");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name cannot contain spaces");
});

test("rejects a name with internal tabs/newlines", () => {
  const result = validateDisplayName("Trail\tWalker");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name cannot contain spaces");
});

test("trims leading/trailing whitespace and accepts the result", () => {
  const result = validateDisplayName("  TrailWalker  ");
  assert.equal(result.isValid, true);
  assert.equal(result.normalized, "TrailWalker");
});

test("rejects an empty string", () => {
  const result = validateDisplayName("");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name must be a non-empty string or null");
});

test("rejects a whitespace-only string", () => {
  const result = validateDisplayName("    ");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name must be a non-empty string or null");
});

test("rejects profanity", () => {
  const result = validateDisplayName("asshole");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name contains inappropriate language");
});

test("rejects a non-string input", () => {
  for (const value of [123, null, undefined, {}, []]) {
    const result = validateDisplayName(value);
    assert.equal(result.isValid, false, `expected invalid for ${JSON.stringify(value)}`);
    assert.equal(result.error, "Display name must be a non-empty string or null");
  }
});

test("spaces are checked before length (specific message wins)", () => {
  // "a b" is too short AND has a space — the space message should win.
  const result = validateDisplayName("a b");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name cannot contain spaces");
});

test("stripInternalSpaces removes all whitespace", () => {
  assert.equal(stripInternalSpaces("John Smith"), "JohnSmith");
  assert.equal(stripInternalSpaces("  a  b  c  "), "abc");
  assert.equal(stripInternalSpaces("John\tSmith\nJr"), "JohnSmithJr");
  assert.equal(stripInternalSpaces("NoSpaces"), "NoSpaces");
});
