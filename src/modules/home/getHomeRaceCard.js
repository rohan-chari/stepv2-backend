const { prisma: defaultPrisma } = require("../../db");
const { characterPresentation } = require("../cosmetics");
const { compareParticipantsForPlacement } = require("../races/placementOrder");
const { RaceActiveEffect } = require("../powerups/models/raceActiveEffect");
const { Steps } = require("../steps/models/steps");
const { StepSample } = require("../steps/models/stepSample");
const {
  POWERUP_EFFECT_TYPES,
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../races/services/raceStateResolution");
const { prorateSamplesIntoWindow } = require("../steps/models/stepSample");
const { raceTimeZone } = require("../races/raceTimeZone");
const {
  buildTeamsBlock,
  buildTeamsBlockFromParticipants,
} = require("../races/teamRaces");
const { applyLeechTransfers } = require("../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../powerups/hitchhikeCopies");

// The effect types the home card must prefetch. LEECH is included (§5): once
// leech MINTS steps to the attacker, omitting it here made the home-card total
// disagree with race detail (the scoped effect model would either miss it or fall
// back to an N+1 per-participant query). Prefetching LEECH keeps the live home
// total identical to getRaceProgress.
const HOME_EFFECT_TYPES = [...POWERUP_EFFECT_TYPES, "LEECH"];

// Max number of active races returned in the new ACTIVE_RACES (opt-in) state.
const MAX_ACTIVE_RACES = 5;

// The home card's duration label, in hours (spec §5.5).
//
// `maxDurationDays × 24` is only the true length while endsAt is derived from
// it. A custom-window race's persisted duration is the FLOORED day count, so
// that expression under-reports a 30h race as 24h. When the race has actually
// started, the stamped instants are the truth — use them. Otherwise (a PENDING
// invite, where endsAt is null by design) keep the existing expression exactly.
// Purely a label; home_tab.dart reads it defensively already.
function raceDurationHours(race) {
  if (race?.startedAt && race?.endsAt) {
    const ms = new Date(race.endsAt).getTime() - new Date(race.startedAt).getTime();
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / (60 * 60 * 1000));
  }
  return race?.maxDurationDays ? race.maxDurationDays * 24 : null;
}

const USER_SELECT = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  equippedAccessories: {
    select: {
      slot: true,
      // assetKey is what the client uses to resolve the cosmetic PNG; including
      // it lets capybara renders show real equipped cosmetics. Additive only —
      // existing fields are unchanged, so older clients are unaffected.
      shopItem: { select: { id: true, sku: true, slot: true, assetKey: true, renderMetadata: true, bobble: true, testOnly: true, remoteOnly: true, assetVersion: true } },
    },
  },
};

const FRIEND_FINISHED_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

function serializeUser(
  user,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  if (!user) return null;
  return {
    userId: user.id,
    displayName: user.displayName || "Anonymous",
    profilePhotoUrl: user.profilePhotoUrl || null,
    // {animal, accessories} — naked capy for viewers without `characters`.
    ...characterPresentation(
      user,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    ),
  };
}

async function getAcceptedFriendIds(prisma, userId) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: { requesterId: true, addresseeId: true },
  });
  const ids = new Set();
  for (const f of friendships) {
    ids.add(f.requesterId === userId ? f.addresseeId : f.requesterId);
  }
  return [...ids];
}

