// Ranked v2 cohort engine: weekly enrollment, mid-week joins, and live
// standings. Score = raw weekly step total from existing Step rows (no new
// write path). Used by the computeRankedWeeks job (provisional) and the
// settleRankedWeek command (final).

const { prisma } = require("../../../db");
const { Steps: defaultSteps } = require("../../steps/models/steps");
const {
  RankedWeek: defaultRankedWeek,
  RankedCohort: defaultRankedCohort,
  RankedCohortMember: defaultRankedCohortMember,
} = require("../models/rankedWeek");
const {
  DEFAULT_TIER,
  COHORT_TARGET_SIZE,
  COHORT_MAX_SIZE,
  COHORT_REBALANCE_WINDOW_MS,
  ACTIVE_DAY_FLOOR,
  V2_TIER_KEYS,
} = require("../constants/rankedCohorts");

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Per-user weekly totals from step rows: Map userId -> {weeklySteps, activeDays}.
function summarizeWeekRows(rows) {
  const byUser = new Map();
  for (const row of rows) {
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = { weeklySteps: 0, activeDays: 0 };
      byUser.set(row.userId, entry);
    }
    entry.weeklySteps += row.steps || 0;
    if ((row.steps || 0) >= ACTIVE_DAY_FLOOR) entry.activeDays += 1;
  }
  return byUser;
}

// Deterministic cohort ranking: steps desc, userId asc tiebreak. Returns the
// members with a 1-based `rank` attached (does not mutate the input).
function rankCohortMembers(members, totalsByUser) {
  return members
    .map((m) => {
      const totals = totalsByUser.get(m.userId) || {
        weeklySteps: 0,
        activeDays: 0,
      };
      return { ...m, weeklySteps: totals.weeklySteps, activeDays: totals.activeDays };
    })
    .sort(
      (a, b) => b.weeklySteps - a.weeklySteps || a.userId.localeCompare(b.userId)
    )
    .map((m, index) => ({ ...m, rank: index + 1 }));
}

// Split n users into balanced cohorts of ~target: ceil(n/target) cohorts whose
// sizes differ by at most 1. Input order is preserved (callers pass users
// sorted by prior-week steps so cohorts come out step-matched).
function chunkIntoCohorts(userIds, target = COHORT_TARGET_SIZE) {
  const n = userIds.length;
  if (n === 0) return [];
  const numCohorts = Math.ceil(n / target);
  const baseSize = Math.floor(n / numCohorts);
  const remainder = n % numCohorts;
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < numCohorts; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    chunks.push(userIds.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

function normalizeTier(tierKey) {
  return V2_TIER_KEYS.includes(tierKey) ? tierKey : DEFAULT_TIER;
}

async function defaultGetUserTiersV2(userIds) {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, rankedTierV2: true },
  });
  return new Map(users.map((u) => [u.id, normalizeTier(u.rankedTierV2)]));
}

// ── Enrollment (weekly rollover) ─────────────────────────────────────────────

// Build the new week's cohorts from everyone active (>= 1 active day) in the
// previous window. Within a tier, users are sorted by prior-week steps so each
// cohort is roughly step-matched. Users who only become active mid-week are
// added later by placeNewParticipants on the standings tick.
async function enrollWeek({
  week,
  previousWindow, // { startsOn, endsOn } to source activity + step-matching from
  Steps = defaultSteps,
  RankedCohort = defaultRankedCohort,
  RankedCohortMember = defaultRankedCohortMember,
  getUserTiers = defaultGetUserTiersV2,
}) {
  const prevRows = await Steps.findRowsInRange(
    previousWindow.startsOn,
    previousWindow.endsOn
  );
  const prevTotals = summarizeWeekRows(prevRows);

  const activeUserIds = [...prevTotals.entries()]
    .filter(([, t]) => t.activeDays >= 1)
    .sort(
      (a, b) =>
        b[1].weeklySteps - a[1].weeklySteps || a[0].localeCompare(b[0])
    )
    .map(([userId]) => userId);

  const tierByUser = await getUserTiers(activeUserIds);
  const byTier = new Map();
  for (const userId of activeUserIds) {
    const tier = tierByUser.get(userId) || DEFAULT_TIER;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(userId); // keeps the steps-desc order within tier
  }

  let cohorts = 0;
  let members = 0;
  for (const [tier, userIds] of byTier) {
    for (const chunk of chunkIntoCohorts(userIds)) {
      const cohort = await RankedCohort.create({ weekId: week.id, tier });
      await RankedCohortMember.createMany(
        chunk.map((userId) => ({
          weekId: week.id,
          cohortId: cohort.id,
          userId,
          tier,
        }))
      );
      cohorts += 1;
      members += chunk.length;
    }
  }
  return { cohorts, members };
}

