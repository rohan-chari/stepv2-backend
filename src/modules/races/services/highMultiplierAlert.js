const { eventBus } = require("../../../shared/events/eventBus");
const { prisma: defaultPrisma } = require("../../../db");

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
  return process.env.HIGH_MULTIPLIER_PUSH_DISABLED === "true";
}

async function evaluateHighMultiplierAlert({
  participant,
  currentMultiplier,
  race = null,
  otherParticipants = [],
  prisma = defaultPrisma,
  events = eventBus,
  now = () => new Date(),
}) {
  if (disabled()) return { emitted: false, reason: "disabled" };
  if (!participant || !participant.id) return { emitted: false, reason: "no_participant" };

  const T = threshold();
  const mult = Number(currentMultiplier);
  const alreadyNotified = participant.highMultiplierNotifiedAt != null;

  // Crossed ABOVE the threshold and not yet notified → claim + emit once.
  if (Number.isFinite(mult) && mult > T && !alreadyNotified) {
    const claimed = await prisma.raceParticipant.updateMany({
      where: { id: participant.id, highMultiplierNotifiedAt: null },
      data: { highMultiplierNotifiedAt: now() },
    });
    if (!claimed || claimed.count !== 1) {
      // Another concurrent recompute won the claim; it emits, not us.
      return { emitted: false, reason: "claim_lost" };
    }
    const recipients = (otherParticipants || []).filter(
      (p) =>
        p &&
        p.userId &&
        p.userId !== participant.userId &&
        !p.finishedAt &&
        !p.forfeitedAt
    );
    events.emit("HIGH_MULTIPLIER_ALERT", {
      raceId: race?.id ?? participant.raceId ?? null,
      raceName: race?.name ?? null,
      actorUserId: participant.userId,
      actorName: participant.user?.displayName ?? null,
      multiplier: Math.round(mult),
      recipientUserIds: recipients.map((p) => p.userId),
    });
    return { emitted: true, multiplier: Math.round(mult) };
  }

  // Dropped back to/below the threshold → clear the flag to re-arm.
  if ((!Number.isFinite(mult) || mult <= T) && alreadyNotified) {
    await prisma.raceParticipant.updateMany({
      where: { id: participant.id },
      data: { highMultiplierNotifiedAt: null },
    });
    return { emitted: false, reason: "re_armed" };
  }

  return { emitted: false, reason: "no_change" };
}

module.exports = { evaluateHighMultiplierAlert, threshold, disabled };
