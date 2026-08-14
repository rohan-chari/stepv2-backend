// Structural because the property is absence of an unguarded writer anywhere
// in the source tree; no one HTTP flow can prove that negative.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("every friendship mutation seam names topology invalidation after commit", () => {
  for (const file of [
    "src/modules/social/models/friendship.js",
    "src/modules/social/commands/sendFriendRequest.js",
    "src/modules/social/commands/respondToFriendRequest.js",
    "src/modules/social/commands/removeFriend.js",
    "src/modules/social/commands/recordReferral.js",
    "src/modules/social/commands/redeemReferralCode.js",
    "src/modules/races/commands/joinRaceByShareToken.js",
    "src/modules/users/commands/deleteUserAccount.js",
  ]) {
    assert.match(
      read(file),
      /friendsTopologyCache|invalidateTopologyPair/,
      `${file} must invalidate raw topology`
    );
  }
});

test("presentation-mutating seams name presentation invalidation", () => {
  for (const file of [
    "src/modules/users/commands/setDisplayName.js",
    "src/modules/users/commands/profilePhoto.js",
    "src/modules/users/models/user.js",
    "src/modules/cosmetics/equipAccessory.js",
    "src/modules/users/commands/setLeaderboardVisibility.js",
    "src/modules/users/commands/deleteUserAccount.js",
  ]) {
    assert.match(
      read(file),
      /userPresentationCache|presentation\.invalidate/,
      `${file} must invalidate presentation`
    );
  }
});

test("existing-user review eligibility has no unguarded production writer", () => {
  const sourceFiles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) sourceFiles.push(full);
    }
  }
  walk(path.join(ROOT, "src"));
  const writers = sourceFiles.filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return /(?:data|fields):\s*\{[^}]*isReviewAccount\s*:/s.test(source);
  });
  assert.deepEqual(
    writers.map((file) => path.relative(ROOT, file)),
    [],
    "new-account creation may accept isReviewAccount, but no existing-user writer may bypass the epoch seam"
  );
});
