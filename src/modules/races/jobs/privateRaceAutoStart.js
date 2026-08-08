const { Race } = require("../models/race");
const { buildStartRace } = require("../commands/startRace");
const { acceptedTeamCounts } = require("../teamRaces");

// ---------------------------------------------------------------------------
// Batch 2026-08-08 item 2 — private races auto-start once every invite is
// resolved.
//
// Two entry points, one predicate:
//   * `maybeAutoStartPrivateRace` — the INLINE hook, called by the join/accept
//     commands AFTER their participant write has committed and (critically)
//     AFTER the `withRaceJoinLock` advisory lock has been released. startRace
//     does per-participant step lookups + updates + push emission; holding the
//     join advisory lock across that is the exact shape of the 3e6c827
//     pool-exhaustion outage, so the hook NEVER runs inside the lock or inside
//     a transaction with the participant write.
//   * `autoStartUnscheduledPrivateRaces` — the CRON backstop, run from the same
//     5-minute tick as autoStartScheduledRaces. It exists because
//     `Race.findScheduledDue` requires `scheduledStartAt: { not: null }`, so an
//     UNSCHEDULED private race is never a candidate there. The backstop also
//     rescues races whose last outstanding invite merely EXPIRED (nobody ever
//     accepts, so no inline hook ever fires) and races too big to start inline.
//
// startRace is always called as the CREATOR (`userId: race.creatorId`), exactly
// like the scheduled cron: passing the accepter's id would mis-attribute the
// RACE_STARTED feed row and push to whoever happened to accept last.
//
// Double-fires are safe: startRace's `updateIfPending` CAS means only one
// runner claims the PENDING -> ACTIVE flip.
// ---------------------------------------------------------------------------

// Latency bound: a big race's start (per-participant step lookup + update +
// push fan-out) must not ride on an accepter's HTTP response on the one-vCPU
// box. Over this many participant rows we skip the inline path entirely and let
// the 5-minute backstop start it.
const MAX_INLINE_PARTICIPANTS = 10;

// Safety bound on the backstop's scan. PENDING private races that never start
// accumulate; newest-first so a fresh "last invite just expired" race is always
// in the window.
const BACKSTOP_SCAN_LIMIT = 500;

// Kill switch. Read at CALL time (never at module load) so it can be flipped on
// a running process and exercised by tests. Matches the `*_DISABLED` idiom in
// src/index.js: the feature is ENABLED unless the env var is exactly "true".
function isPrivateRaceAutoStartDisabled() {
  return process.env.PRIVATE_RACE_AUTOSTART_DISABLED === "true";
}