async function checkPendingInvite(
  prisma,
  userId,
  now,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  const invites = await prisma.raceParticipant.findMany({
    where: {
      userId,
      status: "INVITED",
      race: { status: "PENDING" },
      OR: [
        { inviteExpiresAt: null },
        { inviteExpiresAt: { gt: now } },
      ],
    },
    include: {
      race: {
        include: {
          creator: { select: USER_SELECT },
          participants: {
            select: { id: true, status: true },
          },
        },
      },
    },
    // Nulls last so explicitly-expiring invites surface before legacy ones.
    orderBy: [{ inviteExpiresAt: "asc" }, { joinedAt: "asc" }],
  });

  if (invites.length === 0) return null;

  const primary = invites[0];
  const race = primary.race;

  return {
    state: "PENDING_INVITE",
    pendingInviteCount: invites.length,
    data: {
      raceId: race.id,
      name: race.name,
      durationHours: raceDurationHours(race),
      participantCount: race.participants.length,
      inviter: serializeUser(
        race.creator,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      expiresAt: primary.inviteExpiresAt,
    },
  };
}

async function checkActiveRace(
  prisma,
  userId,
  supportsCharacters = false,
  supportsTeamRaces = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  const myActive = await prisma.raceParticipant.findFirst({
    where: {
      userId,
      status: "ACCEPTED",
      race: {
        status: "ACTIVE",
        // Matchup races are never shown on the home card — only via the
        // tournament screen (§4).
        tournamentId: null,
        // TR-702: an old binary can't render a team race — it would draw one as
        // a broken individual race. Skip team races for those clients (they
        // fall through to the next home state). In practice unreachable: an old
        // client can neither create (TR-106) nor join (TR-703) a team race.
        ...(supportsTeamRaces ? {} : { isTeamRace: false }),
      },
    },
    include: {
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            include: { user: { select: USER_SELECT } },
            orderBy: { totalSteps: "desc" },
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
  });

  if (!myActive) return null;

  const race = myActive.race;
  // TR-702 belt-and-braces: the query above already filters team races out for
  // tokenless clients; never serialize one even if that filter is bypassed.
  if (race.isTeamRace && !supportsTeamRaces) return null;

  const sorted = race.participants;
  const me = sorted.find((p) => p.userId === userId);
  const leader = sorted[0];
  const others = sorted
    .filter((p) => p.userId !== userId && p.userId !== leader?.userId)
    .slice(0, 2);

  let gapText = null;
  if (me && leader && leader.userId !== userId) {
    const gap = leader.totalSteps - me.totalSteps;
    gapText = `${gap.toLocaleString()} steps behind ${leader.user.displayName || "the leader"}`;
  } else if (me && sorted.length > 1) {
    const next = sorted[1];
    const gap = me.totalSteps - (next?.totalSteps || 0);
    gapText = gap > 0 ? `${gap.toLocaleString()} steps ahead. Keep going` : "Tied for the lead";
  } else if (me) {
    gapText = "Leading the race";
  }

  function buildEntry(p) {
    return {
      rank: sorted.indexOf(p) + 1,
      totalSteps: p.totalSteps,
      ...serializeUser(
        p.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
    };
  }

  return {
    state: "ACTIVE_RACE",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      me: me ? buildEntry(me) : null,
      leader: leader ? buildEntry(leader) : null,
      others: others.map(buildEntry),
      // ── Team races (TR-809) — additive. The Home rail draws a compact
      // rope-knot scoreline ("Swift Capys 12,340 — 11,900 Turbo Beavers") from
      // the same canonical `teams` block the list + progress surfaces use.
      // Only ever present for token clients (gated above); individual races
      // keep the byte-identical legacy shape.
      ...(race.isTeamRace
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam: me?.team ?? null,
            teams: buildTeamsBlockFromParticipants(race, sorted),
          }
        : {}),
    },
  };
}

// Cross-participant prefetch: pull step samples, daily rows, and powerup
// effects for ALL participants of ALL the user's active races in three bulk
// queries, then hand the per-participant math (calculateBaseAdjusted /
// calculateCurrentTotal) scoped in-memory models with the SAME interface. The
// helpers run unchanged — same windows, same proration, same rounding — so
// results are identical to the per-participant queries; only the number of
// round-trips changes (~4/person to 3/request). One shared prefetch also
// dedupes users who appear in several of the viewer's races. Any request
// outside the prefetched range (defensive; not expected) falls through to the
// real models, trading speed for correctness.
async function prefetchScopedModels({
  races,
  now,
  stepsModel,
  stepSampleModel,
  raceActiveEffectModel,
}) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const started = races.filter((r) => r.startedAt);
  if (started.length === 0) return null;

  // Samples: every window the helpers ask for starts at/after its race's
  // start (effectiveStart >= startedAt; effect windows live inside the race),
  // so the earliest startedAt covers every race. The forward margin
  // generously covers "today"-capped and active-effect windows.
  const earliestStartMs = Math.min(...started.map((r) => r.startedAt.getTime()));
  const sampleRangeStart = new Date(earliestStartMs);
  const sampleRangeEnd = new Date(now.getTime() + 7 * DAY_MS);
  // Daily rows are keyed by LOCAL date (stored as UTC-midnight of the date
  // string), so pad backwards: a race's local start date can precede the UTC
  // date of startedAt in western time zones.
  const dailyRangeStart = new Date(earliestStartMs - 3 * DAY_MS);
  const dailyRangeEnd = new Date(now.getTime() + 3 * DAY_MS);

  const userIds = [
    ...new Set(started.flatMap((r) => r.participants.map((p) => p.userId))),
  ];
  // Participant ids are globally unique, so effects keyed by participant id
  // alone serve every race from one map.
  const powerupRaces = started.filter((r) => r.powerupsEnabled);
  const participantIds = powerupRaces.flatMap((r) =>
    r.participants.map((p) => p.id)
  );

  const [sampleRows, dailyRows, effectsByParticipant] = await Promise.all([
    stepSampleModel.findRowsForUsersInRange(userIds, sampleRangeStart, sampleRangeEnd),
    stepsModel.findByUserIdsAndDateRange(userIds, dailyRangeStart, dailyRangeEnd),
    participantIds.length > 0
      ? raceActiveEffectModel.findEffectsForRaceParticipantsByTypes(
          powerupRaces.map((r) => r.id),
          participantIds,
          HOME_EFFECT_TYPES
        )
      : Promise.resolve({}),
  ]);

  const samplesByUser = new Map();
  for (const row of sampleRows) {
    let list = samplesByUser.get(row.userId);
    if (!list) samplesByUser.set(row.userId, (list = []));
    list.push(row);
  }
  const dailyByUser = new Map();
  for (const row of dailyRows) {
    let list = dailyByUser.get(row.userId);
    if (!list) dailyByUser.set(row.userId, (list = []));
    list.push(row);
  }

  const sampleStartMs = new Date(sampleRangeStart).getTime();
  const sampleEndMs = sampleRangeEnd.getTime();
  const dailyStartMs = dailyRangeStart.getTime();
  const dailyEndMs = dailyRangeEnd.getTime();
  const prefetchedTypes = new Set(HOME_EFFECT_TYPES);

  const scopedStepSamples = {
    async sumStepsInWindows(userId, windows) {
      if (!windows || windows.length === 0) return [];
      const covered = windows.every((w) => {
        const ws = new Date(w.start).getTime();
        const we = new Date(w.end).getTime();
        return ws >= sampleStartMs && we <= sampleEndMs;
      });
      if (!covered) return stepSampleModel.sumStepsInWindows(userId, windows);
      const rows = samplesByUser.get(userId) || [];
      return windows.map((w) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(w.start).getTime(),
          new Date(w.end).getTime()
        )
      );
    },
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const sums = await this.sumStepsInWindows(userId, [
        { start: windowStart, end: windowEnd },
      ]);
      return sums[0];
    },
    // CLOSED-bucket variant, prefetch-backed. Must exist here or the home card
    // would score effects off open buckets while GET /races/:id/progress scores
    // them off closed ones -- the two paths have to agree.
    async sumClosedStepsInWindows(userId, windows, now) {
      if (!windows || windows.length === 0) return [];
      const covered = windows.every((w) => {
        const ws = new Date(w.start).getTime();
        const we = new Date(w.end).getTime();
        return ws >= sampleStartMs && we <= sampleEndMs;
      });
      if (!covered) return stepSampleModel.sumClosedStepsInWindows(userId, windows, now);
      const nowMs = new Date(now).getTime();
      const rows = (samplesByUser.get(userId) || []).filter(
        (r) => new Date(r.end).getTime() <= nowMs
      );
      return windows.map((w) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(w.start).getTime(),
          new Date(w.end).getTime()
        )
      );
    },
  };

  const scopedSteps = {
    async findByUserIdAndDate(userId, date) {
      const keyMs = new Date(date).getTime();
      if (keyMs < dailyStartMs || keyMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDate(userId, date);
      }
      const rows = dailyByUser.get(userId) || [];
      return rows.find((r) => new Date(r.date).getTime() === keyMs) ?? null;
    },
    async findByUserIdAndDateRange(userId, startDate, endDate) {
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      if (startMs < dailyStartMs || endMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDateRange(userId, startDate, endDate);
      }
      const rows = dailyByUser.get(userId) || [];
      return rows.filter((r) => {
        const ms = new Date(r.date).getTime();
        return ms >= startMs && ms <= endMs;
      });
    },
  };

  const scopedEffects = {
    async findEffectsForRaceByTypes(raceId, targetParticipantId, types) {
      if (!types.every((t) => prefetchedTypes.has(t))) {
        return raceActiveEffectModel.findEffectsForRaceByTypes(
          raceId,
          targetParticipantId,
          types
        );
      }
      const forParticipant = effectsByParticipant[targetParticipantId] || {};
      const byType = {};
      for (const type of types) byType[type] = forParticipant[type] || [];
      return byType;
    },
    async findEffectsForRaceByType(raceId, targetParticipantId, type) {
      if (!prefetchedTypes.has(type)) {
        return raceActiveEffectModel.findEffectsForRaceByType(
          raceId,
          targetParticipantId,
          type
        );
      }
      return (effectsByParticipant[targetParticipantId] || {})[type] || [];
    },
    // Race-level lookups aren't per-participant hot paths; pass through.
    findActiveForRace: (raceId) => raceActiveEffectModel.findActiveForRace(raceId),
  };

  return {
    stepsModel: scopedSteps,
    stepSampleModel: scopedStepSamples,
    raceActiveEffectModel: scopedEffects,
  };
}

