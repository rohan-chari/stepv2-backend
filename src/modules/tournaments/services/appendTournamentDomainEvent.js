const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");

function occurrenceIdFor(payload) {
  if (payload.type === "TOURNAMENT_INVITE_SENT") {
    // Tournament-participant rows are reused when a declined invite is sent
    // again. The base key belongs to the first invite; reopened transitions
    // carry their committed row timestamp as a distinct immutable occurrence.
    return payload.eventOccurrenceId || payload.inviteId;
  }
  if (["TOURNAMENT_STARTED", "TOURNAMENT_ROUND_STARTED"].includes(payload.type)) return payload.roundId;
  if (["TOURNAMENT_MATCHUP_WON", "TOURNAMENT_ELIMINATED"].includes(payload.type)) return payload.matchupId;
  if (["TOURNAMENT_CHAMPION", "TOURNAMENT_COMPLETED"].includes(payload.type)) return payload.completionId;
  if (payload.type === "TOURNAMENT_CANCELLED") return payload.cancellationId;
  return null;
}

function buildAppendTournamentDomainEvent(dependencies = {}) {
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  return async function appendTournamentDomainEvent(tx, payload, { occurredAt = new Date() } = {}) {
    const occurrenceId = occurrenceIdFor(payload);
    if (!occurrenceId || !payload?.userId || !payload?.tournamentId) {
      const error = new Error(`${payload?.type || "tournament event"} requires occurrence, tournament, and recipient IDs`);
      error.code = "TOURNAMENT_DOMAIN_EVENT_ID_REQUIRED";
      throw error;
    }
    const eventType = `${payload.type}_V1`;
    const eventPayload = { ...payload };
    delete eventPayload.type;
    delete eventPayload.userId;
    delete eventPayload.eventOccurrenceId;
    const facts = {};
    for (const key of ["opponentName", "label", "nextLabel", "buyInAmount"]) {
      if (payload[key] !== undefined) facts[key] = payload[key];
    }
    return appendDomainEvent(tx, {
      eventKey: `${eventType}:${occurrenceId}:${payload.userId}`,
      eventType,
      schemaVersion: 1,
      aggregateType: "TOURNAMENT",
      aggregateId: payload.tournamentId,
      occurredAt,
      payload: eventPayload,
      audience: [{ recipientId: payload.userId, facts }],
    });
  };
}

module.exports = { buildAppendTournamentDomainEvent };
