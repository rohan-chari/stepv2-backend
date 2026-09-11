// Fixture persistence only; all observed behavior goes through real HTTP.
async function createSavedRecap(prisma, { event, userId, extraRaceSteps, raceCount = 1, ...other }) {
  await prisma.globalStepEvent.update({ where: { id: event.id }, data: { scheduleMode: 'LOCAL_ENTITLEMENTS' } });
  await prisma.globalStepEventEntitlement.upsert({
    where: { eventId_userId: { eventId: event.id, userId } }, update: {},
    create: { eventId: event.id, userId, timezone: 'UTC', localDate: event.startsAt.toISOString().slice(0,10),
      startsAt: event.startsAt, endsAt: event.endsAt, startOutcome: 'ACTIVATED_ON_TIME',
      startProcessedAt: event.startsAt, recapRaceCount: raceCount, recapCountPolicyVersion: 1, recapWindowRevision: 0 },
  });
  return prisma.eventRecap.create({ data: { eventId: event.id, userId, extraRaceSteps, raceCount,
    calculationVersion: 'LEGACY_SAVED', suppressed: extraRaceSteps <= 0,
    expiresAt: new Date(Date.now()+3600000), ...other } });
}
module.exports = { createSavedRecap };