// Opt-in (new app builds) only: return ALL of the user's active races as a list
// so the home page can render a horizontally-scrollable row of cards. Each race
// carries its top-3 participants (with equipped cosmetics) and the viewer's own
// placement. Stealth redaction matches getRaceProgress.js: a stealthed racer
// (not self, not finished) is shown as "???" with no cosmetics and null steps.
//
// BACKWARD COMPAT: this path is ONLY reached when the client opts in via the
// `homeActiveRaces` flag. Old app builds never send it, so they keep receiving
// the legacy single-state response (see buildGetHomeRaceCard). When an opted-in
// user has zero active races this returns null and we fall through to the
// existing single-state logic (invites / public / friend prompts).
async function checkActiveRaces(prisma, userId, options = {}) {
  const {
    timeZone = "UTC",
    now = new Date(),
    stepsModel = Steps,
    stepSampleModel = StepSample,
    raceActiveEffectModel = RaceActiveEffect,
    supportsCharacters = false,
    releaseChannel = "prod",
    supportsRemoteAssets = false,
    // TR-809 parity (batch 2026-07-26, B-12d): the ACTIVE_RACES state never
    // emitted `teams`/`isTeamRace`, unlike the legacy single-card path, so on
    // the new home state a team race rendered as an individual ticket with no
    // scoreline. Token-gated exactly like the legacy path.
    supportsTeamRaces = false,
    // §6.3: when true (new client sent homePersistedTotals=1 after a CURRENT
    // sync-v2), build entries from persisted RaceParticipant.totalSteps instead
    // of recomputing live health windows for every participant. Masking,
    // ordering, top-three, placement, and team blocks are unchanged.
    usePersistedTotals = false,
    leanLiveEnabled = false,
  } = options;

  const myActive = await prisma.raceParticipant.findMany({
    where: {
      userId,
      status: "ACCEPTED",
      // Matchup races are surfaced only via the tournament screen (§4).
      race: { status: "ACTIVE", tournamentId: null },
    },
    include: {
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            ...(leanLiveEnabled
              ? {}
              : { include: { user: { select: USER_SELECT } } }),
            orderBy: { totalSteps: "desc" },
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
    take: MAX_ACTIVE_RACES,
  });

  if (!myActive || myActive.length === 0) return null;

  // Prefetch is only possible against the real models (or fakes that opt in);
  // tests inject minimal fakes without the bulk methods and keep the legacy
  // per-participant query path, which is behaviorally identical.
  const canPrefetch =
    !usePersistedTotals &&
    typeof stepSampleModel.findRowsForUsersInRange === "function" &&
    typeof stepsModel.findByUserIdsAndDateRange === "function" &&
    typeof raceActiveEffectModel.findEffectsForRaceParticipantsByTypes ===
      "function";

  // One shared prefetch for every race (null when the injected models are
  // minimal test fakes, or no race has started — the legacy per-participant
  // query path then runs unchanged).
  const scoped = canPrefetch
    ? await prefetchScopedModels({
        races: myActive.map((pt) => pt.race).filter(Boolean),
        now,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
      })
    : null;
  const raceStepsModel = scoped ? scoped.stepsModel : stepsModel;
  const raceStepSampleModel = scoped ? scoped.stepSampleModel : stepSampleModel;
  const raceEffectModel = scoped ? scoped.raceActiveEffectModel : raceActiveEffectModel;

  async function buildRaceEntry(participation) {
    const race = participation.race;
    if (!race) return null;

    // Compute each ACCEPTED participant's LIVE race-relative total using the
    // same side-effect-free helpers the race-detail screen relies on
    // (calculateBaseAdjusted + calculateCurrentTotal from raceStateResolution).
    // This is a READ-ONLY path: we never write total_steps, mark finishers,
    // complete races, emit events, or trigger trail mines. We only compute
    // totals for display so home and detail can't diverge.
    //
    // Finished racers are NOT recomputed — we use their frozen finishTotalSteps
    // (falling back to the live total) exactly as getRaceProgress /
    // raceStateResolution treat finishers.
    const liveTotals = new Map(); // participant.id -> total (live or persisted)
    if (usePersistedTotals) {
      // §6.3 opt-in: use persisted RaceParticipant.totalSteps directly. The
      // uploader's own row was just made current in-band by sync-v2's uploader
      // pass; rival rows may be briefly stale until the durable job's job-success
      // refresh (the accepted, bounded new-client tradeoff, D14). Reads never
      // write totals. Finishers keep their frozen finishTotalSteps.
      for (const p of race.participants) {
        liveTotals.set(
          p.id,
          p.finishedAt ? p.finishTotalSteps ?? p.totalSteps ?? 0 : p.totalSteps ?? 0
        );
      }
    } else if (race.startedAt) {
      // Phase A: per-participant PRE-LEECH total + the leeches targeting them.
      // Finished racers keep their frozen total and take no part in the transfer.
      const preLeech = await Promise.all(
        race.participants.map(async (p) => {
          if (p.finishedAt) {
            return { participant: p, frozen: true, total: p.finishTotalSteps ?? p.totalSteps ?? 0 };
          }
          const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
            participant: p,
            raceStartedAt: race.startedAt,
            // Seeded races bucket in their canonical tz so the home card agrees
            // with the race-detail screen and settlement; user races use the
            // requester's header tz (legacy).
            timeZone: raceTimeZone(race, timeZone),
            stepsModel: raceStepsModel,
            stepSampleModel: raceStepSampleModel,
            now,
          });
          const { total, leechTransfers } = await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant: p,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel: raceEffectModel,
            stepSampleModel: raceStepSampleModel,
            now,
          });
          return { participant: p, frozen: false, preLeechTotal: total, leechTransfers };
        })
      );

      // Phase A2 — HITCHHIKE (§7.3). The home card shows the SAME number race
      // detail does, so the copy has to be folded in here too: a caster with a
      // live link would otherwise see one total on the home card and a larger
      // one in race detail — the live-vs-live divergence the parity rule exists
      // to prevent. Read-only, like everything else on this path.
      const hitchhikeCopies = race.powerupsEnabled
        ? await collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: race.endsAt,
            participants: race.participants,
            raceActiveEffectModel: raceEffectModel,
            stepSampleModel: raceStepSampleModel,
            now,
          })
        : [];

      // Phase B: resolve leech race-wide (zero-sum, deterministic) so the home
      // card's totals match race detail — including the attacker's minted credit.
      const leechFinals = applyLeechTransfers(
        applyHitchhikeCopies(
          preLeech
            .filter((e) => !e.frozen)
            .map((e) => ({
              participantId: e.participant.id,
              userId: e.participant.userId,
              preLeechTotal: e.preLeechTotal,
              leechTransfers: e.leechTransfers,
            })),
          hitchhikeCopies
        )
      );
      for (const e of preLeech) {
        liveTotals.set(
          e.participant.id,
          e.frozen ? e.total : leechFinals.get(e.participant.id) ?? e.preLeechTotal
        );
      }
    } else {
      // No startedAt: cannot window steps; fall back to cached totals so we
      // still render a card rather than crash (defensive).
      for (const p of race.participants) {
        liveTotals.set(
          p.id,
          p.finishedAt ? p.finishTotalSteps ?? p.totalSteps ?? 0 : p.totalSteps ?? 0
        );
      }
    }

    // Project the live totals onto each participant so placement ranking and
    // top-3 step display both read from the same live source. finishedAt is
    // preserved so finishers still sort ahead of unfinished racers.
    const liveParticipants = race.participants.map((p) => ({
      ...p,
      totalSteps: liveTotals.get(p.id) ?? 0,
    }));

    // Sort participants for placement (deterministic, matches getRaces) using
    // the LIVE totals.
    const ranked = [...liveParticipants].sort(compareParticipantsForPlacement);

    if (leanLiveEnabled) {
      const visibleIds = ranked.slice(0, 3).map((participant) => participant.userId);
      const users = visibleIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: visibleIds } },
            select: USER_SELECT,
          })
        : [];
      const userById = new Map(users.map((user) => [user.id, user]));
      for (const participant of ranked.slice(0, 3)) {
        participant.user = userById.get(participant.userId) || null;
      }
    }

    // Determine stealthed user ids for this race (only when powerups enabled).
    const stealthedUserIds = new Set();
    // B-12d: Detour Sign had NO handling here at all, so home kept showing a
    // real placement while the races list and race detail both showed "???".
    let viewerIsDetoured = false;
    if (race.powerupsEnabled) {
      const activeEffects = await raceEffectModel.findActiveForRace(race.id);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") stealthedUserIds.add(e.targetUserId);
        if (e.type === "DETOUR_SIGN" && e.targetUserId === userId) {
          viewerIsDetoured = true;
        }
      }
    }

    const top3 = ranked.slice(0, 3).map((p, idx) => {
      // Detoured viewers see every rival as "???" with no steps, matching
      // getRaceProgress' masking exactly.
      const isStealthed =
        viewerIsDetoured ||
        (stealthedUserIds.has(p.userId) &&
          p.userId !== userId &&
          !p.finishedAt);
      return {
        rank: idx + 1,
        userId: p.userId,
        displayName: isStealthed ? "???" : (p.user?.displayName || "Anonymous"),
        ...(isStealthed
          ? { equippedAccessories: [], animal: null }
          : (() => {
              const { animal, accessories } = characterPresentation(
                p.user,
                supportsCharacters,
                releaseChannel,
                supportsRemoteAssets
              );
              return { equippedAccessories: accessories, animal };
            })()),
        totalSteps: isStealthed ? null : p.totalSteps,
        isStealthed,
      };
    });

    const myIndex = ranked.findIndex((p) => p.userId === userId);
    const userPlacement =
      viewerIsDetoured || myIndex < 0 ? null : myIndex + 1;

    return {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      top3,
      userPlacement,
      // Additive, mirrors GET /races' myPlacementHidden so the client reads one
      // rule everywhere. Frozen clients ignore it and just see no chip.
      userPlacementHidden: viewerIsDetoured,
      participantCount: ranked.length,
      // B-12d: the canonical team block, from the LIVE totals this entry
      // already computed (so it matches the ticket's own numbers), built by the
      // same shared builder every other surface uses.
      ...(race.isTeamRace && supportsTeamRaces
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam:
              race.participants.find((p) => p.userId === userId)?.team ?? null,
            teams: buildTeamsBlock(
              race,
              liveParticipants
                .filter((p) => p.status === "ACCEPTED")
                .map((p) => ({ participant: p, totalSteps: p.totalSteps || 0 }))
            ),
          }
        : {}),
    };
  }

  // Races are independent read-only computations; run them concurrently.
  // Promise.all preserves myActive's order (startedAt desc), matching the
  // sequential loop this replaces.
  const races = (await Promise.all(myActive.map(buildRaceEntry))).filter(
    Boolean
  );

  if (races.length === 0) return null;

  return { state: "ACTIVE_RACES", data: { races } };
}

