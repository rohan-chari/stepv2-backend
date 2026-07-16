const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");
const { awardCoins } = require("./awardCoins");
const { appSettings } = require("../services/appSettings");
const { withRaceJoinLock } = require("../services/raceJoinLock");
const {
  validateRaceName,
  validateDuration,
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
  validateTeamName,
  validateTeamSize,
  assertTeamNamesDiffer,
} = require("../services/validateRaceConfig");

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

function buildEditRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const settings = dependencies.appSettings || appSettings;
  const withRaceLock = dependencies.withRaceLock || withRaceJoinLock;
  const events = dependencies.eventBus || eventBus;

  return async function editRace({ userId, raceId, updates = {} }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceEditError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceEditError("Only the race creator can edit the race", 403);
    }
    if (race.status !== "PENDING") {
      throw new RaceEditError(
        "Race settings can only be edited while the race is pending",
        400
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

    // Determine effective powerup state for combined validation
    const effectivePowerupsEnabled = hasField(updates, "powerupsEnabled")
      ? !!updates.powerupsEnabled
      : race.powerupsEnabled;
    const effectivePowerupInterval = hasField(updates, "powerupStepInterval")
      ? updates.powerupStepInterval
      : race.powerupStepInterval;

    if (
      hasField(updates, "powerupsEnabled") ||
      hasField(updates, "powerupStepInterval")
    ) {
      validatePowerupConfig({
        powerupsEnabled: effectivePowerupsEnabled,
        powerupStepInterval: effectivePowerupInterval,
        ErrorClass: RaceEditError,
      });
      if (hasField(updates, "powerupsEnabled")) {
        fields.powerupsEnabled = effectivePowerupsEnabled;
      }
      if (hasField(updates, "powerupStepInterval")) {
        fields.powerupStepInterval = updates.powerupStepInterval;
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

    // ── Buy-in (Issue 4) ─────────────────────────────────────────────────────
    // `buyInEnabled:false` (or an amount of 0) toggles the race to FREE;
    // `buyInEnabled:true` + `buyInAmount:N` (or a bare `buyInAmount`) sets the
    // paid amount. Changing the effective amount on a PENDING race reconciles
    // every ACCEPTED participant's coin hold (charge the delta on a raise /
    // free->paid, refund it on a lower / paid->free).
    let buyInNotify = null;
    if (
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

      const newBuyIn = buyInConfig.buyInAmount;
      const buyInChanged =
        (hasField(updates, "buyInAmount") || hasField(updates, "buyInEnabled")) &&
        newBuyIn !== race.buyInAmount;

      if (buyInChanged) {
        // How much each ACCEPTED participant's hold moves: HELD/COMMITTED
        // participants hold their `buyInAmount`; everyone else (NONE/REFUNDED)
        // holds 0. `delta` > 0 charges, < 0 refunds.
        const oldHeldAmount = (p) =>
          p.buyInStatus === "HELD" || p.buyInStatus === "COMMITTED"
            ? p.buyInAmount || 0
            : 0;

        // Peek the accepted set to decide whether any money actually moves. When
        // nobody is affected (e.g. an empty lobby, or the amount is unchanged for
        // everyone) the change is trivially applied, exactly like the pre-Issue-4
        // "no charged participants" path — no lock, no flag read.
        const peek =
          typeof participantModel.findAcceptedByRace === "function"
            ? await participantModel.findAcceptedByRace(raceId)
            : [];
        const anyoneAffected = peek.some((p) => newBuyIn - oldHeldAmount(p) !== 0);

        if (!anyoneAffected) {
          fields.buyInAmount = newBuyIn;
          if (peek.length > 0) {
            fields.potCoins = newBuyIn === 0 ? 0 : peek.length * newBuyIn;
          }
        } else {
          // Kill switch: when disabled, keep the old hard block.
          const enabled = await settings.getFlag("buyInEditEnabled");
          if (!enabled) {
            throw new RaceEditError(
              "Cannot edit buy-in after a participant has accepted and paid in",
              400,
              "IMMUTABLE_FIELD"
            );
          }

          const reconcile = await withRaceLock(raceId, async () => {
            // Re-read the accepted set inside the lock so a concurrent join is
            // fully seen (the join core holds the same per-race lock).
            const accepted = await participantModel.findAcceptedByRace(raceId);

            // Affordability precheck: any participant who must PAY a positive
            // delta they can't cover blocks the whole edit. Mutate nothing.
            const unaffordable = [];
            for (const p of accepted) {
              const delta = newBuyIn - oldHeldAmount(p);
              if (delta <= 0) continue;
              const u = await userModel.findById(p.userId);
              const coins = u && typeof u.coins === "number" ? u.coins : 0;
              if (coins < delta) {
                unaffordable.push(
                  (p.user && p.user.displayName) ||
                    (u && u.displayName) ||
                    "A player"
                );
              }
            }
            if (unaffordable.length > 0) {
              const names = unaffordable.join(", ");
              const verb = unaffordable.length === 1 ? "doesn't" : "don't";
              throw new RaceEditError(
                `${names} ${verb} have enough coins for the new buy-in.`,
                400,
                "BUYIN_UNAFFORDABLE"
              );
            }

            // Apply. Each movement is idempotent on (userId, reason, refId); the
            // versioned refId guarantees a fresh key per edit so a re-charge after
            // a refund is never silently skipped.
            const affectedUserIds = [];
            for (const p of accepted) {
              const delta = newBuyIn - oldHeldAmount(p);
              if (delta === 0) continue;
              const newVersion = (p.buyInVersion || 0) + 1;
              await awardCoinsFn({
                userId: p.userId,
                amount: -delta, // negative charges, positive refunds
                reason: "race_buy_in_adjust",
                refId: `${raceId}:${p.userId}:v${newVersion}`,
              });
              const newStatus =
                newBuyIn === 0
                  ? "REFUNDED"
                  : p.buyInStatus === "NONE" || p.buyInStatus === "REFUNDED"
                    ? "HELD"
                    : p.buyInStatus;
              await participantModel.update(p.id, {
                buyInAmount: newBuyIn,
                buyInStatus: newStatus,
                buyInVersion: newVersion,
              });
              if (p.userId !== race.creatorId) affectedUserIds.push(p.userId);
            }

            // Every ACCEPTED participant ends HELD when paid (each was charged up
            // to newBuyIn), or REFUNDED when free.
            const potCoins = newBuyIn === 0 ? 0 : accepted.length * newBuyIn;
            return { potCoins, affectedUserIds };
          });

          fields.buyInAmount = newBuyIn;
          fields.potCoins = reconcile.potCoins;
          if (reconcile.affectedUserIds.length > 0) {
            buyInNotify = {
              affectedUserIds: reconcile.affectedUserIds,
              newBuyIn,
            };
          }
        }
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

    // Best-effort push to charged non-owner participants whose buy-in moved
    // (Issue 4). A push failure must never fail the edit — the handler is
    // fire-and-forget with its own try/catch.
    if (buyInNotify) {
      events.emit("RACE_BUYIN_CHANGED", {
        raceId,
        raceName: updated.name,
        newBuyIn: buyInNotify.newBuyIn,
        affectedUserIds: buyInNotify.affectedUserIds,
      });
    }

    return updated;
  };
}

const editRace = buildEditRace();

module.exports = { buildEditRace, editRace, RaceEditError };
