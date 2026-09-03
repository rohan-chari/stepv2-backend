const crypto = require("node:crypto");
const { assertFixtureDatabase } = require("./fixtures");
const {
  cleanupHomeOpenFixtures,
  createHomeOpenFixtures,
} = require("./homeOpenFixtures");
const {
  PROJECTION_VERSION,
  REQUIRED_COVERAGE_VARIANTS,
  projectRacesTabPayload,
} = require("./racesTabOpenProjection");
const { buildAppSettings } = require("../../shared/config/appSettings");

const PINNED_SETTINGS = Object.freeze([
  ["apiRaceListCompactV1Enabled", true],
  ["redisCacheRaceListEnabled", true],
  ["raceListSqlSummaryV1Enabled", true],
]);

async function pinRacesTabSettings({ prisma, settings = buildAppSettings({ prisma }) } = {}) {
  const prior = [];
  for (const [key] of PINNED_SETTINGS) {
    const state = await settings.getRawFlagState(key);
    if (state.available !== true) throw new Error(`Races-tab setting ${key} is unavailable`);
    prior.push({ key, present: state.present === true, value: state.value });
  }
  await settings.setFlagsAtomically(PINNED_SETTINGS);
  return { schema: "races-tab-pinned-settings-v1", intended: Object.fromEntries(PINNED_SETTINGS),
    prior, restored: false };
}

async function restoreRacesTabSettings({ prisma, evidence,
  settings = buildAppSettings({ prisma }) } = {}) {
  if (evidence?.schema !== "races-tab-pinned-settings-v1") return null;
  await settings.setFlagsAtomically(evidence.prior.map((row) => [row.key,
    row.present ? row.value : false]));
  const absent = evidence.prior.filter((row) => !row.present).map((row) => row.key);
  if (absent.length) await prisma.appSetting.deleteMany({ where: { key: { in: absent } } });
  settings.bustCache();
  evidence.restored = true;
  return evidence;
}