// ── Mid-week joins ───────────────────────────────────────────────────────────

// Anyone with step activity this week who isn't in a cohort yet gets placed.
// Early in the week (within COHORT_REBALANCE_WINDOW_MS of the start) we re-chunk
// each affected tier — existing members + newcomers — into even, step-matched
// cohorts, so a wave of newcomers can't leave a lopsided 35/2 split. Past that
// window we only place the newcomers into their tier's emptiest cohort with
// headroom (or a fresh one) and never move someone already competing.
async function placeNewParticipants({
  week,
  totalsByUser,
  existingMembers,
  RankedCohort = defaultRankedCohort,
  RankedCohortMember = defaultRankedCohortMember,
  getUserTiers = defaultGetUserTiersV2,
  now = new Date(),
}) {
  const memberIds = new Set(existingMembers.map((m) => m.userId));
  const newcomers = [...totalsByUser.keys()].filter((id) => !memberIds.has(id));
  if (newcomers.length === 0) return [];

  const tierByUser = await getUserTiers(newcomers);

  const elapsed = now.getTime() - new Date(week.startsOn).getTime();
  if (elapsed <= COHORT_REBALANCE_WINDOW_MS) {
    return rebalanceTiersForNewcomers({
      week,
      newcomers,
      tierByUser,
      existingMembers,
      totalsByUser,
      RankedCohort,
      RankedCohortMember,
    });
  }
  return appendNewcomers({
    week,
    newcomers,
    tierByUser,
    RankedCohort,
    RankedCohortMember,
  });
}

