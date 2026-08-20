// Canonical final-score attribution. This module never evaluates samples or
// effects itself: callers supply the same whole-race scorer used for settlement.
// It turns those authoritative counterfactual totals into one ordered, integer
// vector whose components sum exactly to final minus the unmodified baseline.

const ATTRIBUTION_VERSION = 1;

function chronological(rows = []) {
  return [...rows].sort((a, b) => {
    const at = new Date(a.startsAt || a.createdAt || 0).getTime();
    const bt = new Date(b.startsAt || b.createdAt || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
}

function integer(value) {
  return Math.round(Number(value) || 0);
}

// Truncate every marginal toward zero, then assign the remaining whole steps
// by largest fractional magnitude and stable domain key. This preserves the
// authoritative integer final exactly without inventing an independent score.
function allocateIntegerTerms(terms, target) {
  const allocated = terms.map((term) => ({ ...term, deltaSteps: Math.trunc(Number(term.rawDelta) || 0) }));
  let remainder = integer(target) - allocated.reduce((sum, term) => sum + term.deltaSteps, 0);
  if (remainder === 0 || allocated.length === 0) return allocated;
  const sign = remainder > 0 ? 1 : -1;
  const ranked = [...allocated].sort((a, b) => {
    const af = Math.abs((Number(a.rawDelta) || 0) - Math.trunc(Number(a.rawDelta) || 0));
    const bf = Math.abs((Number(b.rawDelta) || 0) - Math.trunc(Number(b.rawDelta) || 0));
    if (bf !== af) return bf - af;
    return String(a.orderKey).localeCompare(String(b.orderKey));
  });
  for (let index = 0; remainder !== 0; index = (index + 1) % ranked.length) {
    ranked[index].deltaSteps += sign;
    remainder -= sign;
  }
  return allocated;
}

async function computeSettlementAttributionVector({
  participants = [], effects = [], globalEvents = [], eventsByUserId = null, score,
}) {
  if (typeof score !== "function") throw new TypeError("canonical score callback is required");
  const orderedEffects = chronological(effects).filter((effect) => effect?.id);
  const orderedEvents = [...new Map(
    chronological(globalEvents).filter((event) => event?.id)
      .map((event) => [event.id, event])
  ).values()];
  const participantIds = participants.map((participant) => participant.id).filter(Boolean);
  const baselineTotals = await score({
    effectIds: new Set(), globalEvents: [], eventsByUserId: new Map(),
  });
  let previous = baselineTotals;
  const rawTermsByParticipant = new Map(participantIds.map((id) => [id, []]));

  const includedEffects = new Set();
  for (const effect of orderedEffects) {
    includedEffects.add(effect.id);
    const next = await score({
      effectIds: new Set(includedEffects), globalEvents: [], eventsByUserId: new Map(),
    });
    for (const participant of participants) {
      const id = participant.id;
      const rawDelta = (Number(next.get(id)) || 0) - (Number(previous.get(id)) || 0);
      rawTermsByParticipant.get(id)?.push({
        kind: "effect", effectId: effect.id, powerupType: effect.type,
        rawDelta, orderKey: `0:${effect.id}`,
      });
    }
    previous = next;
  }

  const includedEvents = [];
  for (const event of orderedEvents) {
    includedEvents.push(event);
    const includedIds = new Set(includedEvents.map((row) => row.id));
    const includedByUserId = eventsByUserId
      ? new Map(participants.map((participant) => {
          const rows = eventsByUserId instanceof Map
            ? eventsByUserId.get(participant.userId) || []
            : eventsByUserId[participant.userId] || [];
          return [participant.userId, rows.filter((row) => includedIds.has(row.id))];
        }))
      : null;
    const next = await score({
      effectIds: new Set(includedEffects),
      globalEvents: [...includedEvents],
      eventsByUserId: includedByUserId,
    });
    for (const participant of participants) {
      const id = participant.id;
      const participantEvents = eventsByUserId
        ? (eventsByUserId instanceof Map
          ? eventsByUserId.get(participant.userId) || []
          : eventsByUserId[participant.userId] || [])
        : [];
      const localEligible = event.scheduleMode !== "LOCAL_ENTITLEMENTS" ||
        participantEvents.some((row) => row?.id === event.id || row?.eventId === event.id);
      // Legacy-global attribution remains race-wide. Local-mode lifecycle rows
      // exist only for a participant whose authoritative event map contains
      // this event; otherwise a zero row would falsely increase raceCount and
      // keep retention dependencies alive.
      if (!localEligible) continue;
      const rawDelta = (Number(next.get(id)) || 0) - (Number(previous.get(id)) || 0);
      rawTermsByParticipant.get(id)?.push({
        kind: "global", eventId: event.id, rawDelta, orderKey: `1:${event.id}`,
      });
    }
    previous = next;
  }

  const finalTotals = previous;
  const effectImpacts = [];
  const globalImpacts = [];
  for (const participant of participants) {
    const id = participant.id;
    const target = (Number(finalTotals.get(id)) || 0) - (Number(baselineTotals.get(id)) || 0);
    const allocated = allocateIntegerTerms(rawTermsByParticipant.get(id) || [], target);
    for (const term of allocated) {
      if (term.kind === "effect") {
        // No row for a zero-impact effect: the user-facing feed/modal has no
        // explanation to show, while the unique key still protects retries.
        if (term.deltaSteps !== 0) effectImpacts.push({
          participantId: id, userId: participant.userId, effectId: term.effectId,
          powerupType: term.powerupType, deltaSteps: term.deltaSteps,
        });
      } else {
        // Global enrollment is lifecycle data: zero rows are intentional and
        // prove the summary worker may finalize the event/user group.
        globalImpacts.push({
          participantId: id, userId: participant.userId, eventId: term.eventId,
          deltaSteps: term.deltaSteps,
        });
      }
    }
  }
  return { attributionVersion: ATTRIBUTION_VERSION, baselineTotals, finalTotals, effectImpacts, globalImpacts };
}

// Bounded active-boundary attribution consumes one instrumented canonical
// scorer capture instead of invoking the scorer once for every historical
// prefix. The capture owns the raw, pre-integer marginal terms for the complete
// chronological prefix ending at the latest selected source. Integer ownership
// is then allocated once across that complete vector, exactly like settlement,
// before the selected due rows are extracted.
async function computeSelectedPrefixAttributionVector({
  participants = [],
  effects = [],
  selectedEffectIds,
  scoreRawPrefixTerms,
}) {
  if (typeof scoreRawPrefixTerms !== "function") {
    throw new TypeError("instrumented raw-prefix scorer is required");
  }
  const selected = selectedEffectIds instanceof Set
    ? selectedEffectIds
    : new Set(selectedEffectIds || []);
  const ordered = [...new Map(
    chronological(effects).filter((effect) => effect?.id)
      .map((effect) => [effect.id, effect])
  ).values()];
  let lastSelectedIndex = -1;
  for (let index = 0; index < ordered.length; index++) {
    if (selected.has(ordered[index].id)) lastSelectedIndex = index;
  }
  if (lastSelectedIndex < 0) {
    const empty = new Map();
    return {
      attributionVersion: ATTRIBUTION_VERSION,
      baselineTotals: empty,
      finalTotals: empty,
      effectImpacts: [],
      selectedEffectImpacts: [],
      scorerCalls: 0,
    };
  }
  const orderedEffects = ordered.slice(0, lastSelectedIndex + 1);
  const capture = await scoreRawPrefixTerms({ orderedEffects });
  const baselineTotals = capture?.baselineTotals;
  const finalTotals = capture?.finalTotals;
  const rawTermsByParticipant = capture?.rawTermsByParticipant;
  if (
    !(baselineTotals instanceof Map) ||
    !(finalTotals instanceof Map) ||
    !(rawTermsByParticipant instanceof Map)
  ) {
    throw new TypeError("invalid raw-prefix scorer capture");
  }

  const effectImpacts = [];
  for (const participant of participants) {
    const participantId = participant.id;
    const target = (Number(finalTotals.get(participantId)) || 0) -
      (Number(baselineTotals.get(participantId)) || 0);
    const allocated = allocateIntegerTerms(
      rawTermsByParticipant.get(participantId) || [],
      target,
    );
    for (const term of allocated) {
      if (term.kind !== "effect" || term.deltaSteps === 0) continue;
      effectImpacts.push({
        participantId,
        userId: participant.userId,
        effectId: term.effectId,
        powerupType: term.powerupType,
        deltaSteps: term.deltaSteps,
      });
    }
  }
  return {
    attributionVersion: ATTRIBUTION_VERSION,
    baselineTotals,
    finalTotals,
    effectImpacts,
    selectedEffectImpacts: effectImpacts.filter((row) => selected.has(row.effectId)),
    scorerCalls: 1,
  };
}

module.exports = {
  ATTRIBUTION_VERSION,
  chronological,
  allocateIntegerTerms,
  computeSettlementAttributionVector,
  computeSelectedPrefixAttributionVector,
};
