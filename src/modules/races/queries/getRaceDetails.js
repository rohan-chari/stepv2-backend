const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { characterPresentation } = require("../../cosmetics");
const { acceptedTeamCounts } = require("../teamRaces");
const {
  clampOffsetLimit,
} = require("../../../shared/pagination/clampOffsetLimit");
const { roundLabel } = require("../../tournaments/constants/tournaments");
const { isTournamentParticipant } = require("../../tournaments/services/tournamentAccess");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../racePrizePool");
const { getRaceLeaveAction } = require("../services/raceLeaveAction");
const { canReadRacePreview } = require("../services/canReadRacePreview");

// The JS twin of the model's `detailsParticipantOrder` ([joinedAt asc, id asc]).
// Used only when a page is sliced out of a preloaded race instead of taken by
// the database, so both paths hand a client the same page for the same offset.
// `id` is a cuid (lowercase alphanumeric), so a plain string compare matches
// Postgres's ordering of the same column.
function byJoinedAtThenId(a, b) {
  const aJoined = a.joinedAt ? new Date(a.joinedAt).getTime() : 0;
  const bJoined = b.joinedAt ? new Date(b.joinedAt).getTime() : 0;
  if (aJoined !== bJoined) return aJoined - bJoined;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// `releaseChannel` (batch 2026-07-26, item 8) is trailing + optional and
// defaults to "prod", so every existing caller keeps byte-identical behaviour.
async function getRaceDetails(
  userId,
  raceId,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  // Trailing capability gate: frozen callers retain their exact payload.
  supportsRaceLeave = false,
  supportsTeamRaces = false,
  // A frozen/tokenless client cannot render a private bucket card. Return the
  // same non-revealing absence it gets for an unknown race, even if it is a
  // participant, rather than leaking a private race id through detail.
  supportsBuckets = false,
  preloadedRace = null,
  // Pagination inputs arrive as ONE trailing options object, by name. This
  // signature already carries nine positional parameters; adding a tenth,
  // eleventh and twelfth would make every future call site a counting exercise.
  //
  //   pagination.capable -> the client advertised `race_participants_paging`
  //   pagination.view    -> the client sent `view=participants-v1`
  //
  // Both are required for the array to actually be sliced. Gating on the query
  // param alone would be a compat break: the build in the field TODAY already
  // sends `view=participants-v1` (it means it for `progress`) while still
  // scanning the whole race.participants array for membership and counts.
  //
  //   previewViewer      -> the client advertised `race_preview`. A BOOLEAN,
  //                         computed in routes.js from req.clientFeatures; the
  //                         feature set itself is deliberately not threaded into
  //                         the query layer. It only ENABLES the public-preview
  //                         carve-out below — the flag and the race's own
  //                         public/non-tournament shape still have to agree.
  { pagination = null, previewViewer = false } = {}
) {
  const pagingCapable = pagination?.capable === true;
  const pagingRequested =
    pagingCapable && pagination?.view === "participants-v1";

  const notFound = () => {
    const error = new Error("Race not found");
    error.statusCode = 404;
    return error;
  };

  let race;
  // Every non-cosmetic consumer (counts, money, ids) reads `summaryRows`; only
  // the serialized array reads `serializedRows`. On the unpaginated path they
  // are the same array, which is why that path cannot change behaviour.
  let summaryRows;
  let serializedRows;
  let myParticipant;
  let participantsPagination = null;

  // A preload is ONLY passed by the bootstrap handler's ACTIVE branch, where it
  // is getRaceProgress's `Race.findById` result — byte for byte the same fat
  // read (same cosmetic include) the unpaged path below runs. That read has
  // already happened on that request, so the lean plan cannot avoid it there; it
  // would only add ~11 queries on top. When a preload exists, reuse it and take
  // the page with a JS sort+slice. Everywhere else (legacy GET /:raceId, the
  // bootstrap non-ACTIVE branch) there is no preload and the lean DB-level plan
  // is the real win.
  const sliceFromPreload = pagingRequested && preloadedRace != null;

  if (pagingRequested && !sliceFromPreload) {
    race = await Race.findDetailsCore(raceId);
    if (!race) throw notFound();
    if (race.seededBucketId && !supportsBuckets) {
      const error = notFound();
      error.code = "RACE_NOT_FOUND";
      throw error;
    }
    const [mine, summaries] = await Promise.all([
      RaceParticipant.findByRaceAndUser(raceId, userId),
      Race.findDetailsParticipantSummaries(raceId),
    ]);
    myParticipant = mine || undefined;
    summaryRows = summaries;
  } else {
    race = preloadedRace || (await Race.findById(raceId));
    if (!race) throw notFound();
    if (race.seededBucketId && !supportsBuckets) {
      const error = notFound();
      error.code = "RACE_NOT_FOUND";
      throw error;
    }
    summaryRows = race.participants;
    if (sliceFromPreload) {
      // `participantInclude` orders by joinedAt ALONE — no tiebreak — so a
      // seeded bulk-enrol (every row tied to the same instant) has no stable
      // order at all. The lean plan's pages are ordered (joinedAt ASC, id ASC);
      // a JS-sliced page must honour the identical contract or a client walking
      // offsets would duplicate and skip rows. Copied, never sorted in place:
      // the caller's preload is getRaceProgress's own race object.
      summaryRows = [...summaryRows].sort(byJoinedAtThenId);
    }
    myParticipant = summaryRows.find((p) => p.userId === userId);
  }
  // Always the whole field until (and unless) the paging block below replaces it
  // with a page, so there is exactly one place that can truncate the response.
  serializedRows = summaryRows;

  // Declining revokes access: the decliner is treated like a non-participant
  // instead of getting a read-only ghost view of the race.
  //
  // Drives the financial redaction below. TRUE only on the NEW public-preview
  // branch — the long-shipped tournament-spectate branch keeps serving its
  // buyIn/payout fields exactly as it does in production today.
  let isPublicPreview = false;
  if (!myParticipant || myParticipant.status === "DECLINED") {
    // Cheap, purely in-memory checks first (and the two branches are mutually
    // exclusive: the preview predicate returns false whenever tournamentId is
    // set, which is the only case canSpectate can be true). Asking about the
    // preview first is what keeps the spectate branch's DB round trip off the
    // common public-race path.
    isPublicPreview = await canReadRacePreview({
      race,
      myParticipant,
      previewViewer,
    });
    if (!isPublicPreview) {
      // Tournament spectating: any ACCEPTED bracket player (including
      // eliminated) may READ a matchup race they aren't in. Read-only — no write
      // path is relaxed here. Non-tournament races and non-participants still
      // 403.
      const canSpectate =
        race.tournamentId != null &&
        (await isTournamentParticipant(race.tournamentId, userId));
      if (!canSpectate) {
        const error = new Error("You are not a participant in this race");
        error.statusCode = 403;
        throw error;
      }
    }
  }

  if (pagingRequested) {
    const { start, safeLimit, hasMore, nextOffset } = clampOffsetLimit({
      offset: pagination.offset,
      limit: pagination.limit,
      total: summaryRows.length,
    });
    serializedRows = sliceFromPreload
      ? // Already sorted (joinedAt ASC, id ASC) above, so this slice returns
        // exactly the rows findDetailsParticipantPage would have, cosmetics
        // included — the preload hydrates them for the whole field.
        summaryRows.slice(start, start + safeLimit)
      : await Race.findDetailsParticipantPage(raceId, {
          skip: start,
          take: safeLimit,
        });
    participantsPagination = {
      offset: start,
      limit: safeLimit,
      total: summaryRows.length,
      hasMore,
      nextOffset,
    };
  } else if (pagingCapable) {
    // The token was sent but no page was asked for (or `view` was something
    // else). Report "I returned everything" — mirroring getRaceProgress's
    // non-pageable branch — so a capable client can tell a whole answer from a
    // server that ignored its paging request, without inferring it from length.
    // `limit` is contractually 1..50, so it is floored at 1 even here: a race
    // with zero participant rows (a tournament spectator reading a matchup
    // whose rows were pruned) would otherwise report limit 0 and make a client
    // computing ceil(total / limit) divide by zero.
    participantsPagination = {
      offset: 0,
      limit: Math.max(summaryRows.length, 1),
      total: summaryRows.length,
      hasMore: false,
      nextOffset: summaryRows.length,
    };
  }

  // ── Response ordering rule ────────────────────────────────────────────────
  // Everything below this line derives from `summaryRows` (the FULL field) and
  // the `myParticipant` lookup — never from `serializedRows`, which may be one
  // page. Slicing is the last thing that happens to the response, not the first
  // thing that happens to the data: a page must never move a prize number.
  const acceptedCount = summaryRows.filter(
    (p) => p.status === "ACCEPTED"
  ).length;
  const teamCounts =
    race.isTeamRace === true ? acceptedTeamCounts(summaryRows) : null;
  // Legacy buy-in pot OR app-funded prize pool, decided by race.fundedPrize.
  // Projected from the current field; a funded race's final pool is recomputed
  // from actual finishers at settlement and then stamped (completeRace).
  const money = buildRaceMoneyView({
    race,
    participants: summaryRows,
    acceptedCount,
  });
  const { payouts: legacyPayouts, payoutTiers } = serializePayouts(money.payouts);

  const result = {
    id: race.id,
    name: race.name,
    // Seed kind for the auto-generated daily/weekly public challenges (null for
    // user-created races). Additive: older clients ignore the field; newer ones
    // use it to show a clean "Daily/Weekly Challenge" label in the header.
    seedKind: race.seed?.kind || null,
    status: race.status,
    creationSource: race.creationSource ?? null,
    startPolicy: race.startPolicy ?? null,
    maxDurationDays: race.maxDurationDays,
    targetSteps: race.targetSteps, // 1.1.4 compat
    buyInAmount: money.buyInAmount,
    payoutPreset: race.payoutPreset,
    potCoins: money.potCoins,
    heldPotCoins: money.heldPotCoins,
    projectedPotCoins: money.projectedPotCoins,
    // App-funded prize pool (additive). null for a legacy buy-in race, in which
    // case the client renders today's buy-in/pot UI unchanged.
    prizePool: money.prizePool,
    // Legacy three-place shape, kept for app builds that predate payoutTiers.
    // They read first/second/third and only ever show the podium, which degrades
    // gracefully for the field-scaled presets (they just don't see places 4+).
    payouts: legacyPayouts,
    // Full payout breakdown, one entry per paid place (placement 1..N). Newer app
    // builds render this; older ones ignore it and fall back to `payouts` above.
    payoutTiers,
    // Minted reward for seeded races (no buy-in). null when the race pays no
    // finish reward. Additive: older clients ignore the field.
    finishReward: money.finishReward,
    startedAt: race.startedAt,
    endsAt: race.endsAt,
    completedAt: race.completedAt,
    creator: race.creator,
    winner: race.winner,
    isCreator: race.creatorId === userId,
    isPublic: race.isPublic || false,
    // null => unlimited (no cap). Older app clients read this defensively
    // (int? ?? 10) so they show a finite figure but never crash.
    maxParticipants: race.maxParticipants ?? null,
    powerupsEnabled: race.powerupsEnabled || false,
    powerupStepInterval: race.powerupStepInterval,
    // myParticipant is undefined for a tournament spectator (viewer isn't in
    // this matchup) — every "my*" field degrades safely, which is how the client
    // detects read-only spectate mode.
    myStatus: myParticipant?.status ?? null,
    myChatMuted: myParticipant?.chatMuted || false,
    // Per-race placement-alert opt-out. Defaulted false so old app builds that
    // don't read this key are unaffected; the new build renders the mute toggle.
    myPlacementAlertsMuted: myParticipant?.placementAlertsMuted || false,
    myLastReadRaceChatAt: myParticipant?.lastReadRaceChatAt ?? null,
    participants: serializedRows.map((p) => ({
      id: p.id,
      userId: p.userId,
      displayName: p.user.displayName,
      profilePhotoUrl: p.user.profilePhotoUrl,
      // {animal, accessories} — naked capy for viewers without `characters`.
      ...characterPresentation(
        p.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      status: p.status,
      totalSteps: p.totalSteps,
      finishedAt: p.finishedAt,
      joinedAt: p.joinedAt,
      // Financial redaction for a public-preview viewer. These three are the
      // only fields in this payload the public race listing does not already
      // expose, so lifting the 403 without nulling them would be a NEW leak of
      // every participant's stake and winnings to any stranger browsing the
      // public list. There is no "my own row" to exempt: a preview viewer has
      // no participant row at all. Null (never omitted) so a defensive client
      // read cannot tell a missing key from a null value.
      buyInAmount: isPublicPreview ? null : p.buyInAmount,
      buyInStatus: isPublicPreview ? null : p.buyInStatus,
      payoutCoins: isPublicPreview ? null : p.payoutCoins,
      // Team races (additive; null on individual races). The lobby renders the
      // two-column face-off from `team`; forfeitedAt marks frozen members.
      team: p.team ?? null,
      forfeitedAt: p.forfeitedAt ?? null,
    })),
    createdAt: race.createdAt,
    // ── Team races (TR-101/402; additive — old clients ignore these and never
    // receive a team race in their lists anyway).
    isTeamRace: race.isTeamRace === true,
    teamSize: race.teamSize ?? null,
    teamAName: race.teamAName ?? null,
    teamBName: race.teamBName ?? null,
    winnerTeam: race.winnerTeam ?? null,
    myTeam: myParticipant?.team ?? null,
    myForfeitedAt: myParticipant?.forfeitedAt ?? null,
    // ── Tournament matchup context (additive; null on ordinary races). The
    // frontend reads these defensively to show the "🏆 {round} — {name}" banner.
    tournamentId: race.tournamentId ?? null,
    tournamentRound: race.tournamentRound ?? null,
    tournamentRoundLabel:
      race.tournamentId && race.tournament
        ? roundLabel(race.tournament.bracketSize, race.tournamentRound)
        : null,
    tournamentName: race.tournament?.name ?? null,
    // ── Summary fields (additive, ALWAYS present regardless of capability or
    // view). They exist so a client never has to scan `participants` for a
    // count — which is what makes truncating that array safe. A frozen build
    // ignores them; the new build reads them instead of counting rows.
    acceptedCount,
    // Only meaningful on a team race; null elsewhere so a client can tell
    // "not a team race" from "zero on that side".
    teamAAcceptedCount: teamCounts ? teamCounts.TEAM_A : null,
    teamBAcceptedCount: teamCounts ? teamCounts.TEAM_B : null,
    // The viewer's own row is NOT guaranteed to be in any returned page, so
    // every "my own data" need must be served from up here. Null (never
    // omitted) when unavailable, so a defensive Dart read never has to
    // distinguish a missing key from a null value.
    myTotalSteps: myParticipant?.totalSteps ?? null,
  };
  if (participantsPagination) {
    result.participantsPagination = participantsPagination;
  }
  if (pagingRequested) {
    // Only when the array is actually truncated: a client with the whole array
    // already has these ids, and duplicating them would cost payload for
    // nothing. Bare id strings (~17KB at 477 participants) rather than the
    // ~66KB of full profiles they replace.
    //
    // DELIBERATE: this is every participant ROW, including DECLINED ones —
    // exact parity with the full-array scan the client does today, so switching
    // a consumer to this field cannot change its answer. The known consumer is
    // _inviteMore()'s "already in this race" filter, which therefore keeps
    // NOT re-offering someone who declined, exactly as it behaves today.
    // Changing that is a product decision, not a side effect of paging.
    result.participantUserIds = summaryRows.map((p) => p.userId);
  }
  // Omitted for clients that did not advertise the protocol, preserving their
  // historical detail shape. Capable clients receive null or a known action.
  if (supportsRaceLeave || supportsTeamRaces) {
    result.leaveAction = getRaceLeaveAction({
      race,
      participant: myParticipant,
      supportsRaceLeave,
      supportsTeamRaces,
    });
  }
  return result;
}

module.exports = { getRaceDetails };
