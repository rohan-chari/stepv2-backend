// Structural guard for the C5 coin-invalidation seam
// (docs/redis-derived-data-layer-requirements.md §9, last acceptance box:
// "`awardCoins` and `deductCoinsAtomic` remain the only direct `users.coins`
// mutation sites (guard: a structural grep test over `src/` asserting no other
// `coins: { increment | decrement }` or raw-SQL coin write exists)").
//
// Why this is a UNIT test and not an integration test (CLAUDE.md's default is
// integration): the property is "no THIRD write site exists anywhere in src/".
// That is a statement about the source tree, not about any request. No
// end-to-end test can express it — passing every endpoint proves nothing about
// a site nobody exercised. CLAUDE.md names exactly this shape as the legitimate
// unit case: "Structural guards over source (for example, asserting every
// scoring-assembly site inserts a required term)."
//
// The stake: `/auth/me` is cached for 10s and its coin balance is the single
// most read-back-after-write field in the app (15 wallet refresh sites). Both
// sanctioned seams DELETE the cache. A third site would mint or burn coins
// invisibly to the cache and the user would see a stale balance for up to 10s
// with no way to force a refresh.
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "src");

const SANCTIONED = new Set([
  path.join("shared", "economy", "awardCoins.js"),
  path.join("shared", "economy", "deductCoinsAtomic.js"),
]);

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Prisma atomic-number ops on the `coins` column, whitespace-tolerant:
//   coins: { increment: n }   coins:{decrement:n}   coins : { multiply: … }
const PRISMA_COIN_OP =
  /\bcoins\s*:\s*\{\s*(increment|decrement|multiply|divide|set)\s*:/;

// Raw SQL touching the coins column of the users table. Deliberately broad:
// any UPDATE that names `coins` in a SET clause, in either the snake_case
// column form or a quoted identifier.
const RAW_SQL_COIN_WRITE = /update\s+"?users"?[\s\S]{0,400}?\bset\b[\s\S]{0,200}?\bcoins\b/i;

describe("C5 coin seam — structural guard", () => {
  const files = jsFiles(SRC);

  it("finds a non-trivial source tree (guard against a broken walker)", () => {
    assert.ok(
      files.length > 100,
      `expected to scan the whole src/ tree, saw ${files.length} files`
    );
  });

  it("both sanctioned seams still exist and still write coins", () => {
    for (const rel of SANCTIONED) {
      const source = fs.readFileSync(path.join(SRC, rel), "utf8");
      assert.match(
        source,
        PRISMA_COIN_OP,
        `${rel} no longer performs a users.coins write — the seam moved; ` +
          `update this guard AND the /auth/me invalidation hook together`
      );
    }
  });

  it("no THIRD site mutates users.coins", () => {
    const offenders = [];
    for (const file of files) {
      const rel = path.relative(SRC, file);
      if (SANCTIONED.has(rel)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (PRISMA_COIN_OP.test(source)) offenders.push(`${rel} (prisma coin op)`);
      if (RAW_SQL_COIN_WRITE.test(source)) offenders.push(`${rel} (raw SQL)`);
    }
    assert.deepEqual(
      offenders,
      [],
      "users.coins may only be written by awardCoins.js / deductCoinsAtomic.js — " +
        "those are the two sites that invalidate the 10s /auth/me cache. " +
        "Route the new write through them (see docs/redis-derived-data-layer-requirements.md §9)."
    );
  });

  it("both seams invalidate the /auth/me cache", () => {
    for (const rel of SANCTIONED) {
      const source = fs.readFileSync(path.join(SRC, rel), "utf8");
      assert.match(
        source,
        /authMeCache/,
        `${rel} must invalidate v1:user:{id}:authme after mutating the balance`
      );
    }
  });
});