function buildCoverageAssignments({ users, prefixSize = 300,
  requiredVariants = REQUIRED_COVERAGE_VARIANTS,
  maximumAugmentationShare = 0.1, sourceCensus = null } = {}) {
  if (!Number.isInteger(users) || users < prefixSize || prefixSize < requiredVariants.length) {
    throw new Error(`Races-tab v2 requires at least ${prefixSize} fixture identities`);
  }
  const byUser = Array.from({ length: users }, () => []);
  const rowTargetsByUser = Array.from({ length: users }, () => ({
    classicActive: 0, teamActive: 0, pendingOwner: 0, pendingAccepted: 0,
    completed: 0, invited: 0,
    tournamentInvited: 0, tournamentPending: 0, tournamentActive: 0,
    tournamentCompleted: 0,
  }));
  const sourceUsers = Math.max(1, Number(sourceCensus?.counts?.userCount || users));
  const naturalCounts = {};
  const jointMappedVariants = new Set();
  const sourceProfiles = sourceCensus?.jointHistogram || [];
  const sourceProfileTotal = sourceProfiles.reduce((sum, entry) => sum + Number(entry.users || 0), 0);
  if (sourceProfiles.length && sourceProfileTotal !== sourceUsers) {
    throw new Error("Races-tab source joint profiles must account for every source user exactly once");
  }
  const scaledProfiles = sourceProfiles.map((entry, index) => {
    const exact = users * Number(entry.users) / sourceProfileTotal;
    return { entry, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = users - scaledProfiles.reduce((sum, row) => sum + row.count, 0);
  for (const profile of [...scaledProfiles].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index)) {
    if (unassigned <= 0) break;
    profile.count += 1; unassigned -= 1;
  }
  const assignedByProfile = scaledProfiles.map(() => 0);
  for (let userIndex = 0; userIndex < users && scaledProfiles.length; userIndex += 1) {
    const profile = scaledProfiles.filter((row) => assignedByProfile[row.index] < row.count)
      .sort((left, right) => {
        const leftDeficit = (userIndex + 1) * left.count / users - assignedByProfile[left.index];
        const rightDeficit = (userIndex + 1) * right.count / users - assignedByProfile[right.index];
        return rightDeficit - leftDeficit || left.index - right.index;
      })[0];
    const entry = profile.entry;
    const dimensions = entry.dimensions || {};
    const classicActive = Number(dimensions.classicActive ??
      (dimensions.team ? 0 : dimensions.active)) || 0;
    const teamActive = Number(dimensions.teamActive ??
      (dimensions.team ? dimensions.active : 0)) || 0;
    const pendingOwner = Number(dimensions.pendingOwner || 0);
    const pendingAccepted = Number(dimensions.pendingAccepted ?? dimensions.pending) || 0;
    const variants = [
      classicActive > 0 ? "ordinary_classic_active" : null,
      teamActive > 0 ? "ordinary_team_active" : null,
      pendingOwner > 0 ? "ordinary_pending_owner" : null,
      pendingAccepted > 0 ? "ordinary_pending_accepted" : null,
      Number(dimensions.completed) > 0 ? "ordinary_completed" : null,
      Number(dimensions.invited) > 0 ? "ordinary_invite" : null,
      dimensions.pinnedClassic ? "pinned_classic" : null,
      dimensions.pinnedTeam ? "pinned_team" : null,
      Number(dimensions.heldInventory) > 0 ? "ordinary_inventory_held_typed" : null,
      Number(dimensions.mysteryInventory) > 0 ? "ordinary_inventory_mystery_box" : null,
      Number(dimensions.queuedInventory) > 0 ? "ordinary_inventory_queued_box" : null,
      Number(dimensions.positiveEffects) > 0 ? "ordinary_effect_positive" : null,
      Number(dimensions.negativeEffects) > 0 ? "ordinary_effect_negative" : null,
      Number(dimensions.tournamentInvited) > 0 ? "tournament_invite" : null,
      Number(dimensions.tournamentPending) > 0 ? "tournament_lobby" : null,
      Number(dimensions.tournamentActive) > 0 ? "tournament_between_rounds" : null,
      Number(dimensions.tournamentCompleted) > 0 ? "tournament_completed_non_champion" : null,
      dimensions.tournamentPinned ? "pinned_tournament" : null,
      Number(dimensions.matchHeldInventory) > 0
        ? "tournament_match_inventory_held_typed" : null,
      Number(dimensions.matchMysteryInventory) > 0
        ? "tournament_match_inventory_mystery_box" : null,
      Number(dimensions.matchQueuedInventory) > 0
        ? "tournament_match_inventory_queued_box" : null,
      Number(dimensions.matchNegativeEffects) > 0
        ? "tournament_match_placement_hidden" : null,
    ].filter(Boolean);
    variants.forEach((variant) => jointMappedVariants.add(variant));
    const rowTargets = { classicActive, teamActive, pendingOwner, pendingAccepted,
      completed: dimensions.completed, invited: dimensions.invited,
      tournamentInvited: dimensions.tournamentInvited,
      tournamentPending: dimensions.tournamentPending,
      tournamentActive: dimensions.tournamentActive,
      tournamentCompleted: dimensions.tournamentCompleted };
    for (const [key, value] of Object.entries(rowTargets)) {
      rowTargetsByUser[userIndex][key] = Math.max(0, Number(value) || 0);
    }
    for (const variant of variants) if (!byUser[userIndex].includes(variant)) {
      byUser[userIndex].push(variant);
    }
    assignedByProfile[profile.index] += 1;
  }
  for (const [variantIndex, variant] of requiredVariants.entries()) {
    const desired = Math.min(users, Math.round(users *
      sourceCountForVariant(variant, sourceCensus?.counts) / sourceUsers));
    naturalCounts[variant] = desired;
    if (jointMappedVariants.has(variant)) continue;
    for (let ordinal = 0; ordinal < desired; ordinal += 1) {
      const index = Math.floor((ordinal + 0.5) * users / desired + variantIndex) % users;
      if (!byUser[index].includes(variant)) byUser[index].push(variant);
    }
  }
  for (const variant of requiredVariants) naturalCounts[variant] =
    byUser.filter((values) => values.includes(variant)).length;
  const augmentedIndexes = new Set();
  const augmentedByUser = Array.from({ length: users }, () => []);
  for (let index = 0; index < users; index += 1) {
    const position = index % prefixSize;
    if (position >= requiredVariants.length) continue;
    const variant = requiredVariants[position];
    if (!byUser[index].includes(variant)) {
      byUser[index].push(variant); augmentedByUser[index].push(variant);
      augmentedIndexes.add(index);
    }
  }
  const augmentedIdentities = augmentedIndexes.size;
  const augmentationShare = augmentedIdentities / users;
  if (augmentationShare > maximumAugmentationShare) {
    throw new Error("Races-tab coverage augmentation exceeds configured share");
  }
  return {
    schema: "races-tab-coverage-floor-v2",
    prefixSize,
    requiredVariants: [...requiredVariants],
    byUser,
    rowTargetsByUser,
    augmentedByUser,
    augmentedIdentities,
    augmentationShare,
    naturalCounts,
    jointHistogramApplied: jointMappedVariants.size > 0,
    policy: "periodic-ordered-prefix-v1",
  };
}

function emptyProjection({ zeroFriends = false } = {}) {
  return projectRacesTabPayload({
    core: { active: [], pending: [], completed: [], tournaments: [] },
    discovery: { publicRaceCount: 0 },
    friends: zeroFriends ? { contract: "friends-summary-v1", friends: [] } : null,
    friendsShouldRequest: zeroFriends,
  });
}

async function noOpFullPageMaterializer() {
  return { manifestIds: {}, naturallyGenerated: {}, augmented: {}, sourceZeroVariants: [] };
}

async function defaultExpectedProjection({ user }) {
  return null;
}

async function createMany(model, rows, size = 500) {
  for (let index = 0; index < rows.length; index += size) {
    await model.createMany({ data: rows.slice(index, index + size), skipDuplicates: true });
  }
}

function histogramValue(histogram, ordinal, fallback, { minimum = 1, maximum = 64 } = {}) {
  const entries = Object.entries(histogram || {}).map(([value, count]) =>
    [Number(value), Number(count)]).filter(([value, count]) => Number.isInteger(value) &&
      value >= minimum && value <= maximum && Number.isInteger(count) && count > 0)
    .sort((left, right) => left[0] - right[0]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (!total) return fallback;
  let position = ordinal % total;
  for (const [value, count] of entries) {
    if (position < count) return value;
    position -= count;
  }
  return fallback;
}

function jointGraphShape(entries, ordinal, predicate = () => true) {
  const eligible = (Array.isArray(entries) ? entries : []).filter((entry) =>
    Number.isInteger(Number(entry?.graphs)) && Number(entry.graphs) > 0 &&
    entry.dimensions && predicate(entry.dimensions));
  const total = eligible.reduce((sum, entry) => sum + Number(entry.graphs), 0);
  if (!total) return null;
  let position = ordinal % total;
  for (const entry of eligible) {
    if (position < Number(entry.graphs)) return entry.dimensions;
    position -= Number(entry.graphs);
  }
  return null;
}

function assertGraphCensus(sourceCensus) {
  if (!sourceCensus) return;
  const joint = sourceCensus.graphJointHistogram;
  if (joint != null) {
    if (!joint || !Array.isArray(joint.ordinary) || !Array.isArray(joint.tournaments)) {
      throw new Error("invalid Races-tab source graph joint histogram");
    }
    for (const [family, entries] of Object.entries(joint)) {
      for (const entry of entries) {
        const dimensions = entry?.dimensions;
        const required = family === "ordinary" || family === "matches"
          ? ["participants", "inventory", "effects"]
          : ["bracketSize", "participants", "accepted"];
        if (!Number.isInteger(Number(entry?.graphs)) || Number(entry.graphs) < 1 ||
            !dimensions || typeof dimensions.status !== "string" ||
            required.some((key) => !Number.isInteger(Number(dimensions[key])) ||
              Number(dimensions[key]) < 0)) {
          throw new Error("invalid Races-tab source graph joint histogram");
        }
      }
    }
  }
  for (const histogram of Object.values(sourceCensus.graphHistograms || {})) {
    if (!histogram || typeof histogram !== "object" || Array.isArray(histogram) ||
        Object.entries(histogram).some(([value, count]) => !Number.isInteger(Number(value)) ||
          Number(value) < 0 || !Number.isInteger(Number(count)) || Number(count) < 1)) {
      throw new Error("invalid Races-tab source graph histogram");
    }
  }
}

function groupedVariants(variants, rowTargets = {}) {
  const groups = [];
  const has = (name) => variants.includes(name);
  const addRepeated = (primary, features, count, family,
    enabled = has(primary) || features.some(has)) => {
    if (!enabled) return;
    const total = Math.max(1, Number(count) || 0);
    for (let occurrence = 0; occurrence < total; occurrence += 1) {
      groups.push({ variantGroup: occurrence === 0
        ? [primary, ...features.filter(has)] : [primary], family, occurrence });
    }
  };
  const ordinaryFeatures = ["ordinary_placement_visible",
    "ordinary_placement_hidden", "ordinary_inventory_held_typed",
    "ordinary_inventory_mystery_box", "ordinary_inventory_queued_box",
    "ordinary_effect_positive", "ordinary_effect_negative"];
  addRepeated("ordinary_classic_active", ["pinned_classic", ...ordinaryFeatures],
    rowTargets.classicActive, "ordinary_active",
    has("ordinary_classic_active") || has("pinned_classic") ||
      (!has("ordinary_team_active") && ordinaryFeatures.some(has)));
  addRepeated("ordinary_team_active", ["pinned_team", ...ordinaryFeatures],
    rowTargets.teamActive, "ordinary_active", has("ordinary_team_active") || has("pinned_team"));
  addRepeated("ordinary_pending_owner", [], rowTargets.pendingOwner, "ordinary_pending_owner");
  addRepeated("ordinary_pending_accepted", [], rowTargets.pendingAccepted,
    "ordinary_pending_accepted");
  addRepeated("ordinary_invite", [], rowTargets.invited, "ordinary_invited");
  addRepeated("ordinary_completed", [], rowTargets.completed, "ordinary_completed");
  addRepeated("tournament_invite", [], rowTargets.tournamentInvited, "tournament_invited");
  addRepeated("tournament_lobby", ["pinned_tournament"], rowTargets.tournamentPending,
    "tournament_pending");
  const activeTournament = variants.some((variant) => variant.startsWith("tournament_match_")) ||
    has("tournament_live_match") ? "tournament_live_match" :
    has("tournament_eliminated") ? "tournament_eliminated" : "tournament_between_rounds";
  addRepeated(activeTournament, ["tournament_match_placement_visible",
    "tournament_match_placement_hidden", "tournament_match_inventory_held_typed",
    "tournament_match_inventory_mystery_box", "tournament_match_inventory_queued_box"],
  rowTargets.tournamentActive, "tournament_active");
  const completedTournament = has("tournament_champion") ? "tournament_champion" :
    "tournament_completed_non_champion";
  addRepeated(completedTournament, [], rowTargets.tournamentCompleted, "tournament_completed");
  return groups;
}

function requiredGraphFeatures(variantGroup) {
  const ordinaryPositive = variantGroup.includes("ordinary_effect_positive") ? 1 : 0;
  const ordinaryNegative = variantGroup.includes("ordinary_effect_negative") ||
    variantGroup.includes("ordinary_placement_hidden") ? 1 : 0;
  const tournamentHidden = variantGroup.includes("tournament_match_placement_hidden") ? 1 : 0;
  const effects = ordinaryPositive + ordinaryNegative + tournamentHidden;
  return {
    inventory: variantGroup.filter((variant) => variant.startsWith("ordinary_inventory_") ||
      variant.startsWith("tournament_match_inventory_")).length + effects,
    effects,
  };
}

function graphShapeMatchesFeatures(dimensions, variantGroup) {
  const required = requiredGraphFeatures(variantGroup);
  return Number(dimensions.inventory || 0) >= required.inventory &&
    Number(dimensions.effects || 0) >= required.effects;
}

function scaledShapeSequence(entries, count) {
  const total = entries.reduce((sum, entry) => sum + Number(entry.graphs), 0);
  const scaled = entries.map((entry, index) => {
    const exact = count * Number(entry.graphs) / total;
    return { entry, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = count - scaled.reduce((sum, row) => sum + row.count, 0);
  for (const row of [...scaled].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index)) {
    if (unassigned <= 0) break;
    row.count += 1; unassigned -= 1;
  }
  const assigned = scaled.map(() => 0);
  return Array.from({ length: count }, (_, ordinal) => {
    const row = scaled.filter((candidate) => assigned[candidate.index] < candidate.count)
      .sort((left, right) => {
        const leftDeficit = (ordinal + 1) * left.count / count - assigned[left.index];
        const rightDeficit = (ordinal + 1) * right.count / count - assigned[right.index];
        return rightDeficit - leftDeficit || left.index - right.index;
      })[0];
    assigned[row.index] += 1;
    return row.entry.dimensions;
  });
}

function packOrdinaryGraphSlots({ slots, sourceEntries, ownerOnly, needsExternal }) {
  const orderedSlots = [...slots].sort((left, right) => {
    const leftRequired = requiredGraphFeatures(left.variantGroup);
    const rightRequired = requiredGraphFeatures(right.variantGroup);
    return rightRequired.effects - leftRequired.effects ||
      rightRequired.inventory - leftRequired.inventory || left.userIndex - right.userIndex;
  });
  const totalRequired = orderedSlots.reduce((totals, slot) => {
    const required = requiredGraphFeatures(slot.variantGroup);
    totals.inventory += required.inventory; totals.effects += required.effects;
    return totals;
  }, { inventory: 0, effects: 0 });
  for (let graphCount = 1; graphCount <= slots.length; graphCount += 1) {
    const shapes = scaledShapeSequence(sourceEntries, graphCount);
    const instances = shapes.map((shape, index) => ({ index, shape, slots: [],
      remainingUsers: ownerOnly ? 1 : Math.max(1,
        Number(shape.participants) - (needsExternal ? 1 : 0)),
      remainingInventory: Number(shape.inventory), remainingEffects: Number(shape.effects) }));
    if (instances.reduce((sum, row) => sum + row.remainingUsers, 0) < slots.length ||
        instances.reduce((sum, row) => sum + row.remainingInventory, 0) !== totalRequired.inventory ||
        instances.reduce((sum, row) => sum + row.remainingEffects, 0) !== totalRequired.effects) continue;
    let fits = true;
    for (const slot of orderedSlots) {
      const required = requiredGraphFeatures(slot.variantGroup);
      const instance = instances.filter((candidate) => candidate.remainingUsers > 0 &&
          candidate.remainingInventory >= required.inventory &&
          candidate.remainingEffects >= required.effects)
        .sort((left, right) => Number(left.slots.length > 0) - Number(right.slots.length > 0) ||
          left.remainingInventory - right.remainingInventory ||
          left.remainingEffects - right.remainingEffects || left.index - right.index)[0];
      if (!instance) { fits = false; break; }
      instance.slots.push(slot); instance.remainingUsers -= 1;
      instance.remainingInventory -= required.inventory;
      instance.remainingEffects -= required.effects;
    }
    if (fits && instances.every((instance) => instance.slots.length > 0 &&
        instance.remainingInventory === 0 && instance.remainingEffects === 0)) return instances;
  }
  throw new Error("Races-tab generated graph inventoryPerRace escaped or effectsPerRace escaped the scaled per-user ownership profile");
}

function packTournamentMatchGraphSlots({ slots, tournamentEntries, matchEntries }) {
  const orderedSlots = [...slots].sort((left, right) => {
    const leftRequired = requiredGraphFeatures(left.variantGroup);
    const rightRequired = requiredGraphFeatures(right.variantGroup);
    return rightRequired.effects - leftRequired.effects ||
      rightRequired.inventory - leftRequired.inventory || left.userIndex - right.userIndex;
  });
  const totalRequired = orderedSlots.reduce((totals, slot) => {
    const required = requiredGraphFeatures(slot.variantGroup);
    totals.inventory += required.inventory; totals.effects += required.effects;
    return totals;
  }, { inventory: 0, effects: 0 });
  for (let graphCount = 1; graphCount <= slots.length; graphCount += 1) {
    const tournaments = scaledShapeSequence(tournamentEntries, graphCount);
    const matches = scaledShapeSequence(matchEntries, graphCount);
    const instances = tournaments.map((shape, index) => ({ index, shape,
      matchShape: matches[index], slots: [], remainingUsers: Math.max(1, Math.min(2,
        Number(shape.accepted), Number(matches[index].participants))),
      remainingInventory: Number(matches[index].inventory),
      remainingEffects: Number(matches[index].effects) }));
    if (instances.reduce((sum, row) => sum + row.remainingUsers, 0) < slots.length ||
        instances.reduce((sum, row) => sum + row.remainingInventory, 0) !== totalRequired.inventory ||
        instances.reduce((sum, row) => sum + row.remainingEffects, 0) !== totalRequired.effects) continue;
    let fits = true;
    for (const slot of orderedSlots) {
      const required = requiredGraphFeatures(slot.variantGroup);
      const instance = instances.filter((candidate) => candidate.remainingUsers > 0 &&
          candidate.remainingInventory >= required.inventory &&
          candidate.remainingEffects >= required.effects)
        .sort((left, right) => Number(left.slots.length > 0) - Number(right.slots.length > 0) ||
          left.remainingInventory - right.remainingInventory ||
          left.remainingEffects - right.remainingEffects || left.index - right.index)[0];
      if (!instance) { fits = false; break; }
      instance.slots.push(slot); instance.remainingUsers -= 1;
      instance.remainingInventory -= required.inventory;
      instance.remainingEffects -= required.effects;
    }
    if (fits && instances.every((instance) => instance.slots.length > 0 &&
        instance.remainingInventory === 0 && instance.remainingEffects === 0)) return instances;
  }
  throw new Error("Races-tab matchup inventory/effect ownership escaped paired scaled graphs");
}

function graphAssignments({ coverage, sourceCensus }) {
  const grouped = new Map();
  coverage.byUser.forEach((variants, userIndex) => {
    for (const group of groupedVariants(variants, coverage.rowTargetsByUser?.[userIndex])) {
      const { variantGroup } = group;
      const augmented = variantGroup.some((variant) =>
        coverage.augmentedByUser?.[userIndex]?.includes(variant));
      const provenance = augmented ? "augmented" : "natural";
      const team = variantGroup.includes("ordinary_team_active") || variantGroup.includes("pinned_team");
      const compatibleFamily = group.family === "ordinary_active"
        ? `${group.family}:${team ? "team" : "classic"}`
        : group.family === "tournament_active" && variantGroup[0] === "tournament_live_match"
          ? `${group.family}:live_match`
        : `${group.family}:${[...variantGroup].sort().join("|")}`;
      const key = `${compatibleFamily}:${group.occurrence}:${provenance}`;
      if (!grouped.has(key)) grouped.set(key, { family: group.family, provenance, slots: [] });
      grouped.get(key).slots.push({ userIndex, variantGroup });
    }
  });
  const assignments = [];
  let ordinal = 0;
  for (const entry of grouped.values()) {
    const variantGroup = [...new Set(entry.slots.flatMap((slot) => slot.variantGroup))];
    const userIndexes = entry.slots.map((slot) => slot.userIndex);
    const tournament = variantGroup.some((variant) =>
      variant.startsWith("tournament_") || variant === "pinned_tournament");
    const ownerOnly = variantGroup.includes("ordinary_pending_owner") ||
      variantGroup.includes("tournament_champion");
    const needsExternal = variantGroup.includes("ordinary_invite") ||
      variantGroup.includes("tournament_invite");
    const ordinaryStatus = variantGroup.includes("ordinary_completed") ? "COMPLETED" :
      variantGroup.some((variant) => ["ordinary_pending_owner", "ordinary_pending_accepted",
        "ordinary_invite"].includes(variant)) ? "PENDING" : "ACTIVE";
    const ordinaryTeam = variantGroup.some((variant) =>
      ["ordinary_team_active", "pinned_team"].includes(variant));
    const tournamentStatus = variantGroup.some((variant) => ["tournament_invite",
      "tournament_lobby", "pinned_tournament"].includes(variant)) ? "PENDING" :
      variantGroup.some((variant) => ["tournament_champion",
        "tournament_completed_non_champion"].includes(variant)) ? "COMPLETED" : "ACTIVE";
    const sourceEntries = (sourceCensus?.graphJointHistogram?.ordinary || []).filter((row) =>
      String(row.dimensions?.status || "").toUpperCase() === ordinaryStatus &&
      Boolean(row.dimensions?.team) === ordinaryTeam);
    if (!tournament && entry.family === "ordinary_active" && entry.provenance === "natural" &&
        sourceEntries.length > 0) {
      for (const instance of packOrdinaryGraphSlots({ slots: entry.slots, sourceEntries,
        ownerOnly, needsExternal })) {
        const instanceVariants = [...new Set(instance.slots.flatMap((slot) => slot.variantGroup))];
        assignments.push({ variantGroup: instanceVariants, provenance: entry.provenance,
          jointShape: instance.shape, matchShape: null, userSlots: instance.slots,
          userIndexes: instance.slots.map((slot) => slot.userIndex), scaledShape: true });
        ordinal += 1;
      }
      continue;
    }
    const sourceTournamentEntries = (sourceCensus?.graphJointHistogram?.tournaments || [])
      .filter((row) => String(row.dimensions?.status || "").toUpperCase() === "ACTIVE");
    const sourceMatchEntries = (sourceCensus?.graphJointHistogram?.matches || [])
      .filter((row) => String(row.dimensions?.status || "").toUpperCase() === "ACTIVE");
    if (tournament && entry.family === "tournament_active" && entry.provenance === "natural" &&
        entry.slots.every((slot) => slot.variantGroup[0] === "tournament_live_match") &&
        sourceTournamentEntries.length > 0 && sourceMatchEntries.length > 0) {
      for (const instance of packTournamentMatchGraphSlots({ slots: entry.slots,
        tournamentEntries: sourceTournamentEntries, matchEntries: sourceMatchEntries })) {
        const instanceVariants = [...new Set(instance.slots.flatMap((slot) => slot.variantGroup))];
        assignments.push({ variantGroup: instanceVariants, provenance: entry.provenance,
          jointShape: instance.shape, matchShape: instance.matchShape,
          userSlots: instance.slots,
          userIndexes: instance.slots.map((slot) => slot.userIndex), scaledShape: true });
        ordinal += 1;
      }
      continue;
    }
    let index = 0;
    while (index < userIndexes.length) {
      const jointShape = tournament
        ? jointGraphShape(sourceCensus?.graphJointHistogram?.tournaments, ordinal,
          (dimensions) => String(dimensions.status || "").toUpperCase() === tournamentStatus)
        : jointGraphShape(sourceCensus?.graphJointHistogram?.ordinary, ordinal,
          (dimensions) => String(dimensions.status || "").toUpperCase() === ordinaryStatus &&
            Boolean(dimensions.team) === ordinaryTeam &&
            graphShapeMatchesFeatures(dimensions, variantGroup));
      const hasMatch = tournament && variantGroup.some((variant) =>
        variant === "tournament_live_match" || variant.startsWith("tournament_match_"));
      const matchShape = hasMatch
        ? jointGraphShape(sourceCensus?.graphJointHistogram?.matches, ordinal,
          (dimensions) => String(dimensions.status || "").toUpperCase() === "ACTIVE" &&
            graphShapeMatchesFeatures(dimensions, variantGroup))
        : null;
      const sampled = tournament
        ? Number(jointShape?.accepted) || histogramValue(
          sourceCensus?.graphHistograms?.tournamentAcceptedParticipants ||
            sourceCensus?.graphHistograms?.tournamentParticipants,
          ordinal, 2, { minimum: 1, maximum: 64 })
        : Number(jointShape?.participants) || histogramValue(
          sourceCensus?.graphHistograms?.ordinaryParticipantsPerRace,
          ordinal, 2, { minimum: 2, maximum: 32 });
      const required = requiredGraphFeatures(variantGroup);
      const featureShape = tournament ? matchShape : jointShape;
      const featureCapacity = featureShape ? Math.min(
        required.inventory > 0
          ? Math.floor(Number(featureShape.inventory || 0) / required.inventory) : 64,
        required.effects > 0
          ? Math.floor(Number(featureShape.effects || 0) / required.effects) : 64,
      ) : 64;
      const inviteCapacity = tournament && variantGroup.includes("tournament_invite")
        ? Math.max(1, Number(jointShape?.participants || 0) - Number(jointShape?.accepted || 0))
        : sampled - (needsExternal ? 1 : 0);
      const capacity = ownerOnly ? 1 : Math.max(1,
        Math.min(hasMatch ? 2 : 64, inviteCapacity, featureCapacity));
      const batchSlots = entry.slots.slice(index, index + capacity);
      const batchVariantGroup = [...new Set(batchSlots.flatMap((slot) => slot.variantGroup))];
      assignments.push({ variantGroup: batchVariantGroup,
        provenance: entry.provenance,
        jointShape, matchShape,
        userSlots: batchSlots,
        userIndexes: batchSlots.map((slot) => slot.userIndex) });
      index += capacity;
      ordinal += 1;
    }
  }
  return assignments;
}

function histogramOf(values) {
  return values.reduce((result, value) => {
    result[value] = (result[value] || 0) + 1; return result;
  }, {});
}

function graphHistogramsForRows(graphRows) {
  return {
    ordinaryParticipantsPerRace: histogramOf(graphRows.filter((row) => row.family === "ordinary")
      .map((row) => row.participantCount)),
    tournamentBracketSize: histogramOf(graphRows.filter((row) => row.family === "tournament")
      .map((row) => row.bracketSize)),
    tournamentParticipants: histogramOf(graphRows.filter((row) => row.family === "tournament")
      .map((row) => row.participantCount)),
    tournamentAcceptedParticipants: histogramOf(graphRows.filter((row) => row.family === "tournament")
      .map((row) => row.acceptedCount)),
    inventoryPerRace: histogramOf(graphRows.filter((row) => row.family === "ordinary")
      .map((row) => row.inventoryCount)),
    effectsPerRace: histogramOf(graphRows.filter((row) => row.family === "ordinary")
      .map((row) => row.effectCount)),
    matchParticipantsPerRace: histogramOf(graphRows.filter((row) => row.family === "match")
      .map((row) => row.participantCount)),
    matchInventoryPerRace: histogramOf(graphRows.filter((row) => row.family === "match")
      .map((row) => row.inventoryCount)),
    matchEffectsPerRace: histogramOf(graphRows.filter((row) => row.family === "match")
      .map((row) => row.effectCount)),
  };
}

function sourceGraphHistograms(sourceCensus) {
  const rows = [];
  for (const [family, entries] of Object.entries(sourceCensus?.graphJointHistogram || {})) {
    for (const entry of entries || []) for (let count = 0; count < Number(entry.graphs); count += 1) {
      const dimensions = entry.dimensions;
      rows.push(family === "ordinary" ? { family, participantCount: Number(dimensions.participants),
        inventoryCount: Number(dimensions.inventory), effectCount: Number(dimensions.effects) }
        : family === "matches" ? { family: "match",
          participantCount: Number(dimensions.participants),
          inventoryCount: Number(dimensions.inventory), effectCount: Number(dimensions.effects) }
        : { family: "tournament", bracketSize: Number(dimensions.bracketSize),
          participantCount: Number(dimensions.participants), acceptedCount: Number(dimensions.accepted) });
    }
  }
  const derived = graphHistogramsForRows(rows);
  return Object.fromEntries(Object.entries(derived).map(([name, histogram]) => [name,
    Object.keys(sourceCensus?.graphHistograms?.[name] || {}).length
      ? sourceCensus.graphHistograms[name] : histogram]));
}

function countSignatures(rows) {
  return rows.reduce((counts, row) => {
    const signature = JSON.stringify(row);
    counts[signature] = (counts[signature] || 0) + 1;
    return counts;
  }, {});
}

function graphShapeFromRow(row) {
  return row.family === "ordinary" ? {
    family: "ordinary", status: row.bucket, team: row.team, teamSize: row.teamSize || 0,
    participants: row.participantCount, inventory: row.inventoryCount, effects: row.effectCount,
  } : row.family === "match" ? {
    family: "matches", status: row.bucket, participants: row.participantCount,
    inventory: row.inventoryCount, effects: row.effectCount,
  } : {
    family: "tournament", status: ["invite", "lobby"].includes(row.bucket) ? "pending" :
      ["champion", "completed_non_champion"].includes(row.bucket) ? "completed" : "active",
    bracketSize: row.bracketSize, participants: row.participantCount,
    accepted: row.acceptedCount,
  };
}

function plannedGraphShapes(assignments) {
  return assignments.filter((assignment) => assignment.provenance === "natural")
    .flatMap((assignment) => {
      const tournament = assignment.variantGroup.some((variant) =>
        variant.startsWith("tournament_") || variant === "pinned_tournament");
      const rows = [];
      if (assignment.jointShape) rows.push(tournament ? {
        family: "tournament", status: String(assignment.jointShape.status).toLowerCase(),
        bracketSize: Number(assignment.jointShape.bracketSize),
        participants: Number(assignment.jointShape.participants),
        accepted: Number(assignment.jointShape.accepted),
      } : {
        family: "ordinary", status: String(assignment.jointShape.status).toLowerCase(),
        team: Boolean(assignment.jointShape.team), teamSize: Number(assignment.jointShape.teamSize || 0),
        participants: Number(assignment.jointShape.participants),
        inventory: Number(assignment.jointShape.inventory), effects: Number(assignment.jointShape.effects),
      });
      if (assignment.matchShape) rows.push({ family: "matches",
        status: String(assignment.matchShape.status).toLowerCase(),
        participants: Number(assignment.matchShape.participants),
        inventory: Number(assignment.matchShape.inventory),
        effects: Number(assignment.matchShape.effects) });
      return rows;
    });
}

function ownershipEvidence({ assignments, baseUsers, powerups, activeEffects }) {
  const empty = () => ({ held: 0, mystery: 0, queued: 0, effects: 0 });
  const expected = new Map(baseUsers.map((user) => [user.id, empty()]));
  for (const assignment of assignments) for (const slot of assignment.userSlots || []) {
    const values = expected.get(baseUsers[slot.userIndex].id);
    values.held += slot.variantGroup.filter((variant) =>
      variant.endsWith("inventory_held_typed")).length;
    values.mystery += slot.variantGroup.filter((variant) =>
      variant.endsWith("inventory_mystery_box")).length;
    values.queued += slot.variantGroup.filter((variant) =>
      variant.endsWith("inventory_queued_box")).length;
    values.effects += requiredGraphFeatures(slot.variantGroup).effects;
  }
  const generated = new Map(baseUsers.map((user) => [user.id, empty()]));
  for (const powerup of powerups) {
    const values = generated.get(powerup.userId);
    if (!values) continue;
    if (powerup.status === "HELD") values.held += 1;
    if (powerup.status === "MYSTERY_BOX") values.mystery += 1;
    if (powerup.status === "QUEUED") values.queued += 1;
  }
  for (const effect of activeEffects) {
    const values = generated.get(effect.targetUserId);
    if (values) values.effects += 1;
  }
  const fields = ["held", "mystery", "queued", "effects"];
  const totals = (values) => Object.fromEntries(fields.map((field) => [field,
    [...values.values()].reduce((sum, row) => sum + row[field], 0)]));
  const enforce = assignments.some((assignment) => assignment.provenance === "natural" &&
    (assignment.jointShape || assignment.matchShape));
  const mismatchUsers = enforce ? [...expected.keys()].filter((userId) =>
    fields.some((field) => expected.get(userId)[field] !== generated.get(userId)[field])).length
    : 0;
  return { expectedTotals: totals(expected), generatedTotals: totals(generated), mismatchUsers,
    enforced: enforce, matchesAssignedProfiles: mismatchUsers === 0 };
}

function reconcileGraphEvidence(evidence) {
  const dimensions = ["ordinaryParticipantsPerRace", "tournamentBracketSize",
    "tournamentParticipants", "tournamentAcceptedParticipants", "inventoryPerRace",
    "effectsPerRace", "matchParticipantsPerRace", "matchInventoryPerRace",
    "matchEffectsPerRace"];
  const reconciliation = Object.fromEntries(dimensions.map((name) => {
    const sourceValues = Object.keys(evidence.source?.[name] || {}).map(Number)
      .filter(Number.isFinite).sort((a, b) => a - b);
    const generatedValues = Object.keys(evidence.generatedNatural?.[name] ||
      evidence.generated?.[name] || {}).map(Number)
      .filter(Number.isFinite).sort((a, b) => a - b);
    return [name, { sourceValues, generatedValues,
      generatedWithinSourceSupport: sourceValues.length === 0 ||
        generatedValues.every((value) => sourceValues.includes(value)) }];
  }));
  for (const name of dimensions) {
    if (!reconciliation[name].generatedWithinSourceSupport) {
      throw new Error(`Races-tab generated graph ${name} escaped the production census support`);
    }
  }
  const sourceJoint = new Set((evidence.sourceJoint || []).map((row) => JSON.stringify(row)));
  const naturalJointRows = (evidence.graphRows || []).filter((row) => row.provenance === "natural")
    .map(graphShapeFromRow);
  const unsupported = naturalJointRows.filter((row) => sourceJoint.size > 0 &&
    !sourceJoint.has(JSON.stringify(row)));
  const jointReconciliation = { sourceShapeCount: sourceJoint.size,
    generatedNaturalShapeCount: new Set(naturalJointRows.map((row) => JSON.stringify(row))).size,
    generatedWithinSourceSupport: unsupported.length === 0 };
  if (!jointReconciliation.generatedWithinSourceSupport) {
    throw new Error("Races-tab generated graph joint shape escaped the production census support");
  }
  const scaledTargets = countSignatures(plannedGraphShapes(evidence.plannedGraphAssignments || []));
  const scaledGenerated = countSignatures((evidence.graphRows || [])
    .filter((row) => row.provenance === "natural" && row.sourceScaled).map(graphShapeFromRow));
  const normalizedCounts = (counts) => Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right));
  const frequencyReconciliation = { scaledTargets, generated: scaledGenerated,
    generatedMatchesScaledTargets: JSON.stringify(normalizedCounts(scaledTargets)) ===
      JSON.stringify(normalizedCounts(scaledGenerated)) };
  if (!frequencyReconciliation.generatedMatchesScaledTargets) {
    throw new Error("Races-tab generated graph frequencies differ from scaled graph targets");
  }
  const ownershipReconciliation = ownershipEvidence({
    assignments: evidence.plannedGraphAssignments || [], baseUsers: evidence.baseUsers || [],
    powerups: evidence.generatedOwnership?.powerups || [],
    activeEffects: evidence.generatedOwnership?.activeEffects || [],
  });
  if (!ownershipReconciliation.matchesAssignedProfiles) {
    throw new Error("Races-tab generated per-user inventory/effect ownership differs from assigned profiles");
  }
  const { plannedGraphAssignments, baseUsers, generatedOwnership, ...publicEvidence } = evidence;
  return { ...publicEvidence, reconciliation, jointReconciliation,
    frequencyReconciliation, ownershipReconciliation };
}

function materializationPlan({ base, coverage, now = new Date(), runId,
  sourceCensus = null } = {}) {
  assertGraphCensus(sourceCensus);
  const races = [];
  const participants = [];
  const tournaments = [];
  const tournamentParticipants = [];
  const powerups = [];
  const activeEffects = [];
  const shopItems = [];
  const userShopItems = [];
  const equippedAccessories = [];
  const ids = { races: [], raceParticipants: [], tournaments: [],
    tournamentParticipants: [], racePowerups: [], raceActiveEffects: [], shopItems: [],
    userShopItems: [], userEquippedAccessories: [] };
  const graphRows = [];
  let graphOrdinal = 0;
  const marker = `capacity-races:${runId}`;
  const startedAt = new Date(now.getTime() - 60 * 60_000);
  const endsAt = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
  const completedAt = new Date(now.getTime() - 24 * 60 * 60_000);
  const powerupEarnedKeys = new Set();
  const addParticipant = ({ raceId, userId, status = "ACCEPTED", index,
    favorite = false, team = null, placement = null }) => {
    const row = { id: crypto.randomUUID(), raceId, userId, status,
      totalSteps: 10_000 + index, rawSteps: 10_000 + index, baselineSteps: 0,
      nextBoxAtSteps: 15_000, joinedAt: new Date(startedAt.getTime() + index),
      totalsUpdatedAt: now, favoritedAt: favorite ? new Date(now.getTime() - index) : null,
      team, placement,
      ...(status === "INVITED" ? { inviteExpiresAt: endsAt } : {}) };
    participants.push(row); ids.raceParticipants.push(row.id); return row;
  };
  const addPowerup = ({ raceId, participant, userId, type = "SHORTCUT",
    status = "HELD", index }) => {
    let earnedAtSteps = 20_000 + index;
    while (powerupEarnedKeys.has(`${participant.id}:${earnedAtSteps}`)) earnedAtSteps += 1;
    powerupEarnedKeys.add(`${participant.id}:${earnedAtSteps}`);
    const row = { id: crypto.randomUUID(), raceId, participantId: participant.id,
      userId, type: status === "MYSTERY_BOX" ? "MYSTERY_BOX" : type,
      rarity: status === "MYSTERY_BOX" ? null : "COMMON", status,
      earnedAtSteps };
    powerups.push(row); ids.racePowerups.push(row.id); return row;
  };
  const plannedGraphAssignments = graphAssignments({ coverage, sourceCensus });
  for (const assignment of plannedGraphAssignments) {
    const { variantGroup, userIndexes, provenance } = assignment;
    const userSlots = assignment.userSlots || userIndexes.map((userIndex) => ({
      userIndex, variantGroup,
    }));
    const userIndex = userIndexes[0];
    const variant = variantGroup[0];
    const hasVariant = (name) => variantGroup.includes(name);
    const caller = base.users[userIndex];
    const support = base.users[(userIndex + userIndexes.length + 1) % base.users.length];
    const isTournament = variant.startsWith("tournament_") || variant === "pinned_tournament";
    if (!isTournament) {
      const raceId = crypto.randomUUID();
      const teamRace = hasVariant("ordinary_team_active") || hasVariant("pinned_team");
      const status = hasVariant("ordinary_completed") ? "COMPLETED" :
        hasVariant("ordinary_pending_owner") || hasVariant("ordinary_pending_accepted") ||
        hasVariant("ordinary_invite") ? "PENDING" : "ACTIVE";
      const callerIsCreator = hasVariant("ordinary_pending_owner") ||
        hasVariant("pinned_classic") || hasVariant("pinned_team");
      const requiresFullEffectRoster = hasVariant("ordinary_effect_positive") ||
        hasVariant("ordinary_effect_negative") || hasVariant("ordinary_placement_hidden");
      const jointShape = assignment.jointShape || jointGraphShape(
        sourceCensus?.graphJointHistogram?.ordinary,
        graphOrdinal, (dimensions) => String(dimensions.status || "").toUpperCase() === status &&
          Boolean(dimensions.team) === teamRace && graphShapeMatchesFeatures(dimensions, variantGroup));
      const sampledParticipants = Number(jointShape?.participants) || histogramValue(
        sourceCensus?.graphHistograms?.ordinaryParticipantsPerRace, graphOrdinal, 2,
        { minimum: 2, maximum: 32 });
      const sampledInventory = Number.isInteger(Number(jointShape?.inventory))
        ? Number(jointShape.inventory) : histogramValue(sourceCensus?.graphHistograms?.inventoryPerRace,
        graphOrdinal, 0, { minimum: 0, maximum: 32 });
      const sampledEffects = Number.isInteger(Number(jointShape?.effects))
        ? Number(jointShape.effects) : histogramValue(sourceCensus?.graphHistograms?.effectsPerRace,
        graphOrdinal, 0, { minimum: 0, maximum: 32 });
      races.push({ id: raceId, creatorId: callerIsCreator ? caller.id : support.id,
        name: `${marker}:${variantGroup.join("+")}:${userIndex}`, targetSteps: 1_000_000,
        potCoins: requiresFullEffectRoster || sampledEffects > 0 ? 1 : 0,
        maxDurationDays: 14, status, startedAt: status === "PENDING" ? null : startedAt,
        endsAt: status === "PENDING" ? null : status === "COMPLETED" ? completedAt : endsAt,
        completedAt: status === "COMPLETED" ? completedAt : null,
        scheduledStartAt: status === "PENDING" ? endsAt : null,
        scheduledEndAt: status === "PENDING" ? new Date(endsAt.getTime() + 24 * 60 * 60_000) : null,
        powerupsEnabled: sampledInventory > 0 || sampledEffects > 0 ||
          variantGroup.some((value) => value.includes("inventory") ||
            value.includes("effect") || value.includes("placement_hidden")), powerupStepInterval: 5000,
        isPublic: hasVariant("ordinary_classic_active") && userIndex % 10 === 0,
        maxParticipants: teamRace ? 2 * Math.max(1, Number(jointShape?.teamSize) ||
          Math.ceil(sampledParticipants / 2)) : Math.max(sampledParticipants, 2),
        isTeamRace: teamRace,
        teamSize: teamRace ? Math.max(1, Number(jointShape?.teamSize) ||
          Math.ceil(sampledParticipants / 2)) : null,
        teamAName: teamRace ? "Trail Blazers" : null,
        teamBName: teamRace ? "Peak Pacers" : null });
      ids.races.push(raceId);
      const callerVariants = userSlots[0]?.variantGroup || variantGroup;
      const callerHas = (name) => callerVariants.includes(name);
      const callerParticipant = addParticipant({ raceId, userId: caller.id,
        status: hasVariant("ordinary_invite") ? "INVITED" : "ACCEPTED", index: userIndex,
        favorite: callerHas("pinned_classic") || callerHas("pinned_team"), team: teamRace ? "TEAM_A" : null,
        placement: status === "COMPLETED" ? 1 : null });
      const callerParticipants = [{ user: caller, participant: callerParticipant,
        variants: callerVariants }];
      for (const [sharedOrdinal, slot] of userSlots.slice(1).entries()) {
        const sharedIndex = slot.userIndex;
        const sharedUser = base.users[sharedIndex];
        callerParticipants.push({ user: sharedUser, participant: addParticipant({ raceId,
          userId: sharedUser.id, status: hasVariant("ordinary_invite") ? "INVITED" : "ACCEPTED",
          index: sharedIndex,
          favorite: slot.variantGroup.includes("pinned_classic") ||
            slot.variantGroup.includes("pinned_team"),
          team: teamRace ? (sharedOrdinal % 2 ? "TEAM_A" : "TEAM_B") : null,
          placement: status === "COMPLETED" ? sharedOrdinal + 2 : null }),
        variants: slot.variantGroup });
      }
      let supportParticipant = callerParticipants[1]?.participant || null;
      let supportOrdinal = callerParticipants.length;
      while (participants.filter((row) => row.raceId === raceId).length < sampledParticipants) {
        const extra = supportOrdinal === callerParticipants.length ? support :
          base.users[(userIndex + supportOrdinal + 1) % base.users.length];
        supportOrdinal += 1;
        if (participants.some((row) => row.raceId === raceId && row.userId === extra.id)) continue;
        supportParticipant = addParticipant({ raceId, userId: extra.id,
          index: userIndex + 50_000 + supportOrdinal,
          team: teamRace ? (supportOrdinal % 2 ? "TEAM_A" : "TEAM_B") : null,
          placement: status === "COMPLETED" ? supportOrdinal : null });
      }
      supportParticipant ||= callerParticipant;
      for (const entry of callerParticipants) {
        const entryHas = (name) => entry.variants.includes(name);
        if (entryHas("ordinary_inventory_held_typed")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id, index: userIndex });
        if (entryHas("ordinary_inventory_mystery_box")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id,
          status: "MYSTERY_BOX", index: userIndex });
        if (entryHas("ordinary_inventory_queued_box")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id,
          status: "QUEUED", index: userIndex });
        const effectTypes = [
          entryHas("ordinary_effect_positive") ? "RUNNERS_HIGH" : null,
          entryHas("ordinary_effect_negative") || entryHas("ordinary_placement_hidden")
            ? entryHas("ordinary_placement_hidden") ? "DETOUR_SIGN" : "LEG_CRAMP"
            : null,
        ].filter(Boolean);
        for (const type of effectTypes) {
          const powerup = addPowerup({ raceId, participant: supportParticipant,
            userId: supportParticipant.userId, type, status: "USED", index: userIndex });
          const effect = { id: crypto.randomUUID(), raceId,
            targetParticipantId: entry.participant.id, targetUserId: entry.user.id,
            sourceUserId: supportParticipant.userId, powerupId: powerup.id, type, status: "ACTIVE",
            startsAt: startedAt, expiresAt: endsAt };
          activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
        }
      }
      while (activeEffects.filter((row) => row.raceId === raceId).length < sampledEffects) {
        const powerup = addPowerup({ raceId, participant: supportParticipant,
          userId: supportParticipant.userId, type: "RUNNERS_HIGH", status: "USED",
          index: userIndex + activeEffects.length });
        const effect = { id: crypto.randomUUID(), raceId,
          targetParticipantId: callerParticipant.id, targetUserId: caller.id,
          sourceUserId: supportParticipant.userId, powerupId: powerup.id, type: "RUNNERS_HIGH", status: "ACTIVE",
          startsAt: startedAt, expiresAt: endsAt };
        activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
      }
      while (powerups.filter((row) => row.raceId === raceId).length < sampledInventory) {
        addPowerup({ raceId, participant: callerParticipant, userId: caller.id,
          index: userIndex + powerups.length });
      }
      graphRows.push({ family: "ordinary", bucket: status.toLowerCase(),
        provenance,
        sourceScaled: Boolean(assignment.jointShape),
        team: teamRace, teamSize: teamRace ? races.at(-1).teamSize : 0,
        participantCount: participants.filter((row) => row.raceId === raceId).length,
        inventoryCount: powerups.filter((row) => row.raceId === raceId).length,
        effectCount: activeEffects.filter((row) => row.raceId === raceId).length });
      graphOrdinal += 1;
      continue;
    }

    const tournamentId = crypto.randomUUID();
    const render = variantGroup.some((value) => value === "tournament_live_match" ||
      value.startsWith("tournament_match_")) ? "live_match" :
      hasVariant("pinned_tournament") ? "lobby" : variant.replace(/^tournament_/, "");
    const completed = ["champion", "completed_non_champion"].includes(render);
    const pending = ["invite", "lobby"].includes(render);
    const liveMatch = render === "live_match";
    const tournamentStatus = completed ? "COMPLETED" : pending ? "PENDING" : "ACTIVE";
    const jointShape = assignment.jointShape || jointGraphShape(
      sourceCensus?.graphJointHistogram?.tournaments,
      graphOrdinal, (dimensions) => String(dimensions.status || "").toUpperCase() === tournamentStatus);
    const sampledTournamentParticipants = Number(jointShape?.accepted) || histogramValue(
      sourceCensus?.graphHistograms?.tournamentAcceptedParticipants ||
        sourceCensus?.graphHistograms?.tournamentParticipants, graphOrdinal, 2,
      { minimum: 1, maximum: 64 });
    const sampledTournamentTotal = Math.max(sampledTournamentParticipants,
      Number(jointShape?.participants) || sampledTournamentParticipants);
    const sampledBracketSize = Number(jointShape?.bracketSize) || histogramValue(
      sourceCensus?.graphHistograms?.tournamentBracketSize,
      graphOrdinal, 4, { minimum: 2, maximum: 64 });
    const tournament = { id: tournamentId, creatorId: support.id,
      name: `${marker}:${variantGroup.join("+")}:${userIndex}`, status: completed ? "COMPLETED" :
        pending ? "PENDING" : "ACTIVE",
      bracketSize: Math.max(sampledBracketSize, sampledTournamentParticipants), matchupDurationDays: 2,
      potCoins: 100, currentRound: pending ? 0 : completed ? 2 : render === "eliminated" ? 2 : 1,
      totalRounds: 2, startedAt: pending ? null : startedAt,
      completedAt: completed ? completedAt : null,
      championUserId: render === "champion" ? caller.id :
        render === "completed_non_champion" ? support.id : null };
    tournaments.push(tournament); ids.tournaments.push(tournamentId);
    const callerTournamentVariants = userSlots[0]?.variantGroup || variantGroup;
    const callerTournament = { id: crypto.randomUUID(), tournamentId, userId: caller.id,
      status: render === "invite" ? "INVITED" : "ACCEPTED", seed: render === "invite" ? null : 0,
      eliminatedInRound: render === "eliminated" ? 1 : null,
      favoritedAt: callerTournamentVariants.includes("pinned_tournament") ? now : null };
    tournamentParticipants.push(callerTournament);
    ids.tournamentParticipants.push(callerTournament.id);
    for (const [sharedOrdinal, slot] of userSlots.slice(1).entries()) {
      const sharedIndex = slot.userIndex;
      const row = { id: crypto.randomUUID(), tournamentId, userId: base.users[sharedIndex].id,
        status: render === "invite" ? "INVITED" : "ACCEPTED",
        seed: render === "invite" ? null : sharedOrdinal + 1,
        eliminatedInRound: render === "eliminated" ? 1 : null,
        favoritedAt: slot.variantGroup.includes("pinned_tournament") ? now : null };
      tournamentParticipants.push(row); ids.tournamentParticipants.push(row.id);
    }
    let tournamentSupportOrdinal = userIndexes.length;
    while (tournamentParticipants.filter((row) => row.tournamentId === tournamentId &&
      row.status === "ACCEPTED").length < sampledTournamentParticipants) {
      const extra = tournamentSupportOrdinal === userIndexes.length ? support :
        base.users[(userIndex + tournamentSupportOrdinal + 1) % base.users.length];
      tournamentSupportOrdinal += 1;
      if (tournamentParticipants.some((row) => row.tournamentId === tournamentId &&
        row.userId === extra.id)) continue;
      const extraRow = { id: crypto.randomUUID(), tournamentId, userId: extra.id,
        status: "ACCEPTED", seed: tournamentSupportOrdinal, eliminatedInRound: null };
      tournamentParticipants.push(extraRow); ids.tournamentParticipants.push(extraRow.id);
    }
    while (tournamentParticipants.filter((row) => row.tournamentId === tournamentId).length <
      sampledTournamentTotal) {
      const extra = base.users[(userIndex + tournamentSupportOrdinal + 1) % base.users.length];
      tournamentSupportOrdinal += 1;
      if (tournamentParticipants.some((row) => row.tournamentId === tournamentId &&
        row.userId === extra.id)) continue;
      const extraRow = { id: crypto.randomUUID(), tournamentId, userId: extra.id,
        status: "DECLINED", seed: null, eliminatedInRound: null };
      tournamentParticipants.push(extraRow); ids.tournamentParticipants.push(extraRow.id);
    }
    if (liveMatch) {
      const raceId = crypto.randomUUID();
      const matchShape = assignment.matchShape || jointGraphShape(
        sourceCensus?.graphJointHistogram?.matches, graphOrdinal,
        (dimensions) => String(dimensions.status || "").toUpperCase() === "ACTIVE" &&
          graphShapeMatchesFeatures(dimensions, variantGroup));
      const sampledMatchParticipants = Number(matchShape?.participants) || 2;
      const sampledMatchInventory = Number.isInteger(Number(matchShape?.inventory))
        ? Number(matchShape.inventory) : 0;
      const sampledMatchEffects = Number.isInteger(Number(matchShape?.effects))
        ? Number(matchShape.effects) : 0;
      races.push({ id: raceId, creatorId: null,
        name: `${marker}:match:${variant}:${userIndex}`, targetSteps: 1_000_000,
        maxDurationDays: 2, status: "ACTIVE", startedAt, endsAt,
        powerupsEnabled: variantGroup.some((value) => value.includes("inventory") ||
          value.includes("placement_hidden")),
        powerupStepInterval: 5000, isPublic: false,
        maxParticipants: Math.max(2, sampledMatchParticipants),
        tournamentId, tournamentRound: tournament.currentRound, tournamentMatchIndex: 0 });
      ids.races.push(raceId);
      const matchEntries = userSlots.map((slot) => ({ user: base.users[slot.userIndex],
        participant: addParticipant({ raceId, userId: base.users[slot.userIndex].id,
          index: slot.userIndex }), variants: slot.variantGroup }));
      if (matchEntries.length < 2) matchEntries.push({ user: support,
        participant: addParticipant({ raceId, userId: support.id, index: userIndex + 50_000 }) });
      let matchSupportOrdinal = matchEntries.length;
      while (matchEntries.length < sampledMatchParticipants) {
        const extra = base.users[(userIndex + matchSupportOrdinal + 1) % base.users.length];
        matchSupportOrdinal += 1;
        if (matchEntries.some((entry) => entry.user.id === extra.id)) continue;
        matchEntries.push({ user: extra, participant: addParticipant({ raceId,
          userId: extra.id, index: userIndex + 60_000 + matchSupportOrdinal }) });
      }
      const supportMatch = matchEntries[1].participant;
      for (const entry of matchEntries.slice(0, userIndexes.length)) {
        const entryHas = (name) => entry.variants.includes(name);
        if (entryHas("tournament_match_inventory_held_typed")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id, index: userIndex });
        if (entryHas("tournament_match_inventory_mystery_box")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id,
          status: "MYSTERY_BOX", index: userIndex });
        if (entryHas("tournament_match_inventory_queued_box")) addPowerup({ raceId,
          participant: entry.participant, userId: entry.user.id,
          status: "QUEUED", index: userIndex });
        if (entryHas("tournament_match_placement_hidden")) {
          const powerup = addPowerup({ raceId, participant: supportMatch,
            userId: supportMatch.userId, type: "DETOUR_SIGN", status: "USED", index: userIndex });
          const effect = { id: crypto.randomUUID(), raceId,
            targetParticipantId: entry.participant.id, targetUserId: entry.user.id,
            sourceUserId: supportMatch.userId, powerupId: powerup.id,
            type: "DETOUR_SIGN", status: "ACTIVE", startsAt: startedAt, expiresAt: endsAt };
          activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
        }
      }
      while (activeEffects.filter((row) => row.raceId === raceId).length < sampledMatchEffects) {
        const powerup = addPowerup({ raceId, participant: supportMatch,
          userId: supportMatch.userId, type: "DETOUR_SIGN", status: "USED",
          index: userIndex + activeEffects.length });
        const effect = { id: crypto.randomUUID(), raceId,
          targetParticipantId: matchEntries[0].participant.id,
          targetUserId: matchEntries[0].user.id, sourceUserId: supportMatch.userId,
          powerupId: powerup.id, type: "DETOUR_SIGN", status: "ACTIVE",
          startsAt: startedAt, expiresAt: endsAt };
        activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
      }
      while (powerups.filter((row) => row.raceId === raceId).length < sampledMatchInventory) {
        addPowerup({ raceId, participant: matchEntries[0].participant,
          userId: matchEntries[0].user.id, index: userIndex + powerups.length });
      }
      graphRows.push({ family: "match", bucket: "active", provenance,
        sourceScaled: Boolean(assignment.matchShape),
        participantCount: participants.filter((row) => row.raceId === raceId).length,
        inventoryCount: powerups.filter((row) => row.raceId === raceId).length,
        effectCount: activeEffects.filter((row) => row.raceId === raceId).length });
    }
    graphRows.push({ family: "tournament", bucket: render,
      provenance,
      sourceScaled: Boolean(assignment.jointShape),
      bracketSize: tournament.bracketSize,
      participantCount: tournamentParticipants.filter((row) => row.tournamentId === tournamentId).length,
      acceptedCount: tournamentParticipants.filter((row) => row.tournamentId === tournamentId &&
        row.status === "ACCEPTED").length });
    graphOrdinal += 1;
  }
  const tournamentUsers = coverage.byUser.flatMap((variants, userIndex) =>
    variants.some((variant) => variant.startsWith("tournament_") || variant === "pinned_tournament")
      ? [userIndex] : []);
  if (tournamentUsers.length) {
    const item = { id: crypto.randomUUID(), sku: `capacity_races_${crypto.createHash("sha256")
      .update(String(runId)).digest("hex").slice(0, 16)}`, name: "Capacity Races Hat",
    description: "Owned capacity fixture", slot: "HEAD", priceCoins: 0,
    assetKey: "cowboy_hat", active: true, testOnly: false, earnOnly: true };
    shopItems.push(item); ids.shopItems.push(item.id);
    for (const userIndex of tournamentUsers) {
      const purchase = { id: crypto.randomUUID(), userId: base.users[userIndex].id,
        shopItemId: item.id, purchasedAt: now };
      const equipped = { id: crypto.randomUUID(), userId: base.users[userIndex].id,
        slot: "HEAD", shopItemId: item.id };
      userShopItems.push(purchase); equippedAccessories.push(equipped);
      ids.userShopItems.push(purchase.id); ids.userEquippedAccessories.push(equipped.id);
    }
  }
  return { races, participants, tournaments, tournamentParticipants, powerups,
    activeEffects, shopItems, userShopItems, equippedAccessories, ids,
    graphEvidence: reconcileGraphEvidence({ schema: "races-tab-generated-graph-census-v1",
      source: sourceGraphHistograms(sourceCensus),
      sourceJoint: Object.entries(sourceCensus?.graphJointHistogram || {}).flatMap(
        ([family, entries]) => (entries || []).map((entry) => family === "ordinary" ? {
          family, status: String(entry.dimensions.status).toLowerCase(),
          team: Boolean(entry.dimensions.team), teamSize: Number(entry.dimensions.teamSize || 0),
          participants: Number(entry.dimensions.participants),
          inventory: Number(entry.dimensions.inventory), effects: Number(entry.dimensions.effects),
        } : family === "matches" ? {
          family, status: String(entry.dimensions.status).toLowerCase(),
          participants: Number(entry.dimensions.participants),
          inventory: Number(entry.dimensions.inventory), effects: Number(entry.dimensions.effects),
        } : { family: "tournament", status: String(entry.dimensions.status).toLowerCase(),
          bracketSize: Number(entry.dimensions.bracketSize),
          participants: Number(entry.dimensions.participants),
          accepted: Number(entry.dimensions.accepted) })),
      generated: graphHistogramsForRows(graphRows),
      generatedNatural: graphHistogramsForRows(graphRows.filter((row) => row.provenance === "natural")),
      generatedAugmented: graphHistogramsForRows(graphRows.filter((row) => row.provenance === "augmented")),
      graphRows, plannedGraphAssignments, baseUsers: base.users,
      generatedOwnership: { powerups, activeEffects } }) };
}