// Early-week path: for each tier that gained newcomers, re-chunk its full
// membership into balanced, step-matched cohorts. Existing cohort rows are
// reused (and members reassigned in place); new cohorts are created only when
// the tier genuinely needs more. Tiers with no newcomers are left untouched.
async function rebalanceTiersForNewcomers({
  week,
  newcomers,
  tierByUser,
  existingMembers,
  totalsByUser,
  RankedCohort,
  RankedCohortMember,
}) {
  const stepsOf = (userId) => (totalsByUser.get(userId) || {}).weeklySteps || 0;

  const newcomersByTier = new Map();
  for (const userId of newcomers) {
    const tier = tierByUser.get(userId) || DEFAULT_TIER;
    if (!newcomersByTier.has(tier)) newcomersByTier.set(tier, []);
    newcomersByTier.get(tier).push(userId);
  }

  const existingByTier = new Map();
  for (const m of existingMembers) {
    if (!existingByTier.has(m.tier)) existingByTier.set(m.tier, []);
    existingByTier.get(m.tier).push(m);
  }

  const cohortsByTier = new Map();
  for (const c of await RankedCohort.listForWeek(week.id)) {
    if (!cohortsByTier.has(c.tier)) cohortsByTier.set(c.tier, []);
    cohortsByTier.get(c.tier).push(c);
  }

  const placed = [];
  for (const [tier, tierNewcomers] of newcomersByTier) {
    // Combined, step-matched roster (existing members carry their cohort so we
    // can skip no-op moves; newcomers have no row yet).
    const roster = [
      ...(existingByTier.get(tier) || []).map((m) => ({
        userId: m.userId,
        steps: m.weeklySteps || 0,
        memberId: m.id,
        currentCohortId: m.cohortId,
      })),
      ...tierNewcomers.map((userId) => ({
        userId,
        steps: stepsOf(userId),
        memberId: null,
        currentCohortId: null,
      })),
    ].sort((a, b) => b.steps - a.steps || a.userId.localeCompare(b.userId));

    const chunks = chunkIntoCohorts(roster);

    // Reuse existing cohort rows (deterministic order); open more if needed.
    const cohorts = (cohortsByTier.get(tier) || [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    while (cohorts.length < chunks.length) {
      cohorts.push(await RankedCohort.create({ weekId: week.id, tier }));
    }

    for (let i = 0; i < chunks.length; i++) {
      const cohortId = cohorts[i].id;
      for (const entry of chunks[i]) {
        if (entry.memberId) {
          if (entry.currentCohortId !== cohortId) {
            await RankedCohortMember.reassignCohort({ id: entry.memberId, cohortId });
          }
        } else {
          await RankedCohortMember.createMany([
            { weekId: week.id, cohortId, userId: entry.userId, tier },
          ]);
          placed.push({ userId: entry.userId, cohortId, tier });
        }
      }
    }
  }
  return placed;
}

// Late-week path: place each newcomer into their tier's emptiest cohort with
// headroom (under the hard max), or a fresh one. Never moves existing members.
async function appendNewcomers({
  week,
  newcomers,
  tierByUser,
  RankedCohort,
  RankedCohortMember,
}) {
  const cohorts = await RankedCohort.listForWeek(week.id);
  const countByCohort = new Map(cohorts.map((c) => [c.id, c._count.members]));
  const cohortsByTier = new Map();
  for (const c of cohorts) {
    if (!cohortsByTier.has(c.tier)) cohortsByTier.set(c.tier, []);
    cohortsByTier.get(c.tier).push(c);
  }

  const placed = [];
  for (const userId of newcomers) {
    const tier = tierByUser.get(userId) || DEFAULT_TIER;
    const candidates = (cohortsByTier.get(tier) || [])
      .filter((c) => (countByCohort.get(c.id) || 0) < COHORT_MAX_SIZE)
      .sort(
        (a, b) => (countByCohort.get(a.id) || 0) - (countByCohort.get(b.id) || 0)
      );

    let cohort = candidates[0];
    if (!cohort) {
      cohort = await RankedCohort.create({ weekId: week.id, tier });
      countByCohort.set(cohort.id, 0);
      if (!cohortsByTier.has(tier)) cohortsByTier.set(tier, []);
      cohortsByTier.get(tier).push(cohort);
    }

    await RankedCohortMember.createMany([
      { weekId: week.id, cohortId: cohort.id, userId, tier },
    ]);
    countByCohort.set(cohort.id, (countByCohort.get(cohort.id) || 0) + 1);
    placed.push({ userId, cohortId: cohort.id, tier });
  }
  return placed;
}

// ── Live standings ───────────────────────────────────────────────────────────

// Refresh weekly totals + provisional ranks for every cohort in the week, and
// pull in mid-week joiners. Returns { members, placed } counts.
async function recomputeWeekStandings({
  week,
  Steps = defaultSteps,
  RankedCohort = defaultRankedCohort,
  RankedCohortMember = defaultRankedCohortMember,
  getUserTiers = defaultGetUserTiersV2,
  now = new Date(),
}) {
  const rows = await Steps.findRowsInRange(week.startsOn, week.endsOn);
  const totalsByUser = summarizeWeekRows(rows);

  let members = await RankedCohortMember.listForWeek(week.id);
  const placed = await placeNewParticipants({
    week,
    totalsByUser,
    existingMembers: members,
    RankedCohort,
    RankedCohortMember,
    getUserTiers,
    now,
  });
  if (placed.length > 0) {
    members = await RankedCohortMember.listForWeek(week.id);
  }

  const byCohort = new Map();
  for (const m of members) {
    if (!byCohort.has(m.cohortId)) byCohort.set(m.cohortId, []);
    byCohort.get(m.cohortId).push(m);
  }

  for (const cohortMembers of byCohort.values()) {
    const originals = new Map(cohortMembers.map((m) => [m.id, m]));
    const ranked = rankCohortMembers(cohortMembers, totalsByUser);
    for (const m of ranked) {
      const before = originals.get(m.id);
      if (
        before.weeklySteps !== m.weeklySteps ||
        before.provisionalRank !== m.rank
      ) {
        await RankedCohortMember.writeProvisional({
          id: m.id,
          weeklySteps: m.weeklySteps,
          provisionalRank: m.rank,
        });
      }
    }
  }

  return { members: members.length, placed: placed.length, totalsByUser };
}

module.exports = {
  summarizeWeekRows,
  rankCohortMembers,
  chunkIntoCohorts,
  normalizeTier,
  enrollWeek,
  placeNewParticipants,
  recomputeWeekStandings,
};
