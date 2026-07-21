const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateDisplayName,
  stripInternalSpaces,
  normalizeToCharset,
  DISPLAY_NAME_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
} = require("../../src/shared/lib/displayNameValidator");

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

// --- charset rule -----------------------------------------------------------

const CHARSET_ERROR =
  "Display name can only contain letters, numbers, and underscores";

test("accepts a name containing underscores", () => {
  const result = validateDisplayName("Trail_Walker_99");
  assert.equal(result.isValid, true);
  assert.equal(result.normalized, "Trail_Walker_99");
});

test("rejects a name containing a hyphen", () => {
  const result = validateDisplayName("Mary-Jane");
  assert.equal(result.isValid, false);
  assert.equal(result.error, CHARSET_ERROR);
});

test("rejects a name containing a period", () => {
  const result = validateDisplayName("Mr.Walker");
  assert.equal(result.isValid, false);
  assert.equal(result.error, CHARSET_ERROR);
});

test("rejects a name containing an accented character", () => {
  const result = validateDisplayName("José");
  assert.equal(result.isValid, false);
  assert.equal(result.error, CHARSET_ERROR);
});

test("rejects a name containing emoji", () => {
  const result = validateDisplayName("Walker🌟");
  assert.equal(result.isValid, false);
  assert.equal(result.error, CHARSET_ERROR);
});

test("space message wins over charset message (space + other punctuation)", () => {
  // Contains both a space and a hyphen — the more specific space message wins.
  const result = validateDisplayName("Mary -Jane");
  assert.equal(result.isValid, false);
  assert.equal(result.error, "Display name cannot contain spaces");
});

test("charset is checked before length (charset message wins on short bad name)", () => {
  // "a-b" is too short AND has a disallowed char — charset message wins.
  const result = validateDisplayName("a-b");
  assert.equal(result.isValid, false);
  assert.equal(result.error, CHARSET_ERROR);
});

test("normalizeToCharset transliterates accents to ASCII", () => {
  assert.equal(normalizeToCharset("José"), "Jose");
  assert.equal(normalizeToCharset("José García"), "JoseGarcia");
  assert.equal(normalizeToCharset("Renée"), "Renee");
});

test("normalizeToCharset strips punctuation and whitespace", () => {
  assert.equal(normalizeToCharset("Mary-Jane"), "MaryJane");
  assert.equal(normalizeToCharset("Mr.Walker"), "MrWalker");
  assert.equal(normalizeToCharset("John Smith"), "JohnSmith");
  assert.equal(normalizeToCharset("a.b_c"), "ab_c");
});

test("normalizeToCharset keeps letters, numbers, and underscores", () => {
  assert.equal(normalizeToCharset("Trail_Walker_99"), "Trail_Walker_99");
});

test("normalizeToCharset strips emoji", () => {
  assert.equal(normalizeToCharset("Walker🌟99"), "Walker99");
});

test("normalizeToCharset can produce a short or empty result (caller grandfathers)", () => {
  // Emoji-only / punctuation-only names normalize to empty; the migration
  // grandfathers anything under the minimum length rather than writing it.
  assert.equal(normalizeToCharset("🌟🌟"), "");
  assert.equal(normalizeToCharset("J.D."), "JD");
  assert.ok(normalizeToCharset("J.D.").length < DISPLAY_NAME_MIN_LENGTH);
});