function sourceCountForVariant(variant, counts = {}) {
  const byVariant = {
    ordinary_classic_active: "ordinaryClassicActive", ordinary_team_active: "ordinaryTeamActive",
    ordinary_pending_owner: "ordinaryPendingOwner", ordinary_pending_accepted: "ordinaryPendingAccepted",
    ordinary_invite: "ordinaryInvite", ordinary_completed: "ordinaryCompleted",
    pinned_classic: "pinnedClassic", pinned_team: "pinnedTeam", pinned_tournament: "pinnedTournament",
    ordinary_placement_visible: "ordinaryClassicActive", ordinary_placement_hidden: "negativeEffects",
    ordinary_inventory_held_typed: "heldInventory",
    ordinary_inventory_mystery_box: "mysteryInventory",
    ordinary_inventory_queued_box: "queuedInventory",
    ordinary_effect_positive: "positiveEffects", ordinary_effect_negative: "negativeEffects",
    tournament_invite: "tournamentInvite", tournament_lobby: "tournamentLobby",
    tournament_between_rounds: "tournamentAlive", tournament_live_match: "tournamentAlive",
    tournament_eliminated: "tournamentEliminated", tournament_champion: "tournamentChampion",
    tournament_completed_non_champion: "tournamentCompletedNonChampion",
    tournament_match_placement_visible: "tournamentAlive",
    tournament_match_placement_hidden: "tournamentMatchNegativeEffects",
    tournament_match_inventory_held_typed: "tournamentMatchHeldInventory",
    tournament_match_inventory_mystery_box: "tournamentMatchMysteryInventory",
    tournament_match_inventory_queued_box: "tournamentMatchQueuedInventory",
  };
  return Number(counts[byVariant[variant]] || 0);
}

