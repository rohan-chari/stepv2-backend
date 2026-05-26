// One-time migration: normalize existing display names to the allowed charset.
//
// The display-name rules now reject any name containing characters outside
// [A-Za-z0-9_]. Existing users may have names with spaces ("John Smith"),
// accents ("José"), hyphens ("Mary-Jane"), periods, emoji, etc. from before the
// rule. This script transliterates accents and strips disallowed characters
// ("JohnSmith", "Jose", "MaryJane") and, when the normalized name collides
// case-insensitively with another user, appends a numeric suffix
// ("JohnSmith2", "JohnSmith3", ...).
//
// Grandfathering: we ONLY touch names that do NOT match ^[A-Za-z0-9_]+$. Names
// whose normalized result would be shorter than the 4-char minimum are left
// untouched on purpose (don't break them). Profane-but-charset-valid names are
// also left alone.
//
// Run once on deploy (NOT a prisma schema migration):
//   node scripts/migrate-display-names.js
//
// It is idempotent + safe to re-run: a second run finds no out-of-charset names
// and changes nothing. (An earlier run already handled whitespace-only names.)
require("dotenv").config();
const { prisma } = require("../src/db");
const {
  normalizeToCharset,
  DISPLAY_NAME_MIN_LENGTH,
} = require("../src/lib/displayNameValidator");

// Build a set of all existing display names (lowercased) so we can detect
// collisions without hammering the DB per candidate.
function buildTakenSet(users) {
  const taken = new Set();
  for (const u of users) {
    if (typeof u.displayName === "string" && u.displayName.length > 0) {
      taken.add(u.displayName.toLowerCase());
    }
  }
  return taken;
}

// Given a stripped base, find a name that doesn't collide with `taken`.
// `selfLower` is the user's own current name so they don't collide with self.
function resolveUnique(base, taken, selfLower) {
  const baseLower = base.toLowerCase();
  if (baseLower === selfLower || !taken.has(baseLower)) {
    return base;
  }
  let suffix = 2;
  // JohnSmith -> JohnSmith2 -> JohnSmith3 ...
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
    suffix += 1;
  }
}

async function migrate() {
  const users = await prisma.user.findMany({
    select: { id: true, displayName: true },
  });

  const taken = buildTakenSet(users);
  const charset = /^[A-Za-z0-9_]+$/;

  let changed = 0;
  let unchanged = 0;

  for (const user of users) {
    const current = user.displayName;
    if (typeof current !== "string" || charset.test(current)) {
      unchanged += 1;
      continue;
    }

    const selfLower = current.toLowerCase();
    const normalized = normalizeToCharset(current);

    // Grandfather names that normalize to fewer than the minimum chars
    // (incl. names that were entirely disallowed characters, e.g. emoji-only
    // or whitespace-only). Don't break them by writing a too-short/empty name.
    if (normalized.length < DISPLAY_NAME_MIN_LENGTH) {
      console.warn(
        `[skip] user ${user.id}: "${current}" normalizes to "${normalized}" (<${DISPLAY_NAME_MIN_LENGTH} chars); leaving unchanged`
      );
      unchanged += 1;
      continue;
    }

    const resolved = resolveUnique(normalized, taken, selfLower);

    await prisma.user.update({
      where: { id: user.id },
      data: { displayName: resolved },
    });

    // Keep the taken-set in sync so later users in this run avoid the new name.
    taken.delete(selfLower);
    taken.add(resolved.toLowerCase());

    console.log(`[update] user ${user.id}: "${current}" -> "${resolved}"`);
    changed += 1;
  }

  console.log(
    `\nDone. ${changed} display name(s) updated, ${unchanged} unchanged.`
  );
}

migrate()
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
