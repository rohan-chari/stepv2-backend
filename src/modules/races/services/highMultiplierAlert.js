const { eventBus } = require("../../../shared/events/eventBus");
const { prisma: defaultPrisma } = require("../../../db");
const { userFanoutDisabled } = require("../../../shared/config/operationalControls");

// Item 6b — high-multiplier push. A single shared evaluator called from BOTH the
// powerup-use path (immediate self-buff spike) and the progress recompute
// (event-driven crossings + re-arm as buffs decay), so "once per spike, re-arm on
// drop" is deterministic and can't diverge between the two call sites.
//
// State lives on RaceParticipant.highMultiplierNotifiedAt (nullable): set when we
// emit, cleared when the multiplier drops back to <= threshold. The set is done
// with a conditional updateMany (flag still null) so concurrent recomputes across
// many viewers can never double-fire.

// `> THRESHOLD` strictly. Default 4; a malformed override falls back to 4.
function threshold() {
  const raw = Number(process.env.HIGH_MULTIPLIER_PUSH_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

// Kill switch — ship enabled; can dark-flip without a deploy.
function disabled() {
  return userFanoutDisabled("HIGH_MULTIPLIER_PUSH_DISABLED");
}

async function evaluateHighMultiplierAlert({
  participant,
  currentMultiplier,
  race = null,
  otherParticipants = [],
  prisma = defaultPrisma,
  events = eventBus,
  emitAlert = null,
  deferClaim = false,
  deferRearm = false,
  now = () => new Date(),
}) {
  if (disabled()) return { emitted: false, reason: "disabled" };
  if (!participant || !participant.id) return { emitted: false, reason: "no_participant" };

  const T = threshold();
  const mult = Number(currentMultiplier);
  const alreadyNotified = participant.highMultiplierNotifiedAt != null;

  // Crossed ABOVE the threshold and not yet notified → claim + emit once.
  if (Number.isFinite(mult) && mult > T && !alreadyNotified) {
    const claimedAt = now();
    if (!deferClaim) {
      const claimed = await prisma.raceParticipant.updateMany({
        where: { id: participant.id, highMultiplierNotifiedAt: null },
        data: { highMultiplierNotifiedAt: claimedAt },
      });
      if (!claimed || claimed.count !== 1) {
        // Another concurrent recompute won the claim; it emits, not us.
        return { emitted: false, reason: "claim_lost" };
      }
    }
    const recipients = (otherParticipants || []).filter(
      (p) =>
        p &&
        p.userId &&
        p.userId !== participant.userId &&
        !p.finishedAt &&
        !p.forfeitedAt
    );
    // Batch 2026-08-09 item 11 (second leak). This push names the actor to
    // every rival, so a STEALTHED player who stacks a multiplier announced
    // themselves — and stacking a multiplier is precisely what a stealthed
    // player is hiding. Read the actor's stealth here and let the handler
    // redact to "???".
    //
    // Best-effort, resolving FALSE on any error: the handler defaults to the
    // visible name too, so an unthreaded or failed read degrades to today's
    // behavior rather than to a silent anonymization.
    let stealthed = false;
    try {
      const stealth = await prisma.raceActiveEffect.findFirst({
        where: {
          targetParticipantId: participant.id,
          type: "STEALTH_MODE",
          status: "ACTIVE",
        },
        select: { expiresAt: true },
      });
      stealthed = Boolean(
        stealth && (!stealth.expiresAt || new Date(stealth.expiresAt) > now())
      );
    } catch {}

    const alert = {
      raceId: race?.id ?? participant.raceId ?? null,
      raceName: race?.name ?? null,
      endsAt: race?.endsAt ?? null,
      actorUserId: participant.userId,
      actorName: participant.user?.displayName ?? null,
      multiplier: Math.round(mult),
      recipientUserIds: recipients.map((p) => p.userId),
      stealthed,
      // The claim timestamp is stored on RaceParticipant before the event is
      // emitted. Retries of this crossing therefore reuse one identity, while
      // clearing/re-claiming the field gives a later crossing a new identity.
      notificationIntentId:
        `high-multiplier:${participant.id}:${claimedAt.toISOString()}`,
    };
    const deliveryIntents = emitAlert
      ? await emitAlert(alert, {
          participantId: participant.id,
          claimedAt,
        })
      : (events.emit("HIGH_MULTIPLIER_ALERT", alert), []);
    return {
      emitted: true,
      multiplier: Math.round(mult),
      deliveryIntents: Array.isArray(deliveryIntents) ? deliveryIntents : [],
    };
  }

  // Dropped back to/below the threshold → clear the flag to re-arm.
  if ((!Number.isFinite(mult) || mult <= T) && alreadyNotified) {
    if (deferRearm) {
      return {
        emitted: false,
        reason: "re_armed_deferred",
        rearmClaim: {
          participantId: participant.id,
          expectedNotifiedAt: participant.highMultiplierNotifiedAt,
        },
      };
    }
    await prisma.raceParticipant.updateMany({
      where: { id: participant.id },
      data: { highMultiplierNotifiedAt: null },
    });
    return { emitted: false, reason: "re_armed" };
  }

  return { emitted: false, reason: "no_change" };
}

module.exports = { evaluateHighMultiplierAlert, threshold, disabled };
