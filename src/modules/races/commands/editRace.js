const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../../../shared/events/eventBus");
const { appSettings } = require("../../../shared/config/appSettings");
const {
  validateRaceName,
  validateDuration,
  normalizePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
  validateTeamName,
  validateTeamSize,
  assertTeamNamesDiffer,
  parseScheduledEndAt,
  validateRaceWindow,
  durationDaysFromWindow,
} = require("../services/validateRaceConfig");
const { resolveTeamPoolMultBps } = require("../teamPoolMultiplier");

class RaceEditError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceEditError";
    if (statusCode) this.statusCode = statusCode;
    // Optional machine-readable code (TEAM_NAMES_IDENTICAL, TEAM_SIZE_TOO_SMALL,
    // IMMUTABLE_FIELD). Additive — routes serialize it alongside `error`.
    if (code) this.code = code;
  }
}

function hasField(updates, key) {
  return Object.prototype.hasOwnProperty.call(updates, key);
}

// C3 (spec §5 Phase D step 9): this write seam is a snapshot DEL hook — the
// shared standings snapshot must not outlive the change we just committed. The
// resolution worker is deliberately NOT in this list: it SETs post-commit.
const {
  invalidateRaceProgress,
} = require("../services/raceProgressSnapshot");

function buildEditRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const settings = dependencies.appSettings || appSettings;
  const events = dependencies.eventBus || eventBus;

  return async function editRace({ userId, raceId, updates = {} }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceEditError("Race not found", 404);
    }
    if (race.tournamentId) {
      throw new RaceEditError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (race.creatorId !== userId) {
      throw new RaceEditError("Only the race creator can edit the race", 403);
    }
    if (race.status !== "PENDING") {
      // Architect R1: this stays a 400, deliberately. It already rejects EVERY
      // edit of a non-PENDING race — name, buy-in, everything — before a single
      // field is inspected, and every shipped edit screen is coded against that
      // status. Moving the guard below field parsing to emit a 409 for the two
      // new window fields would change the code frozen clients get for edits
      // they already make. `code` is purely additive.
      throw new RaceEditError(
        "Race settings can only be edited while the race is pending",
        400,
        "RACE_ALREADY_STARTED"
      );
    }

    const fields = {};

    // ── Team races (TR-105) ──────────────────────────────────────────────────
    // isTeamRace is immutable after creation: a PATCH may echo the stored value
    // (harmless no-op) but can never convert individual <-> team.
    if (
      hasField(updates, "isTeamRace") &&
      !!updates.isTeamRace !== !!race.isTeamRace
    ) {
      throw new RaceEditError(
        "A race cannot be converted between team and individual after creation",
        400,
        "IMMUTABLE_FIELD"
      );
    }

    const touchesTeamFields =
      hasField(updates, "teamAName") ||
      hasField(updates, "teamBName") ||
      hasField(updates, "teamSize");
    if (touchesTeamFields && !race.isTeamRace) {
      throw new RaceEditError(
        "Team settings can only be edited on a team race",
        400
      );
    }

    if (race.isTeamRace) {
      // Team names: same sanitization as creation, and the pair must stay
      // distinct (case-insensitive) after applying the edit.
      const nextTeamAName = hasField(updates, "teamAName")
        ? validateTeamName(updates.teamAName, RaceEditError, "Team A name")
        : race.teamAName;
      const nextTeamBName = hasField(updates, "teamBName")
        ? validateTeamName(updates.teamBName, RaceEditError, "Team B name")
        : race.teamBName;
      assertTeamNamesDiffer(nextTeamAName, nextTeamBName, RaceEditError);
      if (hasField(updates, "teamAName")) fields.teamAName = nextTeamAName;
      if (hasField(updates, "teamBName")) fields.teamBName = nextTeamBName;

      if (hasField(updates, "teamSize")) {
        const newSize = validateTeamSize(updates.teamSize, RaceEditError);
        const accepted = (race.participants || []).filter(
          (p) => p.status === "ACCEPTED"
        );
        const sideCounts = {
          TEAM_A: accepted.filter((p) => p.team === "TEAM_A").length,
          TEAM_B: accepted.filter((p) => p.team === "TEAM_B").length,
        };
        const largestSide = Math.max(sideCounts.TEAM_A, sideCounts.TEAM_B);
        if (newSize < largestSide) {
          throw new RaceEditError(
            `Cannot shrink team size to ${newSize}; a team already has ${largestSide} members`,
            400,
            "TEAM_SIZE_TOO_SMALL"
          );
        }
        fields.teamSize = newSize;
        // The field cap is derived: always 2 × teamSize (TR-101/105).
        fields.maxParticipants = newSize * 2;
      }
    }

    if (hasField(updates, "name")) {
      fields.name = validateRaceName(updates.name, RaceEditError);
    }

    if (hasField(updates, "maxDurationDays")) {
      fields.maxDurationDays = validateDuration(
        updates.maxDurationDays,
        RaceEditError
      );
    }

    // ── Custom race window (spec §5.2 Q4, §5.2a, §5.3) ───────────────────────
    // Both fields are read through hasField, never truthiness (architect S1):
    // `scheduledEndAt: null` CLEARS the window, and an `if (updates.x)` test
    // would turn that clear into a silent no-op.
    const startInUpdates = hasField(updates, "scheduledStartAt");
    const endInUpdates = hasField(updates, "scheduledEndAt");

    // A start that is present-but-unparseable is IGNORED (treated as absent),
    // the same forgiving rule createRace uses. It must never fall through to
    // "clear" — see the null case below for why clearing is not a capability.
    let nextScheduledStartAt = race.scheduledStartAt ?? null;
    let startProvided = false;
    if (startInUpdates) {
      const raw = updates.scheduledStartAt;
      if (raw === null || raw === "") {
        // Architect R2/S7: un-scheduling is NOT "revert to manual start".
        // shouldAutoStartPrivateRace skips its schedule guard entirely when
        // scheduledStartAt is null, so a cleared schedule on a private race
        // with >= 2 accepted and no outstanding invites means the 5-minute
        // backstop starts it on the NEXT TICK — the opposite of what the
        // control appears to do. A creator who wants a later start moves the
        // start; they never need to clear it.
        throw new RaceEditError(
          "A scheduled start can be moved, but not removed",
          400,
          "SCHEDULED_START_NOT_CLEARABLE"
        );
      }
      const parsedStart = raw instanceof Date ? raw : new Date(raw);
      if (!Number.isNaN(parsedStart.getTime())) {
        if (parsedStart.getTime() <= Date.now()) {
          throw new RaceEditError(
            "Scheduled start time must be in the future",
            400
          );
        }
        nextScheduledStartAt = parsedStart;
        startProvided = true;
      }
    }

    // Resulting end: explicit null clears; a parseable value sets; an
    // unparseable value is ignored (keeps whatever is stored).
    let nextScheduledEndAt = race.scheduledEndAt ?? null;
    let endProvided = false;
    if (endInUpdates) {
      if (updates.scheduledEndAt === null || updates.scheduledEndAt === "") {
        nextScheduledEndAt = null;
        endProvided = true;
      } else {
        const parsedEnd = parseScheduledEndAt(updates.scheduledEndAt);
        if (parsedEnd) {
          nextScheduledEndAt = parsedEnd;
          endProvided = true;
        }
      }
    }

    // Kill switch (§5.2a). Fires only for a request that SETS window state —
    // clearing a window (`scheduledEndAt: null`) stays available while the flag
    // is off so a creator is never stranded with a window the server no longer
    // honors on the edit surface.
    if (startProvided || (endProvided && nextScheduledEndAt !== null)) {
      const customWindowEnabled = await settings.getFlag(
        "customRaceWindowEnabled"
      );
      if (!customWindowEnabled) {
        throw new RaceEditError(
          "Custom race windows are temporarily unavailable",
          403,
          "FEATURE_DISABLED"
        );
      }
    }

    if (startProvided) fields.scheduledStartAt = nextScheduledStartAt;
    if (endProvided) fields.scheduledEndAt = nextScheduledEndAt;

    // §5.2a old-client compat, the important one: a frozen edit screen sends
    // maxDurationDays on save and knows nothing about scheduledEndAt. An
    // explicit maxDurationDays in a PATCH that does NOT also carry a window
    // CLEARS the window. Silently keeping a custom end while the old client
    // renders "7d" makes the edit screen lie; the user changed the duration, so
    // duration wins. Deterministic and honest.
    if (
      hasField(updates, "maxDurationDays") &&
      !endProvided &&
      race.scheduledEndAt != null
    ) {
      fields.scheduledEndAt = null;
      nextScheduledEndAt = null;
    }

    // Architect R3, both halves:
    //  * Window validation runs ONLY when one of the two fields is in
    //    `updates`. "Effective start = now" means a manual-start custom race's
    //    remaining window shrinks in real time, so revalidating on every PATCH
    //    would make a request that merely RENAMES the race fail with
    //    RACE_WINDOW_TOO_SHORT once its end came within 24 hours.
    //  * It validates the MERGED pair, never the submitted field: moving only
    //    the start must still leave a legal window against the STORED end.
    if ((startProvided || endProvided) && nextScheduledEndAt != null) {
      const effectiveStart = nextScheduledStartAt || new Date();
      validateRaceWindow({
        effectiveStart,
        scheduledEndAt: nextScheduledEndAt,
        ErrorClass: RaceEditError,
      });
      // Re-derive the priced duration whenever either end moves — and only when
      // the RESULTING end is non-null, so moving the scheduled start of a plain
      // 7-day preset race never touches its duration. This deliberately
      // overrides any maxDurationDays in the same request: with a window
      // present, the server owns the number (§5.3).
      fields.maxDurationDays = durationDaysFromWindow(
        effectiveStart,
        nextScheduledEndAt
      );
      // Re-stamp the team payout multiplier from the SAME derived duration, in
      // the same write. teamPoolMultBps was stamped at CREATE and settlement
      // reads it back verbatim, so shrinking a 14-day team window to 25 hours
      // without this leaves a 1-day race carrying the 1.875x long-race buff —
      // 37.5 coins/player-day against the ceiling of 20 (architect R5).
      if (race.isTeamRace === true) {
        fields.teamPoolMultBps = resolveTeamPoolMultBps({
          isTeamRace: true,
          durationDays: fields.maxDurationDays,
        });
      }
    }

    // `updates.powerupStepInterval` is deliberately DROPPED ON THE FLOOR here:
    // accepted (a frozen edit screen still sends it), never persisted, never a
    // 400. Re-pointing a race's interval is not a future-only change —
    // rollPowerup ratchets `currentThreshold += powerupStepInterval`, so
    // lowering a running race from 5,000 to 2,000 makes the next steps-sync
    // back-mint every box the player "should" already have (a walker at 20,000
    // steps jumps from 4 boxes to 10). That is the public-join over-grant bug
    // class; do not "fix" this back.
    //
    // Toggling powerupsEnabled stays editable. false -> true arms the fixed
    // 2,000 interval; that race's interval was null, so there is no ratchet
    // history to disturb.
    if (hasField(updates, "powerupsEnabled")) {
      const nextPowerupsEnabled = !!updates.powerupsEnabled;
      fields.powerupsEnabled = nextPowerupsEnabled;
      // Arm the fixed interval ONLY when the race has none stored. An old edit
      // screen re-sends `powerupsEnabled: true` on every save, so writing the
      // constant unconditionally would silently re-point a grandfathered
      // 5,000-step race to 2,000 — the exact back-mint above, arriving through
      // the other field.
      if (nextPowerupsEnabled && race.powerupStepInterval == null) {
        fields.powerupStepInterval = normalizePowerupConfig({
          powerupsEnabled: true,
        });
      }
    }

    if (hasField(updates, "isPublic")) {
      fields.isPublic = !!updates.isPublic;
    }

    if (hasField(updates, "maxParticipants") && !race.isTeamRace) {
      const newMax = validateMaxParticipants(
        updates.maxParticipants,
        RaceEditError
      );
      // newMax === null => unlimited; the "already N accepted" floor only
      // applies to a finite cap.
      if (newMax !== null) {
        const acceptedCount = await participantModel.countAccepted(raceId);
        if (newMax < acceptedCount) {
          throw new RaceEditError(
            `Cannot reduce max participants to ${newMax}; already ${acceptedCount} accepted`,
            400
          );
        }
      }
      fields.maxParticipants = newMax;
    }

    // New competitions are permanently app-funded. Frozen clients may continue
    // to echo buy-in fields; funded races accept and ignore them. Historical
    // non-funded races retain their stamped settlement state, but that state is
    // immutable now that the production HELD remediation is complete.
    if (race.fundedPrize === true) {
      if (hasField(updates, "payoutPreset")) {
        const presetConfig = validateRaceBuyInConfig({
          buyInAmount: 0,
          payoutPreset: updates.payoutPreset,
          ErrorClass: RaceEditError,
        });
        fields.payoutPreset = presetConfig.payoutPreset;
      }
    } else if (
      hasField(updates, "buyInAmount") ||
      hasField(updates, "buyInEnabled") ||
      hasField(updates, "payoutPreset")
    ) {
      let proposedBuyIn;
      if (hasField(updates, "buyInEnabled") && !updates.buyInEnabled) {
        proposedBuyIn = 0; // explicit toggle to free
      } else if (hasField(updates, "buyInAmount")) {
        proposedBuyIn = updates.buyInAmount;
      } else {
        proposedBuyIn = race.buyInAmount;
      }
      const proposedPreset = hasField(updates, "payoutPreset")
        ? updates.payoutPreset
        : race.payoutPreset;

      const buyInConfig = validateRaceBuyInConfig({
        buyInAmount: proposedBuyIn,
        payoutPreset: proposedPreset,
        ErrorClass: RaceEditError,
      });

      if (hasField(updates, "payoutPreset")) {
        fields.payoutPreset = buyInConfig.payoutPreset;
      }

      const buyInChanged =
        (hasField(updates, "buyInAmount") || hasField(updates, "buyInEnabled")) &&
        buyInConfig.buyInAmount !== race.buyInAmount;
      if (buyInChanged) {
        throw new RaceEditError(
          "Buy-in settings are immutable",
          400,
          "IMMUTABLE_FIELD"
        );
      }
    }

    if (Object.keys(fields).length === 0) {
      // Nothing to update; return the race as-is.
      return race;
    }

    await raceModel.update(raceId, fields);
    const updated = await raceModel.findById(raceId);

    events.emit("RACE_EDITED", {
      raceId,
      creatorUserId: userId,
      updatedFields: Object.keys(fields),
    });

    await invalidateRaceProgress(raceId);

    // Edits are PENDING-only, so there are no live standings to resolve.

    return updated;
  };
}

const editRace = buildEditRace();

module.exports = { buildEditRace, editRace, RaceEditError };