async function materializeFullPageFixtureGraph({ prisma, runId, base, coverage, now,
  sourceCensus, manifest = base?.manifest } = {}) {
  const plan = materializationPlan({ base, coverage, now, runId, sourceCensus });
  for (const [name, values] of Object.entries(plan.ids)) {
    manifest.ids[name] = [...(manifest.ids[name] || []), ...values];
  }
  await createMany(prisma.shopItem, plan.shopItems);
  await createMany(prisma.userShopItem, plan.userShopItems);
  await createMany(prisma.userEquippedAccessory, plan.equippedAccessories);
  await createMany(prisma.tournament, plan.tournaments);
  await createMany(prisma.tournamentParticipant, plan.tournamentParticipants);
  await createMany(prisma.race, plan.races);
  await createMany(prisma.raceParticipant, plan.participants);
  await createMany(prisma.racePowerup, plan.powerups);
  await createMany(prisma.raceActiveEffect, plan.activeEffects);
  const augmented = Object.fromEntries(REQUIRED_COVERAGE_VARIANTS.map((variant) => [variant,
    coverage.augmentedByUser.filter((values) => values.includes(variant)).length]));
  return { manifestIds: plan.ids, graphEvidence: plan.graphEvidence,
    naturallyGenerated: { ordinaryActiveMemberships:
      base.manifest?.ids?.raceParticipants?.length || 0, ...(coverage.naturalCounts || {}) },
    augmented, sourceZeroVariants: REQUIRED_COVERAGE_VARIANTS.filter((variant) =>
      sourceCountForVariant(variant, sourceCensus?.counts) === 0) };
}