async function checkFriendRacing(
  prisma,
  userId,
  friendIds,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  if (friendIds.length === 0) return null;

  const friendParticipations = await prisma.raceParticipant.findMany({
    where: {
      userId: { in: friendIds },
      status: "ACCEPTED",
      // Hide friend-racing cards driven by review/demo accounts.
      user: { isReviewAccount: false },
      race: {
        status: "ACTIVE",
        isPublic: true,
        creator: { isReviewAccount: false },
        participants: { none: { userId, status: { in: ["ACCEPTED", "INVITED"] } } },
      },
    },
    include: {
      user: { select: USER_SELECT },
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            include: { user: { select: USER_SELECT } },
            orderBy: { totalSteps: "desc" },
            take: 4,
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
  });

  if (friendParticipations.length === 0) return null;

  // Pick the first valid one whose race still has room.
  const choice = friendParticipations.find(
    (fp) =>
      fp.race.maxParticipants == null ||
      fp.race.participants.length < fp.race.maxParticipants
  );
  if (!choice) return null;

  const race = choice.race;
  return {
    state: "FRIEND_RACING",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      isPublicJoinable: true,
      friend: serializeUser(
        choice.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      participants: race.participants.map((p, idx) => ({
        rank: idx + 1,
        totalSteps: p.totalSteps,
        ...serializeUser(
          p.user,
          supportsCharacters,
          releaseChannel,
          supportsRemoteAssets
        ),
      })),
    },
  };
}

async function checkFriendFinished(
  prisma,
  userId,
  friendIds,
  now,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  if (friendIds.length === 0) return null;

  const cutoff = new Date(now.getTime() - FRIEND_FINISHED_WINDOW_MS);

  const finishers = await prisma.raceParticipant.findMany({
    where: {
      userId: { in: friendIds },
      status: "ACCEPTED",
      placement: { in: [1, 2, 3] },
      race: { status: "COMPLETED", completedAt: { gte: cutoff } },
    },
    include: {
      user: { select: USER_SELECT },
      race: { select: { id: true, name: true, completedAt: true } },
    },
    orderBy: { race: { completedAt: "desc" } },
    take: 1,
  });

  if (finishers.length === 0) return null;
  const finisher = finishers[0];

  return {
    state: "FRIEND_FINISHED",
    data: {
      friend: serializeUser(
        finisher.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      raceName: finisher.race.name,
      placement: finisher.placement,
      finishedAt: finisher.race.completedAt,
    },
  };
}

async function checkPublicRace(prisma, userId) {
  // Active public races the user isn't already in. Prefer DAILY_10K, then WEEKLY_50K, then anything.
  const candidates = await prisma.race.findMany({
    where: {
      status: "ACTIVE",
      isPublic: true,
      // Hide demo-seeded races from real users' home suggestions.
      creator: { isReviewAccount: false },
      participants: { none: { userId, status: { in: ["ACCEPTED", "INVITED"] } } },
    },
    include: {
      seed: { select: { kind: true } },
      _count: { select: { participants: { where: { status: "ACCEPTED" } } } },
    },
    orderBy: { startedAt: "asc" },
    take: 25,
  });

  if (candidates.length === 0) return null;

  // Filter out full races, then rank by seed preference.
  const joinable = candidates.filter(
    (r) => r.maxParticipants == null || r._count.participants < r.maxParticipants
  );
  if (joinable.length === 0) return null;

  const seedRank = { DAILY_10K: 0, WEEKLY_50K: 1 };
  joinable.sort((a, b) => {
    const aRank = a.seed ? (seedRank[a.seed.kind] ?? 2) : 3;
    const bRank = b.seed ? (seedRank[b.seed.kind] ?? 2) : 3;
    return aRank - bRank;
  });

  const race = joinable[0];

  return {
    state: "PUBLIC_RACE",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      participantCount: race._count.participants,
      seedKind: race.seed?.kind || null,
    },
  };
}

function buildGetHomeRaceCard(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const nowFn = dependencies.now || (() => new Date());
  // Step-source models for the live-computation path in checkActiveRaces.
  // Injectable for tests; default to the shared singletons in prod.
  const stepsModel = dependencies.Steps || Steps;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const raceActiveEffectModel = dependencies.RaceActiveEffect || RaceActiveEffect;

  return async function getHomeRaceCard({
    userId,
    homeActiveRaces = false,
    // §6.3: opt-in to persisted-total ACTIVE_RACES cards. Only honored together
    // with homeActiveRaces; ignored otherwise. Old clients never send it.
    homePersistedTotals = false,
    timeZone = "UTC",
    supportsCharacters = false,
    supportsRemoteAssets = false,
    // TR-702/809: whether the caller declared the `team_races` token. Old
    // clients never see a team race on the Home card.
    supportsTeamRaces = false,
    // Batch 2026-07-26, item 8. Defaults to "prod" — a shipped binary never
    // receives a test-only assetKey it does not bundle.
    releaseChannel = "prod",
    leanLiveEnabled = false,
  }) {
    const now = nowFn();

    const pending = await checkPendingInvite(
      prisma,
      userId,
      now,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
    if (pending) return pending;

    // Opt-in path (new app builds): when the client requests homeActiveRaces and
    // the user has >=1 active race, return the new ACTIVE_RACES list state. When
    // the opted-in user has NO active races, checkActiveRaces returns null and we
    // fall through to the legacy single-state logic below. Old clients never set
    // this flag, so they always get the legacy ACTIVE_RACE single-card response
    // (byte-for-byte unchanged).
    if (homeActiveRaces) {
      const activeRaces = await checkActiveRaces(prisma, userId, {
        timeZone,
        now,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets,
        supportsTeamRaces,
        usePersistedTotals: homePersistedTotals,
        leanLiveEnabled,
      });
      if (activeRaces) return activeRaces;
    } else {
      const active = await checkActiveRace(
        prisma,
        userId,
        supportsCharacters,
        supportsTeamRaces,
        releaseChannel,
        supportsRemoteAssets
      );
      if (active) return active;
    }

    const friendIds = await getAcceptedFriendIds(prisma, userId);

    const friendRacing = await checkFriendRacing(
      prisma,
      userId,
      friendIds,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
    if (friendRacing) return friendRacing;

    const friendFinished = await checkFriendFinished(
      prisma,
      userId,
      friendIds,
      now,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
    if (friendFinished) return friendFinished;

    const publicRace = await checkPublicRace(prisma, userId);
    if (publicRace) return publicRace;

    return { state: "EMPTY", data: {} };
  };
}

const getHomeRaceCard = buildGetHomeRaceCard();

module.exports = { buildGetHomeRaceCard, getHomeRaceCard };
