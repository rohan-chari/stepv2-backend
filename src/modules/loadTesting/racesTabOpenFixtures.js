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
  const sourceUsers = Math.max(1, Number(sourceCensus?.counts?.userCount || users));
  const naturalCounts = {};
  const jointMappedVariants = new Set();
  let jointOrdinal = 0;
  for (const entry of sourceCensus?.jointHistogram || []) {
    const dimensions = entry.dimensions || {};
    const variants = [
      Number(dimensions.active) > 0 ? (dimensions.team ? "ordinary_team_active" :
        "ordinary_classic_active") : null,
      Number(dimensions.pending) > 0 ? "ordinary_pending_accepted" : null,
      Number(dimensions.completed) > 0 ? "ordinary_completed" : null,
      Number(dimensions.invited) > 0 ? "ordinary_invite" : null,
      dimensions.pinned ? (dimensions.team ? "pinned_team" : "pinned_classic") : null,
      Number(dimensions.tournamentInvited) > 0 ? "tournament_invite" : null,
      Number(dimensions.tournamentPending) > 0 ? "tournament_lobby" : null,
      Number(dimensions.tournamentActive) > 0 ? "tournament_between_rounds" : null,
      Number(dimensions.tournamentCompleted) > 0 ? "tournament_completed_non_champion" : null,
      dimensions.tournamentPinned ? "pinned_tournament" : null,
    ].filter(Boolean);
    variants.forEach((variant) => jointMappedVariants.add(variant));
    const scaled = Math.min(users, Math.round(users * Number(entry.users) / sourceUsers));
    for (let ordinal = 0; ordinal < scaled; ordinal += 1) {
      const index = (Math.floor((ordinal + 0.5) * users / Math.max(1, scaled)) +
        jointOrdinal * 17) % users;
      for (const variant of variants) if (!byUser[index].includes(variant)) {
        byUser[index].push(variant);
      }
    }
    jointOrdinal += 1;
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

function materializationPlan({ base, coverage, now = new Date(), runId } = {}) {
  const races = [];
  const participants = [];
  const tournaments = [];
  const tournamentParticipants = [];
  const powerups = [];
  const activeEffects = [];
  const ids = { races: [], raceParticipants: [], tournaments: [],
    tournamentParticipants: [], racePowerups: [], raceActiveEffects: [] };
  const marker = `capacity-races:${runId}`;
  const startedAt = new Date(now.getTime() - 60 * 60_000);
  const endsAt = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
  const completedAt = new Date(now.getTime() - 24 * 60 * 60_000);
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
    const row = { id: crypto.randomUUID(), raceId, participantId: participant.id,
      userId, type: status === "MYSTERY_BOX" ? "MYSTERY_BOX" : type,
      rarity: status === "MYSTERY_BOX" ? null : "COMMON", status,
      earnedAtSteps: 20_000 + index };
    powerups.push(row); ids.racePowerups.push(row.id); return row;
  };
  coverage.byUser.forEach((variants, userIndex) => {
    for (const variant of variants) {
    const caller = base.users[userIndex];
    const support = base.users[(userIndex + 1) % base.users.length];
    const isTournament = variant.startsWith("tournament_") || variant === "pinned_tournament";
    if (!isTournament) {
      const raceId = crypto.randomUUID();
      const teamRace = variant === "ordinary_team_active" || variant === "pinned_team";
      const status = variant === "ordinary_completed" ? "COMPLETED" :
        variant.startsWith("ordinary_pending") || variant === "ordinary_invite" ? "PENDING" : "ACTIVE";
      const callerIsCreator = variant === "ordinary_pending_owner" ||
        variant === "pinned_classic" || variant === "pinned_team";
      const requiresFullEffectRoster = variant.includes("effect") ||
        variant === "ordinary_placement_hidden";
      races.push({ id: raceId, creatorId: callerIsCreator ? caller.id : support.id,
        name: `${marker}:${variant}:${userIndex}`, targetSteps: 1_000_000,
        potCoins: requiresFullEffectRoster ? 1 : 0,
        maxDurationDays: 14, status, startedAt: status === "PENDING" ? null : startedAt,
        endsAt: status === "PENDING" ? null : status === "COMPLETED" ? completedAt : endsAt,
        completedAt: status === "COMPLETED" ? completedAt : null,
        scheduledStartAt: status === "PENDING" ? endsAt : null,
        scheduledEndAt: status === "PENDING" ? new Date(endsAt.getTime() + 24 * 60 * 60_000) : null,
        powerupsEnabled: variant.includes("inventory") || variant.includes("effect") ||
          variant.includes("placement_hidden"), powerupStepInterval: 5000,
        isPublic: variant === "ordinary_classic_active" && userIndex % 10 === 0,
        maxParticipants: teamRace ? 4 : 10, isTeamRace: teamRace,
        teamSize: teamRace ? 2 : null, teamAName: teamRace ? "Trail Blazers" : null,
        teamBName: teamRace ? "Peak Pacers" : null });
      ids.races.push(raceId);
      const callerParticipant = addParticipant({ raceId, userId: caller.id,
        status: variant === "ordinary_invite" ? "INVITED" : "ACCEPTED", index: userIndex,
        favorite: variant.startsWith("pinned_"), team: teamRace ? "TEAM_A" : null,
        placement: status === "COMPLETED" ? 1 : null });
      const supportParticipant = addParticipant({ raceId, userId: support.id,
        index: userIndex + 50_000, team: teamRace ? "TEAM_B" : null,
        placement: status === "COMPLETED" ? 2 : null });
      if (variant === "ordinary_inventory_held_typed") {
        addPowerup({ raceId, participant: callerParticipant, userId: caller.id, index: userIndex });
      } else if (variant === "ordinary_inventory_mystery_box") {
        addPowerup({ raceId, participant: callerParticipant, userId: caller.id,
          status: "MYSTERY_BOX", index: userIndex });
      } else if (variant === "ordinary_inventory_queued_box") {
        addPowerup({ raceId, participant: callerParticipant, userId: caller.id,
          status: "QUEUED", index: userIndex });
      }
      if (variant === "ordinary_effect_positive" || variant === "ordinary_effect_negative" ||
          variant === "ordinary_placement_hidden") {
        const type = variant === "ordinary_effect_positive" ? "RUNNERS_HIGH" :
          variant === "ordinary_placement_hidden" ? "DETOUR_SIGN" : "LEG_CRAMP";
        const powerup = addPowerup({ raceId, participant: supportParticipant,
          userId: support.id, type, status: "USED", index: userIndex });
        const effect = { id: crypto.randomUUID(), raceId,
          targetParticipantId: callerParticipant.id, targetUserId: caller.id,
          sourceUserId: support.id, powerupId: powerup.id, type, status: "ACTIVE",
          startsAt: startedAt, expiresAt: endsAt };
        activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
      }
      continue;
    }

    const tournamentId = crypto.randomUUID();
    const render = variant === "pinned_tournament" ? "lobby" :
      variant.replace(/^tournament_(match_)?/, "");
    const completed = ["champion", "completed_non_champion"].includes(render);
    const pending = ["invite", "lobby"].includes(render);
    const liveMatch = render === "live_match" || variant.startsWith("tournament_match_");
    const tournament = { id: tournamentId, creatorId: support.id,
      name: `${marker}:${variant}:${userIndex}`, status: completed ? "COMPLETED" :
        pending ? "PENDING" : "ACTIVE", bracketSize: 4, matchupDurationDays: 2,
      potCoins: 100, currentRound: pending ? 0 : completed ? 2 : render === "eliminated" ? 2 : 1,
      totalRounds: 2, startedAt: pending ? null : startedAt,
      completedAt: completed ? completedAt : null,
      championUserId: render === "champion" ? caller.id :
        render === "completed_non_champion" ? support.id : null };
    tournaments.push(tournament); ids.tournaments.push(tournamentId);
    const callerTournament = { id: crypto.randomUUID(), tournamentId, userId: caller.id,
      status: render === "invite" ? "INVITED" : "ACCEPTED", seed: render === "invite" ? null : 0,
      eliminatedInRound: render === "eliminated" ? 1 : null,
      favoritedAt: variant === "pinned_tournament" ? now : null };
    const supportTournament = { id: crypto.randomUUID(), tournamentId, userId: support.id,
      status: "ACCEPTED", seed: 1, eliminatedInRound: null };
    tournamentParticipants.push(callerTournament, supportTournament);
    ids.tournamentParticipants.push(callerTournament.id, supportTournament.id);
    if (liveMatch) {
      const raceId = crypto.randomUUID();
      races.push({ id: raceId, creatorId: null,
        name: `${marker}:match:${variant}:${userIndex}`, targetSteps: 1_000_000,
        maxDurationDays: 2, status: "ACTIVE", startedAt, endsAt,
        powerupsEnabled: variant.includes("inventory") || variant.includes("placement_hidden"),
        powerupStepInterval: 5000, isPublic: false, maxParticipants: 2,
        tournamentId, tournamentRound: tournament.currentRound, tournamentMatchIndex: 0 });
      ids.races.push(raceId);
      const callerMatch = addParticipant({ raceId, userId: caller.id, index: userIndex });
      const supportMatch = addParticipant({ raceId, userId: support.id, index: userIndex + 50_000 });
      if (variant === "tournament_match_inventory_held_typed") {
        addPowerup({ raceId, participant: callerMatch, userId: caller.id, index: userIndex });
      } else if (variant === "tournament_match_inventory_mystery_box") {
        addPowerup({ raceId, participant: callerMatch, userId: caller.id,
          status: "MYSTERY_BOX", index: userIndex });
      } else if (variant === "tournament_match_inventory_queued_box") {
        addPowerup({ raceId, participant: callerMatch, userId: caller.id,
          status: "QUEUED", index: userIndex });
      } else if (variant === "tournament_match_placement_hidden") {
        const powerup = addPowerup({ raceId, participant: supportMatch, userId: support.id,
          type: "DETOUR_SIGN", status: "USED", index: userIndex });
        const effect = { id: crypto.randomUUID(), raceId, targetParticipantId: callerMatch.id,
          targetUserId: caller.id, sourceUserId: support.id, powerupId: powerup.id,
          type: "DETOUR_SIGN", status: "ACTIVE", startsAt: startedAt, expiresAt: endsAt };
        activeEffects.push(effect); ids.raceActiveEffects.push(effect.id);
      }
    }
    }
  });
  return { races, participants, tournaments, tournamentParticipants, powerups,
    activeEffects, ids };
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
    tournament_match_placement_hidden: "negativeEffects",
    tournament_match_inventory_held_typed: "heldInventory",
    tournament_match_inventory_mystery_box: "mysteryInventory",
    tournament_match_inventory_queued_box: "queuedInventory",
  };
  return Number(counts[byVariant[variant]] || 0);
}