function normalizeFriendDistribution(row = {}) {
  const sampleUsers = Number(row.userCount);
  const zeroFriendsUsers = Number(row.zeroFriendsCount);
  if (!Number.isInteger(sampleUsers) || sampleUsers < 1 ||
      !Number.isInteger(zeroFriendsUsers) || zeroFriendsUsers < 0 ||
      zeroFriendsUsers > sampleUsers) {
    throw new Error("invalid production friends distribution");
  }
  const sourceTimestamp = new Date(row.sourceTimestamp);
  if (Number.isNaN(sourceTimestamp.getTime())) {
    throw new Error("invalid production friends distribution timestamp");
  }
  return {
    schema: "races-tab-friends-distribution-v1",
    sourceTimestamp: sourceTimestamp.toISOString(),
    sampleUsers,
    zeroFriendsUsers,
    zeroFriendsShare: zeroFriendsUsers / sampleUsers,
  };
}

function interleaveZeroFriends({ users, zeroFriends }) {
  if (!Number.isInteger(users) || users < 1 || !Number.isInteger(zeroFriends) ||
      zeroFriends < 0 || zeroFriends > users) {
    throw new Error("invalid zero-friends cohort");
  }
  return Array.from({ length: users }, (_, index) =>
    Math.floor((index + 1) * zeroFriends / users) > Math.floor(index * zeroFriends / users));
}

