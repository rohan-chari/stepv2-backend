const crypto = require("crypto");

function hasCompactCapability(clientFeatures) {
  return clientFeatures?.has("api_payload_compact_v1") === true;
}

function compactRaceList(legacy) {
  const result = { ...legacy, contract: "race-list-compact-v1" };
  for (const bucket of ["active", "pending", "completed"]) {
    if (!Array.isArray(legacy?.[bucket])) continue;
    result[bucket] = legacy[bucket].map((row) => {
      const compact = { ...row };
      delete compact.targetSteps;
      delete compact.leader;
      if (compact.payoutTiers != null) delete compact.payouts;
      if (Array.isArray(compact.slotItems)) delete compact.mysteryBoxCount;
      if (compact.teams != null) {
        delete compact.teamATotalSteps;
        delete compact.teamBTotalSteps;
      }
      if (compact.creator && typeof compact.creator === "object") {
        compact.creator = { ...compact.creator };
        delete compact.creator.profilePhotoUrl;
      }
      if (compact.winner && typeof compact.winner === "object") {
        compact.winner = { ...compact.winner };
        delete compact.winner.profilePhotoUrl;
      }
      return compact;
    });
  }
  return result;
}

function compactLeaderboard(legacy) {
  const top100 = Array.isArray(legacy?.top100) ? legacy.top100 : [];
  const currentUser = legacy?.currentUser;
  const inTop100 = currentUser?.inTop100 === true ||
    (currentUser && top100.some((row) =>
      row?.userId != null && row.userId === currentUser.userId));
  return {
    contract: "leaderboard-compact-v1",
    top100,
    currentUser: inTop100 ? null : (currentUser ?? null),
  };
}

function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortJsonKeys(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  // The JSON round-trip applies Date.toJSON and the same undefined/object
  // omission semantics as Express before recursively sorting object keys.
  return JSON.stringify(sortJsonKeys(JSON.parse(JSON.stringify(value))));
}

function messageStreamsRevision(legacyBody) {
  return crypto.createHash("sha256").update(canonicalJson(legacyBody), "utf8").digest("hex");
}

function quotedEtag(revision) {
  return `"${revision}"`;
}

module.exports = {
  canonicalJson,
  compactLeaderboard,
  compactRaceList,
  hasCompactCapability,
  messageStreamsRevision,
  quotedEtag,
};
