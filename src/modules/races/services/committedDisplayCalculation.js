// Process-local optimization only. Losing this bounded witness requires FULL
// scoring; it never loses durable work. Every hit still uses the normal input
// fingerprint and generation fence before publication.
const { raceTimeZone } = require('../raceTimeZone');
const MAX_ENTRIES = 8;
const MAX_BYTES = 1024 * 1024;
const MAX_AGE_MS = 60_000;

function eligible(fingerprint, now) {
  const race = fingerprint?.race;
  return Boolean(fingerprint?.digest && race?.status === 'ACTIVE' &&
    !race.isTeamRace && Number(race.startedAt) <= now.getTime() &&
    Number(race.endsAt) > now.getTime() &&
    fingerprint.nextSampleBoundary == null &&
    Array.isArray(fingerprint.scoringEffects) && fingerprint.scoringEffects.length === 0 &&
    Array.isArray(fingerprint.globalEvents) && fingerprint.globalEvents.length === 0);
}
function day(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function buildCommittedDisplayCalculationCache() {
  const entries = new Map();
  const key = (job) => JSON.stringify([job.raceId, job.processingTimeZone || 'UTC',
    [...new Set(job.processingTriggeredByUserIds || [])].sort()]);
  return {
    get(job, fingerprint, now) {
      const entry = entries.get(key(job));
      if (!entry || !eligible(fingerprint, now) || entry.digest !== fingerprint.digest ||
          now.getTime() < entry.createdAt || now.getTime() >= entry.expiresAt ||
          day(now, raceTimeZone(fingerprint.race, job.processingTimeZone || 'UTC')) !== entry.scoringDay ||
          day(now, raceTimeZone(fingerprint.race, 'UTC')) !== entry.boxDay) return null;
      const result = structuredClone(entry.result);
      // Names are deliberately excluded from the scoring digest. Bind current
      // presentation rather than replaying a user's old name from the witness.
      const participants = new Map(fingerprint.participants.map(p => [p.id, p]));
      for (const participant of result.race.participants) {
        const current = participants.get(participant.id);
        if (current?.user && participant.user) participant.user.displayName = current.user.displayName;
      }
      result.displayCapture.asOf = now;
      result.activeImpactCapture.asOf = now;
      return result;
    },
    put(job, fingerprint, result, now) {
      if (!eligible(fingerprint, now) || !result?.displayCapture || !result?.activeImpactCapture) return;
      // This path deliberately excludes effects, future samples, global events
      // and team heartbeats. Do not broaden it without canonical parity tests.
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) return;
      const capturedAt = new Date(result.displayCapture.asOf);
      if (!Number.isFinite(capturedAt.getTime()) || capturedAt > now ||
          now.getTime() >= capturedAt.getTime() + MAX_AGE_MS) return;
      const k = key(job);
      entries.delete(k);
      entries.set(k, {digest:fingerprint.digest, result:structuredClone(result),
        createdAt:capturedAt.getTime(), expiresAt:Math.min(capturedAt.getTime()+MAX_AGE_MS, Number(fingerprint.race.endsAt)),
        scoringDay:day(capturedAt, raceTimeZone(fingerprint.race, job.processingTimeZone || 'UTC')),
        boxDay:day(capturedAt, raceTimeZone(fingerprint.race, 'UTC'))});
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    },
  };
}
module.exports = { buildCommittedDisplayCalculationCache };