async function readFriendDistribution(prisma) {
  const rows = await prisma.$queryRawUnsafe(`WITH accepted AS (
      SELECT requester_id AS user_id FROM friendships WHERE status = 'ACCEPTED'
      UNION
      SELECT addressee_id AS user_id FROM friendships WHERE status = 'ACCEPTED'
    )
    SELECT count(*)::int AS "userCount",
           count(*) FILTER (WHERE accepted.user_id IS NULL)::int AS "zeroFriendsCount",
           greatest(max(users.created_at),
             COALESCE((SELECT max(updated_at) FROM friendships), max(users.created_at)))
             AS "sourceTimestamp"
      FROM users LEFT JOIN accepted ON accepted.user_id = users.id`);
  return normalizeFriendDistribution(rows[0]);
}

async function readRacesTabSourceCensus(prisma) {
  const [row] = await prisma.$queryRawUnsafe(`SELECT
    (SELECT count(*) FROM users) AS "userCount",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='active' AND rp.status='accepted'
        AND r.is_team_race=false) AS "ordinaryClassicActive",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='active' AND rp.status='accepted'
        AND r.is_team_race=true) AS "ordinaryTeamActive",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='pending' AND rp.status='accepted'
        AND r.creator_id=rp.user_id) AS "ordinaryPendingOwner",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='pending' AND rp.status='accepted'
        AND r.creator_id IS DISTINCT FROM rp.user_id) AS "ordinaryPendingAccepted",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='pending' AND rp.status='invited') AS "ordinaryInvite",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND r.status='completed' AND rp.status='accepted') AS "ordinaryCompleted",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND rp.favorited_at IS NOT NULL
        AND r.is_team_race=false) AS "pinnedClassic",
    (SELECT count(*) FROM race_participants rp JOIN races r ON r.id=rp.race_id
      WHERE r.tournament_id IS NULL AND rp.favorited_at IS NOT NULL
        AND r.is_team_race=true) AS "pinnedTeam",
    (SELECT count(*) FROM tournament_participants WHERE favorited_at IS NOT NULL) AS "pinnedTournament",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NULL AND powerup.status='held') AS "heldInventory",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NULL AND powerup.status='mystery_box') AS "mysteryInventory",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NULL AND powerup.status='queued') AS "queuedInventory",
    (SELECT count(*) FROM race_active_effects effect JOIN races r ON r.id=effect.race_id
      WHERE r.tournament_id IS NULL AND effect.status='active_effect'
      AND effect.type IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
        'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS "negativeEffects",
    (SELECT count(*) FROM race_active_effects effect JOIN races r ON r.id=effect.race_id
      WHERE r.tournament_id IS NULL AND effect.status='active_effect'
      AND effect.type NOT IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
        'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS "positiveEffects",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NOT NULL AND powerup.status='held') AS "tournamentMatchHeldInventory",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NOT NULL AND powerup.status='mystery_box') AS "tournamentMatchMysteryInventory",
    (SELECT count(*) FROM race_powerups powerup JOIN races r ON r.id=powerup.race_id
      WHERE r.tournament_id IS NOT NULL AND powerup.status='queued') AS "tournamentMatchQueuedInventory",
    (SELECT count(*) FROM race_active_effects effect JOIN races r ON r.id=effect.race_id
      WHERE r.tournament_id IS NOT NULL AND effect.status='active_effect'
      AND effect.type IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
        'signal_jammer','leech','trail_mine','drill_sergeant','bounty'))
      AS "tournamentMatchNegativeEffects",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='pending' AND tp.status='invited') AS "tournamentInvite",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='pending' AND tp.status='accepted') AS "tournamentLobby",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='active' AND tp.status='accepted' AND tp.eliminated_in_round IS NULL) AS "tournamentAlive",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='active' AND tp.eliminated_in_round IS NOT NULL) AS "tournamentEliminated",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='completed' AND t.champion_user_id=tp.user_id) AS "tournamentChampion",
    (SELECT count(*) FROM tournament_participants tp JOIN tournaments t ON t.id=tp.tournament_id
      WHERE t.status='completed' AND t.champion_user_id IS DISTINCT FROM tp.user_id) AS "tournamentCompletedNonChampion",
    (SELECT count(*) FROM races WHERE is_public=true AND status IN ('pending','active')
      AND tournament_id IS NULL) AS "publicRaceCount",
    (SELECT greatest(COALESCE(max(created_at), to_timestamp(0)),
      COALESCE((SELECT max(updated_at) FROM races), to_timestamp(0)),
      COALESCE((SELECT max(created_at) FROM tournaments), to_timestamp(0))) FROM users)
      AS "sourceTimestamp"`);
  const [joint] = await prisma.$queryRawUnsafe(`WITH per_user AS (
    SELECT u.id,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='active'
        AND rp.status='accepted' AND COALESCE(r.is_team_race,false)=false)::int AS classic_active,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='active'
        AND rp.status='accepted' AND COALESCE(r.is_team_race,false)=true)::int AS team_active,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='pending'
        AND rp.status='accepted' AND r.creator_id=rp.user_id)::int AS pending_owner,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='pending'
        AND rp.status='accepted' AND r.creator_id IS DISTINCT FROM rp.user_id)::int AS pending_accepted,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='completed'
        AND rp.status='accepted')::int AS completed,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND rp.status='invited')::int AS invited,
      bool_or(rp.favorited_at IS NOT NULL AND COALESCE(r.is_team_race,false)=false) AS pinned_classic,
      bool_or(rp.favorited_at IS NOT NULL AND COALESCE(r.is_team_race,false)=true) AS pinned_team,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NULL
          AND powerup.status='held') AS held_inventory,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NULL
          AND powerup.status='mystery_box') AS mystery_inventory,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NULL
          AND powerup.status='queued') AS queued_inventory,
      (SELECT count(*)::int FROM race_active_effects effect JOIN races er ON er.id=effect.race_id
        WHERE effect.target_user_id=u.id AND er.tournament_id IS NULL
          AND effect.status='active_effect'
          AND effect.type IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
            'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS negative_effects,
      (SELECT count(*)::int FROM race_active_effects effect JOIN races er ON er.id=effect.race_id
        WHERE effect.target_user_id=u.id AND er.tournament_id IS NULL
          AND effect.status='active_effect'
          AND effect.type NOT IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
            'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS positive_effects,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NOT NULL
          AND powerup.status='held') AS match_held_inventory,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NOT NULL
          AND powerup.status='mystery_box') AS match_mystery_inventory,
      (SELECT count(*)::int FROM race_powerups powerup JOIN races pr ON pr.id=powerup.race_id
        WHERE powerup.user_id=u.id AND pr.tournament_id IS NOT NULL
          AND powerup.status='queued') AS match_queued_inventory,
      (SELECT count(*)::int FROM race_active_effects effect JOIN races er ON er.id=effect.race_id
        WHERE effect.target_user_id=u.id AND er.tournament_id IS NOT NULL
          AND effect.status='active_effect'
          AND effect.type IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
            'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS match_negative_effects
    FROM users u LEFT JOIN race_participants rp ON rp.user_id=u.id
      LEFT JOIN races r ON r.id=rp.race_id GROUP BY u.id
  ), tournament_user AS (
    SELECT u.id,
      count(*) FILTER (WHERE tp.status='invited')::int AS tournament_invited,
      count(*) FILTER (WHERE tp.status='accepted' AND t.status='pending')::int AS tournament_pending,
      count(*) FILTER (WHERE tp.status='accepted' AND t.status='active')::int AS tournament_active,
      count(*) FILTER (WHERE tp.status='accepted' AND t.status='completed')::int AS tournament_completed,
      bool_or(tp.favorited_at IS NOT NULL) AS tournament_pinned
    FROM users u LEFT JOIN tournament_participants tp ON tp.user_id=u.id
      LEFT JOIN tournaments t ON t.id=tp.tournament_id GROUP BY u.id
  ), grouped AS (
    SELECT p.classic_active,p.team_active,p.pending_owner,p.pending_accepted,
      p.completed,p.invited,p.pinned_classic,p.pinned_team,
      p.held_inventory,p.mystery_inventory,p.queued_inventory,
      p.positive_effects,p.negative_effects,
      p.match_held_inventory,p.match_mystery_inventory,p.match_queued_inventory,
      p.match_negative_effects,
      t.tournament_invited,t.tournament_pending,t.tournament_active,t.tournament_completed,
      t.tournament_pinned,count(*)::int AS users
    FROM per_user p JOIN tournament_user t USING(id)
    GROUP BY p.classic_active,p.team_active,p.pending_owner,p.pending_accepted,
      p.completed,p.invited,p.pinned_classic,p.pinned_team,
      p.held_inventory,p.mystery_inventory,p.queued_inventory,
      p.positive_effects,p.negative_effects,
      p.match_held_inventory,p.match_mystery_inventory,p.match_queued_inventory,
      p.match_negative_effects,
      t.tournament_invited,t.tournament_pending,t.tournament_active,t.tournament_completed,
      t.tournament_pinned
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('users',users,'dimensions',
      jsonb_build_object('classicActive',classic_active,'teamActive',team_active,
        'pendingOwner',pending_owner,'pendingAccepted',pending_accepted,
        'completed',completed,'invited',invited,
        'pinnedClassic',pinned_classic,'pinnedTeam',pinned_team,
        'heldInventory',held_inventory,'mysteryInventory',mystery_inventory,
        'queuedInventory',queued_inventory,'positiveEffects',positive_effects,
        'negativeEffects',negative_effects,
        'matchHeldInventory',match_held_inventory,
        'matchMysteryInventory',match_mystery_inventory,
        'matchQueuedInventory',match_queued_inventory,
        'matchNegativeEffects',match_negative_effects,
        'tournamentInvited',tournament_invited,'tournamentPending',tournament_pending,
        'tournamentActive',tournament_active,'tournamentCompleted',tournament_completed,
        'tournamentPinned',tournament_pinned)) ORDER BY users DESC), '[]'::jsonb)
      AS "histogram" FROM grouped`);
  const [graphs] = await prisma.$queryRawUnsafe(`SELECT jsonb_build_object(
    'ordinaryParticipantsPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(*)::int x FROM race_participants rp
        JOIN races r ON r.id=rp.race_id WHERE r.tournament_id IS NULL GROUP BY r.id) z
        GROUP BY x) q), '{}'::jsonb),
    'tournamentBracketSize', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT bracket_size::int x,count(*)::int n FROM tournaments GROUP BY bracket_size) q),
      '{}'::jsonb),
    'tournamentParticipants', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(*)::int x FROM tournament_participants
        GROUP BY tournament_id) z GROUP BY x) q), '{}'::jsonb),
    'tournamentAcceptedParticipants', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(*)::int x FROM tournament_participants
        WHERE status='accepted' GROUP BY tournament_id) z GROUP BY x) q), '{}'::jsonb),
    'inventoryPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(rp.id)::int x FROM races r
        LEFT JOIN race_powerups rp ON rp.race_id=r.id WHERE r.tournament_id IS NULL
        GROUP BY r.id) z GROUP BY x) q), '{}'::jsonb),
    'effectsPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(rae.id)::int x FROM races r
        LEFT JOIN race_active_effects rae ON rae.race_id=r.id WHERE r.tournament_id IS NULL
        GROUP BY r.id) z GROUP BY x) q), '{}'::jsonb),
    'matchParticipantsPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(rp.id)::int x FROM races r
        LEFT JOIN race_participants rp ON rp.race_id=r.id WHERE r.tournament_id IS NOT NULL
        GROUP BY r.id) z GROUP BY x) q), '{}'::jsonb),
    'matchInventoryPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(rp.id)::int x FROM races r
        LEFT JOIN race_powerups rp ON rp.race_id=r.id WHERE r.tournament_id IS NOT NULL
        GROUP BY r.id) z GROUP BY x) q), '{}'::jsonb),
    'matchEffectsPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(rae.id)::int x FROM races r
        LEFT JOIN race_active_effects rae ON rae.race_id=r.id WHERE r.tournament_id IS NOT NULL
        GROUP BY r.id) z GROUP BY x) q), '{}'::jsonb)
  ) AS "histograms"`);
  const [graphJoint] = await prisma.$queryRawUnsafe(`WITH ordinary_graph AS (
    SELECT r.status::text AS status, COALESCE(r.is_team_race,false) AS team,
      COALESCE(r.team_size,0)::int AS team_size,
      count(DISTINCT rp.id)::int AS participants,
      count(DISTINCT powerup.id)::int AS inventory,
      count(DISTINCT effect.id)::int AS effects
    FROM races r LEFT JOIN race_participants rp ON rp.race_id=r.id
      LEFT JOIN race_powerups powerup ON powerup.race_id=r.id
      LEFT JOIN race_active_effects effect ON effect.race_id=r.id
    WHERE r.tournament_id IS NULL
    GROUP BY r.id,r.status,r.is_team_race,r.team_size
  ), ordinary_grouped AS (
    SELECT status,team,team_size,participants,inventory,effects,count(*)::int AS graphs
    FROM ordinary_graph GROUP BY status,team,team_size,participants,inventory,effects
  ), tournament_graph AS (
    SELECT t.status::text AS status,t.bracket_size::int AS bracket_size,
      count(tp.id)::int AS participants,
      count(tp.id) FILTER (WHERE tp.status='accepted')::int AS accepted
    FROM tournaments t LEFT JOIN tournament_participants tp ON tp.tournament_id=t.id
    GROUP BY t.id,t.status,t.bracket_size
  ), tournament_grouped AS (
    SELECT status,bracket_size,participants,accepted,count(*)::int AS graphs
    FROM tournament_graph GROUP BY status,bracket_size,participants,accepted
  ), match_graph AS (
    SELECT r.status::text AS status,count(DISTINCT rp.id)::int AS participants,
      count(DISTINCT powerup.id)::int AS inventory,
      count(DISTINCT effect.id)::int AS effects
    FROM races r LEFT JOIN race_participants rp ON rp.race_id=r.id
      LEFT JOIN race_powerups powerup ON powerup.race_id=r.id
      LEFT JOIN race_active_effects effect ON effect.race_id=r.id
    WHERE r.tournament_id IS NOT NULL
    GROUP BY r.id,r.status
  ), match_grouped AS (
    SELECT status,participants,inventory,effects,count(*)::int AS graphs
    FROM match_graph GROUP BY status,participants,inventory,effects
  ) SELECT jsonb_build_object(
    'ordinary',COALESCE((SELECT jsonb_agg(jsonb_build_object('graphs',graphs,'dimensions',
      jsonb_build_object('status',status,'team',team,'participants',participants,
        'teamSize',team_size,'inventory',inventory,'effects',effects))
        ORDER BY status,team,team_size,participants,inventory,effects)
      FROM ordinary_grouped),'[]'::jsonb),
    'tournaments',COALESCE((SELECT jsonb_agg(jsonb_build_object('graphs',graphs,'dimensions',
      jsonb_build_object('status',status,'bracketSize',bracket_size,
        'participants',participants,'accepted',accepted)) ORDER BY status,bracket_size,participants,accepted)
      FROM tournament_grouped),'[]'::jsonb),
    'matches',COALESCE((SELECT jsonb_agg(jsonb_build_object('graphs',graphs,'dimensions',
      jsonb_build_object('status',status,'participants',participants,
        'inventory',inventory,'effects',effects)) ORDER BY status,participants,inventory,effects)
      FROM match_grouped),'[]'::jsonb)) AS "histogram"`);
  const sourceTimestamp = new Date(row?.sourceTimestamp || 0);
  if (Number.isNaN(sourceTimestamp.getTime())) throw new Error("invalid Races-tab source census timestamp");
  const counts = Object.fromEntries(Object.entries(row || {})
    .filter(([key]) => key !== "sourceTimestamp")
    .map(([key, value]) => [key, Number(value)]));
  if (Object.values(counts).some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("invalid Races-tab source census counts");
  }
  const jointHistogram = Array.isArray(joint?.histogram) ? joint.histogram : [];
  if (jointHistogram.some((entry) => !Number.isInteger(Number(entry.users)) ||
      Number(entry.users) < 1 || !entry.dimensions || typeof entry.dimensions !== "object")) {
    throw new Error("invalid Races-tab source joint histogram");
  }
  assertGraphCensus({ graphHistograms: graphs?.histograms || {},
    graphJointHistogram: graphJoint?.histogram || { ordinary: [], tournaments: [], matches: [] } });
  const result = { schema: "races-tab-source-census-v2",
    sourceTimestamp: sourceTimestamp.toISOString(), counts, jointHistogram,
    graphHistograms: graphs?.histograms || {}, graphJointHistogram: graphJoint?.histogram || {
      ordinary: [], tournaments: [], matches: [] } };
  return { ...result, sourceHash: crypto.createHash("sha256")
    .update(JSON.stringify(result)).digest("hex") };
}