// An INVITED row only blocks auto-start while its invite is still LIVE. Nothing
// in the system ever transitions an EXPIRED invite out of INVITED, so treating
// every INVITED row as outstanding would let one silent invitee block the race
// forever. A null inviteExpiresAt means "never expires" -> still outstanding.
function isOutstandingInvite(participant, now) {
  if (!participant || participant.status !== "INVITED") return false;
  if (!participant.inviteExpiresAt) return true;
  const expires = new Date(participant.inviteExpiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() > now.getTime();
}

// Pure predicate — the single definition of "this private race is ready to
// start on its own". Shared by the inline hook and the cron backstop.
function shouldAutoStartPrivateRace({ race, now = new Date() }) {
  if (!race) return false;
  if (race.status !== "PENDING") return false;
  // Strict false: a lean select that omitted the column must never be read as
  // "private".
  if (race.isPublic !== false) return false;
  // Seeded challenges renew/start via seededRaceRenewal; tournament matchups
  // are owned by the tournament engine's lifecycle.
  if (race.seedId) return false;
  if (race.tournamentId) return false;

  // A scheduled race keeps its schedule — autoStartScheduledRaces owns it until
  // the scheduled moment passes.
  if (race.scheduledStartAt) {
    const scheduled = new Date(race.scheduledStartAt);
    if (!Number.isNaN(scheduled.getTime()) && scheduled.getTime() > now.getTime()) {
      return false;
    }
  }

  const participants = race.participants || [];
  if (participants.some((p) => isOutstandingInvite(p, now))) return false;

  const acceptedCount = participants.filter((p) => p.status === "ACCEPTED").length;
  if (acceptedCount < 2) return false;

  // Team races: same evenness rule startRace enforces (TEAMS_UNEVEN), evaluated
  // with the very same helper. Uneven -> stay PENDING, silently: the accepter
  // must never see an error for a start that was never their request.
  if (race.isTeamRace) {
    const counts = acceptedTeamCounts(participants);
    if (counts.TEAM_A < 1 || counts.TEAM_B < 1 || counts.TEAM_A !== counts.TEAM_B) {
      return false;
    }
  }

  return true;
}

// The inline hook. ALWAYS resolves to a boolean and NEVER throws: an auto-start
// failure must not fail the join/accept that triggered it (the race simply
// stays PENDING and the creator can still press Start).
function buildMaybeAutoStartPrivateRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  // Built from the SAME dependency bag: a caller that injects fake models (unit
  // tests) gets a startRace wired to those same fakes, never to real prisma.
  const startRace = dependencies.startRace || buildStartRace(dependencies);
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());

  return async function maybeAutoStartPrivateRace({ raceId }) {
    if (isPrivateRaceAutoStartDisabled()) return false;
    if (!raceId) return false;

    try {
      // Fresh read: the caller's copy predates the participant write.
      const race = await raceModel.findById(raceId);
      if (!race) return false;
      if ((race.participants || []).length > MAX_INLINE_PARTICIPANTS) {
        // Too big to start on the request path — the backstop tick will get it.
        return false;
      }
      if (!shouldAutoStartPrivateRace({ race, now: now() })) return false;

      await startRace({ raceId, userId: race.creatorId });
      logger.log(`[AUTOSTART] Private race ${raceId} started (all invites resolved)`);
      return true;
    } catch (error) {
      logger.error(
        `[AUTOSTART] Inline auto-start failed for race ${raceId}:`,
        error?.message || error
      );
      return false;
    }
  };
}

const maybeAutoStartPrivateRace = buildMaybeAutoStartPrivateRace();

// The cron backstop. Returns the ids started this tick.
function buildAutoStartUnscheduledPrivateRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const startRace = dependencies.startRace || buildStartRace(dependencies);
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const limit = dependencies.limit || BACKSTOP_SCAN_LIMIT;

  return async function autoStartUnscheduledPrivateRaces() {
    if (isPrivateRaceAutoStartDisabled()) return [];
    if (typeof raceModel.findUnscheduledPrivatePending !== "function") return [];

    const currentTime = now();
    const candidates =
      (await raceModel.findUnscheduledPrivatePending({ limit })) || [];

    const started = [];
    for (const race of candidates) {
      if (!shouldAutoStartPrivateRace({ race, now: currentTime })) continue;
      try {
        await startRace({ raceId: race.id, userId: race.creatorId });
        started.push(race.id);
        logger.log(`[CRON] Auto-started private race ${race.id} (all invites resolved)`);
      } catch (error) {
        // Legitimate failures exist (payout preset needs 4 accepted, a race
        // that flipped ACTIVE between the read and the start). Log and move on;
        // it stays PENDING and is retried next tick.
        logger.error(
          `[CRON] Failed to auto-start private race ${race.id}:`,
          error?.message || error
        );
      }
    }

    return started;
  };
}

const autoStartUnscheduledPrivateRaces = buildAutoStartUnscheduledPrivateRaces();

module.exports = {
  MAX_INLINE_PARTICIPANTS,
  BACKSTOP_SCAN_LIMIT,
  isPrivateRaceAutoStartDisabled,
  shouldAutoStartPrivateRace,
  buildMaybeAutoStartPrivateRace,
  maybeAutoStartPrivateRace,
  buildAutoStartUnscheduledPrivateRaces,
  autoStartUnscheduledPrivateRaces,
};
