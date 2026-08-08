const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Notification } = require("../../notifications");
const { eventBus } = require("../../../shared/events/eventBus");
const { resolveRaceState } = require("../services/raceStateResolution");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const {
  computeRacePayouts,
  computeFundedPayouts,
} = require("../racePayoutPresets");
const { computePrizePool } = require("../../../shared/economy/prizePool");
const { compareParticipantsForPlacement } = require("../placementOrder");
const { raceTimeZone } = require("../raceTimeZone");

// Team-race slacker nudge (TR-683): gentle, fires only inside the final 12h,
// to a member contributing < 25% of their team's per-member average (average
// over NON-FORFEITED members only), at most once per race per member.
const SLACKER_WINDOW_MS = 12 * 60 * 60 * 1000;
const SLACKER_FRACTION = 0.25;
const SLACKER_PUSH_TYPE = "TEAM_SLACKER_NUDGE";

const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Race-ending-soon reminder (§8): one push per active participant of a TIMED
// race, ~2h before it ends. Fired on the FIRST tick where msLeft <= 2h (and > 0),
// then made send-once by the durable Notification audit row (findFirstByUserTypeRace) —
// NOT an in-memory throttle, so it survives restarts and multiple cluster workers.
const RACE_ENDING_SOON_WINDOW_MS = 2 * 60 * 60 * 1000; // fire when <= 2h remain
const RACE_ENDING_SOON_PUSH_TYPE = "RACE_ENDING_SOON";

// Races ending within this window are the "final stretch": we want their
// participants' steps to be as fresh as possible for the last few recomputes, so
// they get a tighter push throttle (below) than the default hourly cooldown.
const FINAL_STRETCH_WINDOW_MS = 60 * 60 * 1000; // ends within the next hour
const FINAL_STRETCH_MIN_INTERVAL_MS = 30 * 60 * 1000; // push at most every 30 min