function nonZeroFriendCount(users, share) {
  let zeroFriends = Math.max(0, Math.min(users, Math.round(users * share)));
  if (users > 1 && users - zeroFriends === 1) zeroFriends -= 1;
  return zeroFriends;
}

function friendshipRows(users, zeroFlags) {
  const connected = users.filter((_, index) => !zeroFlags[index]);
  if (connected.length < 2) return [];
  const pairs = [];
  for (let index = 0; index + 1 < connected.length; index += 2) {
    pairs.push([connected[index], connected[index + 1]]);
  }
  if (connected.length % 2 === 1) pairs.push([connected.at(-1), connected[0]]);
  return pairs.map(([requester, addressee]) => ({
    id: crypto.randomUUID(), requesterId: requester.id, addresseeId: addressee.id,
    status: "ACCEPTED",
  }));
}

function stableDate(value) {
  return value == null ? null : new Date(value).toISOString();
}

function fixtureStateEvidence(rows = {}) {
  const users = (rows.users || []).map((row) => ({ id: row.id }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const races = (rows.races || []).map((row) => ({ id: row.id, status: row.status,
    startedAt: stableDate(row.startedAt), endsAt: stableDate(row.endsAt),
    completedAt: stableDate(row.completedAt), scheduledStartAt: stableDate(row.scheduledStartAt),
    scheduledEndAt: stableDate(row.scheduledEndAt), isTeamRace: row.isTeamRace,
    teamSize: row.teamSize, teamAName: row.teamAName, teamBName: row.teamBName,
    winnerTeam: row.winnerTeam, isPublic: row.isPublic, targetSteps: row.targetSteps,
    maxDurationDays: row.maxDurationDays, powerupsEnabled: row.powerupsEnabled,
    powerupStepInterval: row.powerupStepInterval, tournamentId: row.tournamentId,
    tournamentRound: row.tournamentRound, tournamentMatchIndex: row.tournamentMatchIndex }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const participants = (rows.participants || []).map((row) => ({ id: row.id,
    raceId: row.raceId, userId: row.userId, status: row.status, totalSteps: row.totalSteps,
    rawSteps: row.rawSteps, baselineSteps: row.baselineSteps, nextBoxAtSteps: row.nextBoxAtSteps,
    favoritedAt: stableDate(row.favoritedAt), team: row.team, placement: row.placement,
    totalsUpdatedAt: stableDate(row.totalsUpdatedAt), inviteExpiresAt: stableDate(row.inviteExpiresAt) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const friendships = (rows.friendships || []).map((row) => ({ id: row.id,
    requesterId: row.requesterId, addresseeId: row.addresseeId, status: row.status }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const tournaments = (rows.tournaments || []).map((row) => ({ id: row.id,
    status: row.status, currentRound: row.currentRound, totalRounds: row.totalRounds,
    championUserId: row.championUserId, startedAt: stableDate(row.startedAt),
    completedAt: stableDate(row.completedAt), bracketSize: row.bracketSize,
    matchupDurationDays: row.matchupDurationDays, potCoins: row.potCoins }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const tournamentParticipants = (rows.tournamentParticipants || []).map((row) => ({
    id: row.id, tournamentId: row.tournamentId, userId: row.userId,
    status: row.status, seed: row.seed, eliminatedInRound: row.eliminatedInRound,
    favoritedAt: stableDate(row.favoritedAt) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const powerups = (rows.powerups || []).map((row) => ({ id: row.id, raceId: row.raceId,
    participantId: row.participantId, type: row.type, rarity: row.rarity, status: row.status,
    earnedAtSteps: row.earnedAtSteps }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeEffects = (rows.activeEffects || []).map((row) => ({ id: row.id,
    raceId: row.raceId, targetParticipantId: row.targetParticipantId, type: row.type,
    status: row.status, targetUserId: row.targetUserId, sourceUserId: row.sourceUserId,
    powerupId: row.powerupId, startsAt: stableDate(row.startsAt), expiresAt: stableDate(row.expiresAt) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const shopItems = (rows.shopItems || []).map((row) => ({ id: row.id, sku: row.sku,
    slot: row.slot, assetKey: row.assetKey, active: row.active, testOnly: row.testOnly }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const userShopItems = (rows.userShopItems || []).map((row) => ({ id: row.id,
    userId: row.userId, shopItemId: row.shopItemId }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const equippedAccessories = (rows.equippedAccessories || []).map((row) => ({ id: row.id,
    userId: row.userId, shopItemId: row.shopItemId, slot: row.slot }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const byStatus = (values) => values.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1; return result;
  }, {});
  const stableFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ users, races, participants, friendships, tournaments,
      tournamentParticipants, powerups, activeEffects, shopItems, userShopItems,
      equippedAccessories,
      publicRaceCount: Number(rows.publicRaceCount || 0) })).digest("hex");
  return {
    schema: "races-tab-fixture-state-evidence-v1",
    stableFingerprint,
    census: {
      users: users.length,
      races: races.length,
      racesByStatus: byStatus(races),
      participants: participants.length,
      participantsByStatus: byStatus(participants),
      friendships: friendships.length,
      friendshipsByStatus: byStatus(friendships),
      tournaments: tournaments.length,
      tournamentsByStatus: byStatus(tournaments),
      tournamentParticipants: tournamentParticipants.length,
      tournamentParticipantsByStatus: byStatus(tournamentParticipants),
      powerups: powerups.length,
      powerupsByStatus: byStatus(powerups),
      activeEffects: activeEffects.length,
      activeEffectsByStatus: byStatus(activeEffects),
      shopItems: shopItems.length,
      userShopItems: userShopItems.length,
      equippedAccessories: equippedAccessories.length,
      publicRaceCount: Number(rows.publicRaceCount || 0),
    },
  };
}

async function captureFixtureState(prisma, ids = {}) {
  const users = Array.isArray(ids.users) ? ids.users : [];
  const races = Array.isArray(ids.races) ? ids.races : [];
  const participants = Array.isArray(ids.raceParticipants) ? ids.raceParticipants : [];
  const friendships = Array.isArray(ids.friendships) ? ids.friendships : [];
  const tournaments = Array.isArray(ids.tournaments) ? ids.tournaments : [];
  const tournamentParticipants = Array.isArray(ids.tournamentParticipants)
    ? ids.tournamentParticipants : [];
  const powerups = Array.isArray(ids.racePowerups) ? ids.racePowerups : [];
  const activeEffects = Array.isArray(ids.raceActiveEffects) ? ids.raceActiveEffects : [];
  const shopItems = Array.isArray(ids.shopItems) ? ids.shopItems : [];
  const userShopItems = Array.isArray(ids.userShopItems) ? ids.userShopItems : [];
  const equippedAccessories = Array.isArray(ids.userEquippedAccessories)
    ? ids.userEquippedAccessories : [];
  const [userRows, raceRows, participantRows, friendshipStateRows, tournamentRows,
    tournamentParticipantRows, powerupRows, activeEffectRows, shopItemRows, userShopItemRows,
    equippedAccessoryRows, publicRaceCount] = await Promise.all([
    users.length ? prisma.user.findMany({ where: { id: { in: users } },
      select: { id: true } }) : [],
    races.length ? prisma.race.findMany({ where: { id: { in: races } },
      select: { id: true, status: true, startedAt: true, endsAt: true, completedAt: true,
        scheduledStartAt: true, scheduledEndAt: true, isTeamRace: true, teamSize: true,
        teamAName: true, teamBName: true, winnerTeam: true, isPublic: true,
        targetSteps: true, maxDurationDays: true, powerupsEnabled: true,
        powerupStepInterval: true, tournamentId: true, tournamentRound: true,
        tournamentMatchIndex: true } }) : [],
    participants.length ? prisma.raceParticipant.findMany({ where: { id: { in: participants } },
      select: { id: true, raceId: true, userId: true, status: true, totalSteps: true,
        rawSteps: true, baselineSteps: true, nextBoxAtSteps: true, favoritedAt: true,
        team: true, placement: true, totalsUpdatedAt: true, inviteExpiresAt: true } }) : [],
    friendships.length ? prisma.friendship.findMany({ where: { id: { in: friendships } },
      select: { id: true, requesterId: true, addresseeId: true, status: true } }) : [],
    tournaments.length ? prisma.tournament.findMany({ where: { id: { in: tournaments } },
      select: { id: true, status: true, currentRound: true, totalRounds: true,
        championUserId: true, startedAt: true, completedAt: true, bracketSize: true,
        matchupDurationDays: true, potCoins: true } }) : [],
    tournamentParticipants.length ? prisma.tournamentParticipant.findMany({
      where: { id: { in: tournamentParticipants } }, select: { id: true,
        tournamentId: true, userId: true, status: true, seed: true,
        eliminatedInRound: true, favoritedAt: true } }) : [],
    powerups.length ? prisma.racePowerup.findMany({ where: { id: { in: powerups } },
      select: { id: true, raceId: true, participantId: true, type: true, rarity: true,
        status: true, earnedAtSteps: true } }) : [],
    activeEffects.length ? prisma.raceActiveEffect.findMany({
      where: { id: { in: activeEffects } }, select: { id: true, raceId: true,
        targetParticipantId: true, targetUserId: true, sourceUserId: true, powerupId: true,
        type: true, status: true, startsAt: true,
        expiresAt: true } }) : [],
    shopItems.length ? prisma.shopItem.findMany({ where: { id: { in: shopItems } },
      select: { id: true, sku: true, slot: true, assetKey: true, active: true,
        testOnly: true } }) : [],
    userShopItems.length ? prisma.userShopItem.findMany({ where: { id: { in: userShopItems } },
      select: { id: true, userId: true, shopItemId: true } }) : [],
    equippedAccessories.length ? prisma.userEquippedAccessory.findMany({
      where: { id: { in: equippedAccessories } }, select: { id: true, userId: true,
        shopItemId: true, slot: true } }) : [],
    typeof prisma.race.count === "function" ? prisma.race.count({ where: {
      isPublic: true, status: { in: ["PENDING", "ACTIVE"] }, tournamentId: null,
    } }) : 0,
  ]);
  return fixtureStateEvidence({ users: userRows, races: raceRows,
    participants: participantRows, friendships: friendshipStateRows,
    tournaments: tournamentRows, tournamentParticipants: tournamentParticipantRows,
    powerups: powerupRows, activeEffects: activeEffectRows, shopItems: shopItemRows,
    userShopItems: userShopItemRows, equippedAccessories: equippedAccessoryRows,
    publicRaceCount });
}

async function createRacesTabOpenFixtures({
  prisma, runId, users = 5000, arrivalRate = 1, scoreShape = "production",
  env = process.env, now = new Date(), createBaseFixtures = createHomeOpenFixtures,
  minimumMeasuredSessions = 300,
  maximumCoverageAugmentationShare = 0.1,
  requiredCoverageVariants = REQUIRED_COVERAGE_VARIANTS,
  materializeFullPageFixtures = materializeFullPageFixtureGraph,
  buildExpectedProjection = defaultExpectedProjection,
  settingsManager = null,
  readSourceCensus = readRacesTabSourceCensus,
} = {}) {
  assertFixtureDatabase(env);
  const distribution = await readFriendDistribution(prisma);
  const sourceCensus = await readSourceCensus(prisma);
  const base = await createBaseFixtures({ prisma, runId, users, arrivalRate,
    scoreShape, env, now });
  const settings = settingsManager || buildAppSettings({ prisma });
  let pinnedSettings = null;
  try {
    pinnedSettings = await pinRacesTabSettings({ prisma, settings });
    base.manifest.racesTabPinnedSettings = pinnedSettings;
    const zeroFriends = nonZeroFriendCount(base.users.length, distribution.zeroFriendsShare);
    const flags = interleaveZeroFriends({ users: base.users.length, zeroFriends });
    const rows = friendshipRows(base.users, flags);
    if (rows.length) await prisma.friendship.createMany({ data: rows });
    base.manifest.ids.friendships = rows.map((row) => row.id);
    const coverage = buildCoverageAssignments({ users: base.users.length,
      prefixSize: minimumMeasuredSessions, requiredVariants: requiredCoverageVariants,
      maximumAugmentationShare: maximumCoverageAugmentationShare, sourceCensus });
    const fullPage = await materializeFullPageFixtures({ prisma, runId, base, coverage,
      sourceCensus, now, env, manifest: base.manifest });
    for (const [name, values] of Object.entries(fullPage.manifestIds || {})) {
      const current = new Set(base.manifest.ids[name] || []);
      base.manifest.ids[name] = [...current, ...(values || []).filter((value) => !current.has(value))];
    }
    const projectedUsers = [];
    for (let index = 0; index < base.users.length; index += 1) {
      const user = { ...base.users[index], zeroFriends: flags[index] };
      const expectedProjection = await buildExpectedProjection({ prisma, user, userIndex: index,
        base, fullPage, coverageVariants: coverage.byUser[index], now });
      projectedUsers.push({ ...user, expectedProjectionVersion: PROJECTION_VERSION,
        expectedProjection, coverageVariants: coverage.byUser[index],
        coverageAugmented: coverage.augmentedByUser[index].length > 0 });
    }
    const preScanState = await captureFixtureState(prisma, base.manifest.ids);
    base.manifest.racesTabState = preScanState;
    const sourceHash = crypto.createHash("sha256")
      .update(JSON.stringify(distribution)).digest("hex");
    const cleanupFriendships = () => rows.length
      ? prisma.friendship.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
      : Promise.resolve({ count: 0 });
    return {
      ...base,
      users: projectedUsers,
      topology: {
        ...base.topology,
        schema: "races-tab-open-fixture-topology-v2",
        cohortOrdering: "joint-census-balanced-coverage-floor-v2",
        friendDistribution: distribution,
        sourceCensus,
        friendDistributionSourceHash: sourceHash,
        zeroFriendsCount: zeroFriends,
        zeroFriendsShare: base.users.length ? zeroFriends / base.users.length : 0,
        friendshipsMaterialized: rows.length,
        modeledStateProfile: {
          schema: "races-tab-modeled-state-profile-v2",
          included: ["active", "pending", "completed", "invited", "tournament",
            "team-race", "pinned", "placement", "inventory", "active-effect",
            "discovery-public-count", "zero-friends"],
          excludedOffScreen: ["cancelled-tournament", "review-opportunity", "payout-double"],
        },
        expectedProjectionVersion: PROJECTION_VERSION,
        pinnedSettings,
        coverage: {
          schema: coverage.schema,
          prefixSize: coverage.prefixSize,
          requiredVariants: coverage.requiredVariants,
          augmentedIdentities: coverage.augmentedIdentities,
          augmentationShare: coverage.augmentationShare,
          naturalCounts: coverage.naturalCounts,
          jointHistogramApplied: coverage.jointHistogramApplied,
          policy: coverage.policy,
        },
        contentDistribution: {
          naturallyGenerated: fullPage.naturallyGenerated || {},
          augmented: fullPage.augmented || {},
          sourceZeroVariants: fullPage.sourceZeroVariants || [],
          graphEvidence: fullPage.graphEvidence || null,
        },
        preScanState,
      },
      cleanupFriendships,
    };
  } catch (error) {
    try { await cleanupRacesTabOpenFixtures({ prisma, manifest: base.manifest }); }
    catch (cleanupError) {
      throw new AggregateError([error, ...(cleanupError.errors || [cleanupError])],
        `Races-tab fixture preparation and cleanup failed: ${error.message}`);
    }
    throw error;
  }
}

async function cleanupRacesTabOpenFixtures({ prisma, manifest } = {}) {
  const errors = [];
  const attempt = async (operation) => {
    try { return await operation(); } catch (error) { errors.push(error); return null; }
  };
  const ids = Array.isArray(manifest?.ids?.friendships) ? manifest.ids.friendships : [];
  if (ids.length) await attempt(() => prisma.friendship.deleteMany({ where: { id: { in: ids } } }));
  const owned = manifest?.ids || {};
  if (owned.raceActiveEffects?.length) await attempt(() => prisma.raceActiveEffect.deleteMany({
    where: { id: { in: owned.raceActiveEffects } } }));
  if (owned.racePowerups?.length) await attempt(() => prisma.racePowerup.deleteMany({
    where: { id: { in: owned.racePowerups } } }));
  if (owned.userEquippedAccessories?.length) await attempt(() =>
    prisma.userEquippedAccessory.deleteMany({ where: { id: { in: owned.userEquippedAccessories } } }));
  if (owned.userShopItems?.length) await attempt(() =>
    prisma.userShopItem.deleteMany({ where: { id: { in: owned.userShopItems } } }));
  if (owned.tournamentParticipants?.length) await attempt(() => prisma.tournamentParticipant.deleteMany({
    where: { id: { in: owned.tournamentParticipants } } }));
  if (owned.tournaments?.length) {
    await attempt(() => prisma.raceParticipant.deleteMany({ where: { race: {
      tournamentId: { in: owned.tournaments } } } }));
    await attempt(() => prisma.race.deleteMany({ where: { tournamentId: { in: owned.tournaments } } }));
    await attempt(() => prisma.tournament.deleteMany({ where: { id: { in: owned.tournaments } } }));
  }
  let cleanup = await attempt(() => cleanupHomeOpenFixtures({ prisma, manifest }));
  if (owned.shopItems?.length) await attempt(() => prisma.shopItem.deleteMany({
    where: { id: { in: owned.shopItems } } }));
  const restoredSettings = await attempt(() => restoreRacesTabSettings({ prisma,
    evidence: manifest?.racesTabPinnedSettings }));
  if (errors.length) throw new AggregateError(errors, "Races-tab fixture cleanup failed");
  return { ...cleanup, restoredSettings };
}

async function verifyRacesTabOpenFixtures({ prisma, manifest } = {}) {
  const before = manifest?.racesTabState;
  if (before?.schema !== "races-tab-fixture-state-evidence-v1") {
    throw new Error("races-tab fixture baseline evidence is missing");
  }
  const after = await captureFixtureState(prisma, manifest?.ids);
  const stable = before.stableFingerprint === after.stableFingerprint;
  if (!stable) throw new Error("races-tab fixture distribution drifted during the scan");
  return { schema: "races-tab-fixture-stability-v1", stable, before, after };
}

module.exports = {
  buildCoverageAssignments,
  cleanupRacesTabOpenFixtures,
  createRacesTabOpenFixtures,
  fixtureStateEvidence,
  interleaveZeroFriends,
  normalizeFriendDistribution,
  materializationPlan,
  materializeFullPageFixtureGraph,
  pinRacesTabSettings,
  restoreRacesTabSettings,
  readFriendDistribution,
  readRacesTabSourceCensus,
  verifyRacesTabOpenFixtures,
};