async function materializeFullPageFixtureGraph({ prisma, runId, base, coverage, now,
  sourceCensus, manifest = base?.manifest } = {}) {
  const plan = materializationPlan({ base, coverage, now, runId });
  for (const [name, values] of Object.entries(plan.ids)) {
    manifest.ids[name] = [...(manifest.ids[name] || []), ...values];
  }
  await createMany(prisma.tournament, plan.tournaments);
  await createMany(prisma.tournamentParticipant, plan.tournamentParticipants);
  await createMany(prisma.race, plan.races);
  await createMany(prisma.raceParticipant, plan.participants);
  await createMany(prisma.racePowerup, plan.powerups);
  await createMany(prisma.raceActiveEffect, plan.activeEffects);
  const augmented = Object.fromEntries(REQUIRED_COVERAGE_VARIANTS.map((variant) => [variant,
    coverage.augmentedByUser.filter((values) => values.includes(variant)).length]));
  return { manifestIds: plan.ids,
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
    (SELECT count(*) FROM race_powerups WHERE status='held') AS "heldInventory",
    (SELECT count(*) FROM race_powerups WHERE status='mystery_box') AS "mysteryInventory",
    (SELECT count(*) FROM race_powerups WHERE status='queued') AS "queuedInventory",
    (SELECT count(*) FROM race_active_effects WHERE status='active_effect'
      AND type IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
        'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS "negativeEffects",
    (SELECT count(*) FROM race_active_effects WHERE status='active_effect'
      AND type NOT IN ('leg_cramp','wrong_turn','detour_sign','rainstorm','quicksand',
        'signal_jammer','leech','trail_mine','drill_sergeant','bounty')) AS "positiveEffects",
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
        AND rp.status='accepted')::int AS active,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='pending'
        AND rp.status='accepted')::int AS pending,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND r.status='completed'
        AND rp.status='accepted')::int AS completed,
      count(*) FILTER (WHERE r.tournament_id IS NULL AND rp.status='invited')::int AS invited,
      bool_or(COALESCE(r.is_team_race,false)) AS team,
      bool_or(rp.favorited_at IS NOT NULL) AS pinned
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
    SELECT p.active,p.pending,p.completed,p.invited,p.team,p.pinned,
      t.tournament_invited,t.tournament_pending,t.tournament_active,t.tournament_completed,
      t.tournament_pinned,count(*)::int AS users
    FROM per_user p JOIN tournament_user t USING(id)
    GROUP BY p.active,p.pending,p.completed,p.invited,p.team,p.pinned,
      t.tournament_invited,t.tournament_pending,t.tournament_active,t.tournament_completed,
      t.tournament_pinned
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('users',users,'dimensions',
      jsonb_build_object('active',active,'pending',pending,'completed',completed,
        'invited',invited,'team',team,'pinned',pinned,
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
    'inventoryPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(*)::int x FROM race_powerups
        GROUP BY race_id) z GROUP BY x) q), '{}'::jsonb),
    'effectsPerRace', COALESCE((SELECT jsonb_object_agg(x::text,n)
      FROM (SELECT x,count(*)::int n FROM (SELECT count(*)::int x FROM race_active_effects
        GROUP BY race_id) z GROUP BY x) q), '{}'::jsonb)
  ) AS "histograms"`);
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
  const result = { schema: "races-tab-source-census-v2",
    sourceTimestamp: sourceTimestamp.toISOString(), counts, jointHistogram,
    graphHistograms: graphs?.histograms || {} };
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
  const byStatus = (values) => values.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1; return result;
  }, {});
  const stableFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ users, races, participants, friendships, tournaments,
      tournamentParticipants, powerups, activeEffects,
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
  const [userRows, raceRows, participantRows, friendshipStateRows, tournamentRows,
    tournamentParticipantRows, powerupRows, activeEffectRows, publicRaceCount] = await Promise.all([
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
    typeof prisma.race.count === "function" ? prisma.race.count({ where: {
      isPublic: true, status: { in: ["PENDING", "ACTIVE"] }, tournamentId: null,
    } }) : 0,
  ]);
  return fixtureStateEvidence({ users: userRows, races: raceRows,
    participants: participantRows, friendships: friendshipStateRows,
    tournaments: tournamentRows, tournamentParticipants: tournamentParticipantRows,
    powerups: powerupRows, activeEffects: activeEffectRows, publicRaceCount });
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
        coverageAugmented: coverage.byUser[index].length > 0 });
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
        coverage,
        contentDistribution: {
          naturallyGenerated: fullPage.naturallyGenerated || {},
          augmented: fullPage.augmented || {},
          sourceZeroVariants: fullPage.sourceZeroVariants || [],
        },
        preScanState,
      },
      cleanupFriendships,
    };
  } catch (error) {
    await cleanupRacesTabOpenFixtures({ prisma, manifest: base.manifest }).catch(() => {});
    throw error;
  }
}

async function cleanupRacesTabOpenFixtures({ prisma, manifest } = {}) {
  const ids = Array.isArray(manifest?.ids?.friendships) ? manifest.ids.friendships : [];
  if (ids.length) await prisma.friendship.deleteMany({ where: { id: { in: ids } } });
  const owned = manifest?.ids || {};
  if (owned.raceActiveEffects?.length) await prisma.raceActiveEffect.deleteMany({
    where: { id: { in: owned.raceActiveEffects } } });
  if (owned.racePowerups?.length) await prisma.racePowerup.deleteMany({
    where: { id: { in: owned.racePowerups } } });
  if (owned.tournamentParticipants?.length) await prisma.tournamentParticipant.deleteMany({
    where: { id: { in: owned.tournamentParticipants } } });
  if (owned.tournaments?.length) {
    await prisma.raceParticipant.deleteMany({ where: { race: {
      tournamentId: { in: owned.tournaments } } } });
    await prisma.race.deleteMany({ where: { tournamentId: { in: owned.tournaments } } });
    await prisma.tournament.deleteMany({ where: { id: { in: owned.tournaments } } });
  }
  let cleanup;
  let cleanupError;
  try { cleanup = await cleanupHomeOpenFixtures({ prisma, manifest }); }
  catch (error) { cleanupError = error; }
  const restoredSettings = await restoreRacesTabSettings({ prisma,
    evidence: manifest?.racesTabPinnedSettings });
  if (cleanupError) throw cleanupError;
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