// Live placement broadcast (Phase 0). Recomputes standings for every ACTIVE,
// not-yet-expired race and emits PLACEMENT_CHANGED when a participant's live rank
// changes, so users see standings update without opening the race. Backend-only:
// works for every shipped app version (the fan-out is server-side).
//
// The recompute primitive is resolveRaceState({ raceId }) — it already fetches the
// race, loops all ACCEPTED participants, and persists totalSteps/placement/finish
// state, defaulting timeZone to UTC when called without a requesting user. We then
// read the freshly-updated participants and derive a transient "live rank" by
// sorting totalSteps desc (the settlement `placement` column stays null until the
// race ends). Idempotent: a participant whose rank is unchanged is not re-notified.
function buildRecomputePlacements(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const events = dependencies.eventBus || eventBus;
  const resolve = dependencies.resolveRaceState || resolveRaceState;
  // C0 (spec §5a item 4): this cron is ENQUEUE-ONLY for the recompute portion.
  // It used to be a third bulk writer of race_participants, racing the worker
  // and the sync paths on the same rows. Now it just marks every active race
  // dirty every 5 minutes — the convergence backstop for races nobody is
  // syncing or watching — and the race-keyed worker does the writing.
  //
  // The notification evaluation below stays here, reading the persisted rows the
  // worker keeps fresh. Deliberate: moving it into the worker's post-commit hook
  // would re-evaluate every placement push at the worker's cadence (up to once
  // per race per 5s) instead of once per 5 minutes, changing push volume and the
  // meaning of `lastNotifiedPlacement`'s "last live rank" baseline. Its inputs
  // (totalSteps) are at most one worker cycle stale, which is the D-3 bound this
  // cron already lived with.
  //
  // An EXPLICITLY injected `resolveRaceState` still runs inline: that dependency
  // is the seam callers use to drive the recompute directly, and the inline path
  // is still live code behind the `inlineRaceResolutionFallback` lever. The
  // production singleton injects nothing, so production is enqueue-only.
  const inlineResolveInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  const enqueue = dependencies.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const notificationModel = dependencies.Notification || Notification;
  const requestStepSync =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  // §8 kill switch: RACE_ENDING_REMINDER_DISABLED=true stops the race-ending-soon
  // reminder without stopping placement pushes. Injectable for tests.
  const isRaceEndingReminderDisabled =
    dependencies.isRaceEndingReminderDisabled ||
    (() => process.env.RACE_ENDING_REMINDER_DISABLED === "true");

  // §8: emit a one-shot RACE_ENDING_SOON per eligible participant of a timed race
  // ~2h before it ends. Applies to BOTH individual and team races (any race with a
  // definite end instant). Excludes finished/forfeited participants. Send-once via
  // the durable audit-row guard, so repeated ticks and restarts never re-send.
  async function evaluateRaceEndingSoon({ race, participants, currentTime }) {
    if (isRaceEndingReminderDisabled()) return;
    // Seeded daily/weekly challenges are excluded (owner decision 2026-07-24).
    // Every opted-in user is auto-enrolled into these every day, so a "2h left"
    // nudge on each one is a recurring push nobody chose to receive. The nudge
    // is for races a user deliberately started or joined. `seedId` is selected
    // by findActiveInProgress — if it is ever dropped from that select this
    // reads undefined and the suppression silently stops working, which is what
    // race-ending-soon-skips-seeded.test.js locks down against the real DB.
    if (race.seedId) return;
    // Qualify on a definite end instant only (endsAt != null). Open-ended
    // step-target races have no fixed end and are excluded.
    if (!race.endsAt) return;
    const endMs = new Date(race.endsAt).getTime();
    const msLeft = endMs - currentTime.getTime();
    if (!(msLeft > 0) || msLeft > RACE_ENDING_SOON_WINDOW_MS) return;
    // Short-race guard: a seeded race whose TOTAL scheduled duration is <= 2h
    // starts already inside the window, so a "~2h left" nudge at launch is
    // nonsensical. Only fire when endsAt - startedAt > 2h. If startedAt is absent
    // (defensive — findActiveInProgress now selects it), skip rather than misfire.
    if (!race.startedAt) return;
    const totalDurationMs = endMs - new Date(race.startedAt).getTime();
    if (totalDurationMs <= RACE_ENDING_SOON_WINDOW_MS) return;

    for (const p of participants) {
      // Exclude finished (frozen standings) and forfeited participants.
      if (p.finishedAt || p.forfeitedAt) continue;
      const alreadySent = await notificationModel.findFirstByUserTypeRace(
        p.userId,
        RACE_ENDING_SOON_PUSH_TYPE,
        race.id
      );
      if (alreadySent) continue;
      events.emit("RACE_ENDING_SOON", {
        raceId: race.id,
        raceName: race.name,
        endsAt: race.endsAt,
        userId: p.userId,
      });
    }
  }

  // ── Team-race evaluation (TR-681/682/683/685) ────────────────────────────
  // Inside a team race, individual placement/overtake pushes are SUPPRESSED
  // (TR-685) — team pushes are the only standings notifications. The
  // lastNotifiedPlacement column doubles as the member's last-seen TEAM rank
  // (1 = leading side, 2 = trailing side); it is never returned by any API and
  // individual placement events never fire for team races, so the reuse is
  // invisible outside this job.
  async function evaluateTeamRace({ race, participants, currentTime }) {
    const totals = { TEAM_A: 0, TEAM_B: 0 };
    const members = participants.filter(
      (p) => p.team === "TEAM_A" || p.team === "TEAM_B"
    );
    for (const p of members) {
      totals[p.team] += p.totalSteps || 0;
    }

    const tie = totals.TEAM_A === totals.TEAM_B;
    const leadingTeam = tie
      ? null
      : totals.TEAM_A > totals.TEAM_B
        ? "TEAM_A"
        : "TEAM_B";

    // TR-681 lead-change: compare each member's stored team rank to the fresh
    // one. First observation seeds silently; flips push only once ARMED (both
    // teams > 0 — kills the day-one "first to sync leads over 0" false
    // positive). While unarmed, baselines still advance silently so the armed
    // flip fires exactly once when it becomes real.
    if (!tie && leadingTeam) {
      const rankFor = (p) => (p.team === leadingTeam ? 1 : 2);
      const storedRanks = members
        .map((p) => p.lastNotifiedPlacement)
        .filter((r) => r != null);
      const hadBaseline = storedRanks.length > 0;
      const previousLeader = hadBaseline
        ? members.find((p) => p.lastNotifiedPlacement === 1)?.team ?? null
        : null;
      const armed = totals.TEAM_A > 0 && totals.TEAM_B > 0;
      const flipped =
        hadBaseline && previousLeader != null && previousLeader !== leadingTeam;

      for (const p of members) {
        const rank = rankFor(p);
        if (p.lastNotifiedPlacement !== rank) {
          await participantModel.update(p.id, { lastNotifiedPlacement: rank });
        }
      }

      if (flipped && armed) {
        const trailingTeam = leadingTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
        events.emit("TEAM_LEAD_CHANGED", {
          raceId: race.id,
          raceName: race.name,
          leadingTeam,
          leadingTeamName:
            leadingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
          trailingTeamName:
            trailingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
          leadingTotal: totals[leadingTeam],
          trailingTotal: totals[trailingTeam],
          memberUserIds: members.map((p) => p.userId),
          memberTeams: Object.fromEntries(
            members.map((p) => [p.userId, p.team])
          ),
        });
      }
    }

    const raceEnd = race.endsAt ? new Date(race.endsAt) : null;
    const msLeft = raceEnd ? raceEnd.getTime() - currentTime.getTime() : null;

    // TR-682 final-stretch push with team framing, on the existing final-
    // stretch timing; the notification handler applies the 30-min throttle.
    if (msLeft != null && msLeft > 0 && msLeft <= FINAL_STRETCH_WINDOW_MS) {
      const activeMembers = members.filter((p) => !p.forfeitedAt);
      if (activeMembers.length > 0) {
        events.emit("TEAM_FINAL_STRETCH", {
          raceId: race.id,
          raceName: race.name,
          teamAName: race.teamAName,
          teamBName: race.teamBName,
          teamATotal: totals.TEAM_A,
          teamBTotal: totals.TEAM_B,
          endsAt: race.endsAt,
          memberUserIds: activeMembers.map((p) => p.userId),
          memberTeams: Object.fromEntries(
            activeMembers.map((p) => [p.userId, p.team])
          ),
        });
      }
    }

    // TR-683 slacker nudge: final 12h only, never in (configured or effective)
    // 1v1, average over non-forfeited members, once per race per member (the
    // Notification audit row is the durable dedup key).
    if (
      msLeft != null &&
      msLeft > 0 &&
      msLeft <= SLACKER_WINDOW_MS &&
      (race.teamSize ?? 0) > 1
    ) {
      for (const team of ["TEAM_A", "TEAM_B"]) {
        const active = members.filter((p) => p.team === team && !p.forfeitedAt);
        if (active.length <= 1) continue; // sole active member is never shamed
        const average =
          active.reduce((sum, p) => sum + (p.totalSteps || 0), 0) /
          active.length;
        if (average <= 0) continue;
        for (const p of active) {
          if ((p.totalSteps || 0) >= average * SLACKER_FRACTION) continue;
          const alreadySent = await notificationModel.findFirstByUserTypeRace(
            p.userId,
            SLACKER_PUSH_TYPE,
            race.id
          );
          if (alreadySent) continue;
          events.emit("TEAM_SLACKER_NUDGE", {
            raceId: race.id,
            raceName: race.name,
            userId: p.userId,
            teamName: team === "TEAM_A" ? race.teamAName : race.teamBName,
            totalSteps: p.totalSteps || 0,
            teamAverage: Math.round(average),
          });
        }
      }
    }
  }

  return async function recomputePlacements() {
    const currentTime = now();
    const emitted = [];
    // Split for the step-sync "pull" below: participants of at least one race
    // ending within the next hour ("final stretch") get a tighter push throttle;
    // everyone else keeps the default hourly cooldown.
    const finalStretchUserIds = new Set();
    const normalUserIds = new Set();

    let races;
    try {
      races = await raceModel.findActiveInProgress(currentTime);
    } catch (error) {
      logger.error("[CRON] placementRecompute: failed to load active races:", error);
      return emitted;
    }

    if (!races || races.length === 0) return emitted;

    // Sequential over races: resolveRaceState fans out participants in parallel
    // internally, so looping races one-at-a-time bounds peak DB connections under
    // the pool cap.
    for (const race of races) {
      try {
        // B-12b — the cron used to call resolve() with NO timeZone, which
        // falls through to UTC inside raceStateResolution while every live
        // surface resolves raceTimeZone(race, viewerTz). For a user-created
        // race (timezone NULL) the two bucket steps into different calendar
        // days for hours around local midnight, which is exactly how the
        // false "you slipped to Nth" pushes were produced. Resolve the race's
        // own tz explicitly, falling back to the CREATOR's tz before UTC.
        const raceTz = raceTimeZone(race, race.creator?.timezone || "UTC");
        await enqueue({ raceId: race.id, timeZone: raceTz, now: currentTime });
        if (inlineResolveInjected) {
          await resolve({ raceId: race.id, timeZone: raceTz });
        }

        const participants = await participantModel.findAcceptedByRace(race.id);
        if (!participants || participants.length === 0) continue;

        // Collect for the step-sync "pull" below. A time-based race ending within
        // the hour is "final stretch"; step-target races (endsAt null) never are.
        const raceEnd = race.endsAt ? new Date(race.endsAt) : null;
        const isFinalStretch =
          raceEnd != null &&
          raceEnd.getTime() - currentTime.getTime() <= FINAL_STRETCH_WINDOW_MS;
        const bucket = isFinalStretch ? finalStretchUserIds : normalUserIds;
        for (const p of participants) bucket.add(p.userId);

        // §8: race-ending-soon reminder — applies to every timed race (individual
        // or team), independent of the placement/team-push logic below.
        await evaluateRaceEndingSoon({ race, participants, currentTime });

        // Team races: individual placement events are suppressed (TR-685);
        // evaluate the team pushes instead and skip the individual loop.
        if (race.isTeamRace) {
          await evaluateTeamRace({ race, participants, currentTime });
          continue;
        }

        // B-12a — the SHARED comparator (finishers first, then steps desc,
        // then joinedAt, then userId). The old local sort was steps-desc only,
        // so at 0 steps (start of day) it produced a DB-order rank unrelated to
        // what home/list/detail showed.
        const ranked = [...participants].sort(compareParticipantsForPlacement);

        // How many places are "in the money" for this race, so the handler can
        // alert only on a meaningful threshold crossing (dropping out of the
        // payout) instead of every one-spot slip. 0 when there's no pot — a free
        // race has no paid places, so only lead changes are meaningful.
        const paidPlaces = race.fundedPrize
          ? computeFundedPayouts({
              preset: race.payoutPreset,
              // Projected from the live field, exactly as the race screen shows
              // it; the settled pool is recomputed from actual finishers.
              //
              // No team multiplier here, deliberately (batch 2026-08-08 item 5):
              // team races `continue` above and never reach this branch, and the
              // only thing read off this value is `.length` — how many places are
              // "in the money" for a rank-drop push. Scaling the pool cannot
              // change that count. Consistent with settlement by construction:
              // a team race's paid places are decided by completeRace's team
              // branch (everyone on the winning side), not by this helper.
              poolCoins: computePrizePool({
                playerCount: ranked.length,
                durationDays: race.maxDurationDays || 7,
              }),
              participantCount: ranked.length,
              // Only .length is read here (both distributions return exactly
              // `slots` entries), but pass it anyway so this site can never
              // drift from the read/settlement sites.
              curve: race.payoutCurve ?? null,
            }).length
          : (race.potCoins || 0) > 0
            ? computeRacePayouts({
                preset: race.payoutPreset,
                potCoins: race.potCoins,
                participantCount: ranked.length,
              }).length
            : 0;

        for (let i = 0; i < ranked.length; i++) {
          const participant = ranked[i];
          const liveRank = i + 1;

          // Finished participants have frozen standings — never notify them.
          if (participant.finishedAt) continue;

          // Deploy-day guard for the comparator/timezone change above: the
          // stored baselines were computed under the OLD rules, so the first
          // tick after deploy would fire a burst of "you slipped to Nth"
          // pushes for positions that did not really move. Set
          // PLACEMENT_BASELINE_RESYNC=true for one tick to re-seed every
          // baseline under the NEW comparator, emitting nothing, then remove it.
          if (process.env.PLACEMENT_BASELINE_RESYNC === "true") {
            if (participant.lastNotifiedPlacement !== liveRank) {
              await participantModel.update(participant.id, {
                lastNotifiedPlacement: liveRank,
              });
            }
            continue;
          }

          // First observation: seed the baseline silently (avoids a rollout-day
          // notification storm). Only notify on a SUBSEQUENT change.
          if (participant.lastNotifiedPlacement == null) {
            await participantModel.update(participant.id, {
              lastNotifiedPlacement: liveRank,
            });
            continue;
          }

          // Per-race opt-out: keep the baseline in sync (so unmuting doesn't
          // replay a backlog of missed moves) but emit nothing — no visible
          // alert and no silent refresh — for a muted participant.
          if (participant.placementAlertsMuted) {
            if (participant.lastNotifiedPlacement !== liveRank) {
              await participantModel.update(participant.id, {
                lastNotifiedPlacement: liveRank,
              });
            }
            continue;
          }

          if (participant.lastNotifiedPlacement === liveRank) continue; // no change

          const change = {
            raceId: race.id,
            raceName: race.name,
            userId: participant.userId,
            previousPlacement: participant.lastNotifiedPlacement,
            placement: liveRank,
            totalParticipants: ranked.length,
            paidPlaces,
          };
          events.emit("PLACEMENT_CHANGED", change);
          emitted.push(change);

          await participantModel.update(participant.id, {
            lastNotifiedPlacement: liveRank,
          });
        }
      } catch (error) {
        logger.error(`[CRON] placementRecompute: race ${race.id} failed:`, error);
        // continue with the next race
      }
    }

    // Phase 3 — on-demand "pull": nudge active-race participants to upload fresh
    // steps so the NEXT recompute reflects them (devices take seconds-to-minutes to
    // wake, upload, and POST, so this improves the following tick, not this one).
    // requestStepSync self-throttles per user — it skips anyone synced or pushed
    // within its throttle window — so this won't spam even at a 5-minute cadence.
    //
    // Final-stretch participants get a tighter (30-min) window; everyone else keeps
    // the default hourly cooldown. A user in both kinds of race belongs to the
    // final-stretch set only, so we never nudge them twice in one tick.
    for (const userId of finalStretchUserIds) normalUserIds.delete(userId);

    if (finalStretchUserIds.size > 0) {
      try {
        await requestStepSync([...finalStretchUserIds], {
          minIntervalMs: FINAL_STRETCH_MIN_INTERVAL_MS,
        });
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: final-stretch step-sync pull failed:",
          error
        );
      }
    }

    if (normalUserIds.size > 0) {
      try {
        await requestStepSync([...normalUserIds], {});
      } catch (error) {
        logger.error("[CRON] placementRecompute: step-sync pull failed:", error);
      }
    }

    return emitted;
  };
}

function scheduleRecomputePlacements(dependencies = {}) {
  const run = buildRecomputePlacements(dependencies);
  const logger = dependencies.logger || console;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] placementRecompute tick error:", error);
    }
  }

  tick(); // run once shortly after boot
  setInterval(tick, RECOMPUTE_INTERVAL_MS);
  logger.log("[CRON] Live placement recompute scheduled (every 5 minutes)");
}

module.exports = { buildRecomputePlacements, scheduleRecomputePlacements };
