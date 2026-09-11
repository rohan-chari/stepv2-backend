// Durable event producers also write membership rows directly in SQL. Register
// the same post-commit hooks there; delivery of the outbox is not the fence.
const { raceChanged, membershipChanged } = require("./raceCacheInvalidation");
const efficiency = require("../../../shared/cache/cacheEfficiencyInvalidation");
const EVENTS = new Set([
  "RACE_CREATED", "RACE_INVITE_SENT", "RACE_INVITE_ACCEPTED", "RACE_INVITE_DECLINED",
  "RACE_PUBLIC_JOINED", "RACE_PARTICIPANT_LEFT", "RACE_PARTICIPANT_KICKED",
  "RACE_PARTICIPANT_FORFEITED", "RACE_TEAM_SWITCHED", "RACE_EDITED",
  "RACE_BUYIN_CHANGED", "RACE_STARTED", "RACE_COMPLETED", "RACE_CANCELLED",
  "RACE_RESULTS_SEEN",
]);
async function invalidateEvent(event) {
  const eventType = event.eventType.replace(/_V[0-9]+$/, "");
  if (event.aggregateType === "TOURNAMENT" || eventType.startsWith("TOURNAMENT_")) {
    await efficiency.afterCommit([{ domain: "event", identity: "public-race-discovery" }]);
    return;
  }
  if (!EVENTS.has(eventType)) return;
  const data = event.payload || {};
  const raceId = data.raceId || (event.aggregateType?.toLowerCase() === "race" ? event.aggregateId : null);
  if (!raceId) return;
  const ids = new Set([
    data.userId, data.creatorUserId, data.inviteeUserId, data.kickedUserId,
    ...(data.participantUserIds || []),
  ].filter(Boolean));
  if (["RACE_CREATED", "RACE_INVITE_SENT"].includes(eventType)) {
    for (const recipient of event.audience || []) ids.add(recipient.recipientId);
  }
  if (["RACE_CREATED", "RACE_EDITED", "RACE_BUYIN_CHANGED", "RACE_STARTED", "RACE_COMPLETED", "RACE_CANCELLED"].includes(eventType)) {
    await raceChanged(raceId);
  }
  await membershipChanged([
    { raceId }, ...[...ids].map((userId) => ({ raceId, userId })),
  ]);
}
module.exports = { invalidateEvent };
