const { prisma } = require('../../../db');
const { readFragment } = require('../../../shared/cache/cacheEfficiencyRead');
const schemas = require('./raceOpenDisplaySchema.json');
const prismaTypes = require('@prisma/client');
const scalarSelect = name => Object.fromEntries(schemas[name].map(field => [field.name, true]));
const encode = value => JSON.parse(JSON.stringify(value));
function validScalar(name, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  return Object.keys(row).length === schemas[name].length && schemas[name].every(({ name: key, type, required }) => {
    if (!Object.hasOwn(row, key)) return false;
    const value = row[key];
    if (value === null) return !required;
    if (type === 'DateTime') return typeof value === 'string' && Number.isFinite(Date.parse(value));
    if (type === 'Int') return Number.isSafeInteger(value);
    if (type === 'Boolean') return typeof value === 'boolean';
    if (type === 'Json') return typeof value === 'object';
    return typeof value === 'string' && (type === 'String' || Object.values(prismaTypes[type] || {}).includes(value));
  });
}
function restore(name, row) {
  if (!row) return row;
  const result = { ...row };
  for (const { name: key, type } of schemas[name]) if (type === 'DateTime' && result[key] != null) result[key] = new Date(result[key]);
  return result;
}
const marker = (domain, identity) => ({ domain, identity });
async function fragment(surface, identity, markers, load, validate, ttlMs = 30000) {
  return (await readFragment({ kind: `race-open-${surface}`, key: `ce:v1:race-open:${surface}:${identity}`, markers, ttlMs, load, validate })).value;
}
async function core(raceId) {
  const value = await fragment('core', raceId, [marker('race-meta', raceId)], async () => {
    const row = await require('./raceDisplayFragments').loadCore(raceId, { where: { id: raceId }, include: { seed: { select: { kind: true } }, tournament: { select: { id: true, name: true, bracketSize: true } } } });
    if (!row) return null;
    const { seed, tournament, ...scalars } = row;
    return { scalars: encode(scalars), seed, tournament };
  }, value => value === null || (validScalar('Race', value.scalars) &&
    (value.seed === null || typeof value.seed?.kind === 'string') &&
    (value.tournament === null || (typeof value.tournament?.id === 'string' && typeof value.tournament.name === 'string' && Number.isSafeInteger(value.tournament.bracketSize)))), 300000);
  if (!value) return null;
  const row = { ...restore('Race', value.scalars), seed: value.seed, tournament: value.tournament };
  const ids = [row.creatorId, row.winnerUserId].filter(Boolean);
  const people = await require('../../social/services/userPresentationCache').getMany(ids, true);
  const person = id => { const p = people.get(id); return p ? { id: p.id, displayName: p.displayName, profilePhotoUrl: p.profilePhotoUrl } : null; };
  row.creator = person(row.creatorId); row.winner = person(row.winnerUserId);
  return row;
}
async function participant(raceId, participantId, userId = null) {
  const value = await fragment('participant', `${raceId}:${participantId}`, [marker('participant-display', participantId), marker('participant-display', `race:${raceId}`), marker('race-members', raceId), ...(userId ? [marker('participant-display', `${raceId}:${userId}`)] : [])],
    async () => encode(await prisma.raceParticipant.findUnique({ where: { id: participantId }, select: scalarSelect('RaceParticipant') })),
    value => value === null || validScalar('RaceParticipant', value));
  return restore('RaceParticipant', value);
}
// This deliberately remains one current PostgreSQL statement. Display cache
// invalidation cannot guarantee revocation during partial Redis failure.
async function accessContext(raceId, userId) {
  // Finish display hydration before checking current authorization and team
  // size. A resize while Redis/core loading awaits cannot be overwritten by
  // an older gate result afterward.
  const race = await core(raceId);
  const [gate] = await prisma.$queryRawUnsafe(`/* race-open:authoritative-access */
    SELECT r.id, r.status::text AS status, r.is_public AS "isPublic", r.seeded_bucket_id AS "seededBucketId", r.tournament_id AS "tournamentId", r.is_team_race AS "isTeamRace", r.team_size AS "teamSize",
      p.id AS "participantId", p.status::text AS "participantStatus", p.forfeited_at AS "forfeitedAt",
      EXISTS (SELECT 1 FROM tournament_participants tp WHERE tp.tournament_id=r.tournament_id AND tp.user_id=$2 AND tp.status='accepted') AS "tournamentAccepted"
    FROM races r LEFT JOIN race_participants p ON p.race_id=r.id AND p.user_id=$2 WHERE r.id=$1`, raceId, userId);
  if (!gate) return null;
  if (!race) return null;
  const mine = gate.participantId ? await participant(raceId, gate.participantId, userId) : null;
  Object.assign(race, { status: gate.status.toUpperCase(), isPublic: gate.isPublic, seededBucketId: gate.seededBucketId, tournamentId: gate.tournamentId, isTeamRace: gate.isTeamRace, teamSize: gate.teamSize });
  race.participants = gate.participantId ? [{ ...(mine || { id: gate.participantId, raceId, userId }), status: gate.participantStatus.toUpperCase(), forfeitedAt: gate.forfeitedAt }] : [];
  if (race.tournament) race.tournament = { ...race.tournament, participants: gate.tournamentAccepted ? [{ userId }] : [] };
  Object.defineProperty(race, '_bootstrapReadViewer', { value: userId });
  return race;
}
async function fullDisplayContext(raceId, { race = null, userId } = {}) {
  const display = race || await accessContext(raceId, userId);
  if (!display) return null;
  const rows = await fragment('roster', raceId, [marker('race-members', raceId), marker('participant-display', `race:${raceId}`), marker('participant-display', `roster:${raceId}`)],
    async () => encode(await prisma.raceParticipant.findMany({ where: { raceId }, select: scalarSelect('RaceParticipant'), orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] })),
    value => Array.isArray(value) && value.length <= 10000 && value.every(row => validScalar('RaceParticipant', row)));
  let participants = rows.map(row => restore('RaceParticipant', row));
  if (display._bootstrapReadViewer === userId) {
    const mine = display.participants.find(row => row.userId === userId);
    // An old roster must never revive membership removed during failed Redis
    // invalidation. The fresh access context is authoritative for this viewer.
    participants = participants.filter(row => row.userId !== userId);
    if (mine) participants.push(mine);
    participants.sort((a,b) => a.joinedAt-b.joinedAt || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
  }
  return { ...display, participants };
}
async function effects(raceId) {
  const value = await fragment('effects', raceId, [marker('race-effects', raceId), marker('race-effects-display', raceId)], async () => encode(await prisma.raceActiveEffect.findMany({ where: { raceId, status: 'ACTIVE' }, select: scalarSelect('RaceActiveEffect'), orderBy: { createdAt: 'asc' } })),
    value => Array.isArray(value) && value.length <= 10000 && value.every(row => validScalar('RaceActiveEffect', row)),
    rows => Math.min(30000, ...rows.flatMap(row => [row.startsAt, row.expiresAt].map(at => at ? Date.parse(at) - Date.now() : Infinity).filter(ms => ms > 0))));
  // A worker may not yet have persisted EXPIRED. Stop displaying finite
  // effects at their real deadline while preserving future and null-expiry rows.
  const nowMs = Date.now();
  return value.filter(row => row.expiresAt === null || Date.parse(row.expiresAt) > nowMs)
    .map(row => restore('RaceActiveEffect', row));
}
async function preview(raceId, userId, load) {
  return fragment('preview', `${raceId}:${userId}`, [marker('race-summary', raceId), marker('race-members', raceId)], load,
    row => row === null || (['position','totalParticipants','minTotalSteps','maxTotalSteps','myTotalSteps'].every(key => Number.isSafeInteger(row[key])) && Object.keys(row).length === 5));
}
async function usedTypes(participantId, load) {
  return fragment('used-types', participantId, [marker('participant-use-history', participantId)], load,
    rows => Array.isArray(rows) && rows.length <= 256 && rows.every(type => typeof type === 'string'));
}
module.exports = { fullDisplayContext, core, participant, accessContext, effects, preview, usedTypes, fragment, marker };
