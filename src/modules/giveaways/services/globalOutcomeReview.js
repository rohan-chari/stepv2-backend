const { ConflictError } = require("../../../shared/errors/AppError");

function addRapidClusterFacts(facts, implicated) {
  const ordered = [...facts].sort((a, b) => new Date(a.qualifiedAt) - new Date(b.qualifiedAt) || a.id.localeCompare(b.id));
  let right = 0;
  for (let left = 0; left < ordered.length; left += 1) {
    if (right < left + 1) right = left + 1;
    while (right < ordered.length && new Date(ordered[right].qualifiedAt) - new Date(ordered[left].qualifiedAt) <= 60 * 60 * 1000) right += 1;
    if (right - left >= 2) {
      for (let index = left; index < right; index += 1) implicated.add(ordered[index].id);
    }
  }
}

async function implicatedFactsForEntrant({ contest, row, db }) {
  const facts = row.auditFacts || [];
  const implicated = new Set(facts.filter((fact) => fact.status === "FLAGGED").map((fact) => fact.id));

  const raceGroups = new Map();
  const identityGroups = new Map();
  for (const fact of facts) {
    if (fact.qualifyingRaceId) {
      if (!raceGroups.has(fact.qualifyingRaceId)) raceGroups.set(fact.qualifyingRaceId, []);
      raceGroups.get(fact.qualifyingRaceId).push(fact);
    }
    if (fact.refereeIdentityHash) {
      if (!identityGroups.has(fact.refereeIdentityHash)) identityGroups.set(fact.refereeIdentityHash, []);
      identityGroups.get(fact.refereeIdentityHash).push(fact);
    }
    if (!fact.refereeId) implicated.add(fact.id);
  }
  for (const group of raceGroups.values()) if (group.length >= 2) group.forEach((fact) => implicated.add(fact.id));
  for (const group of identityGroups.values()) if (group.length >= 2) group.forEach((fact) => implicated.add(fact.id));
  addRapidClusterFacts(facts, implicated);

  const refereeIds = [...new Set(facts.map((fact) => fact.refereeId).filter(Boolean))];
  if (refereeIds.length) {
    const samples = await db.stepSample.findMany({
      where: { userId: { in: refereeIds }, periodStart: { gte: contest.startsAt, lt: contest.endsAt } },
      select: { userId: true, periodStart: true, steps: true, sourceDeviceId: true },
    });
    const deviceUsers = new Map();
    const signatureUsers = new Map();
    for (const sample of samples) {
      if (sample.sourceDeviceId) {
        if (!deviceUsers.has(sample.sourceDeviceId)) deviceUsers.set(sample.sourceDeviceId, new Set());
        deviceUsers.get(sample.sourceDeviceId).add(sample.userId);
      }
      const signature = `${new Date(sample.periodStart).toISOString()}:${sample.steps}`;
      if (!signatureUsers.has(signature)) signatureUsers.set(signature, new Set());
      signatureUsers.get(signature).add(sample.userId);
    }
    const suspiciousUsers = new Set();
    for (const [device, users] of deviceUsers) if (device && users.size >= 2) users.forEach((id) => suspiciousUsers.add(id));
    for (const users of signatureUsers.values()) if (users.size >= 2) users.forEach((id) => suspiciousUsers.add(id));
    facts.filter((fact) => suspiciousUsers.has(fact.refereeId)).forEach((fact) => implicated.add(fact.id));
  }

  const raceIds = [...raceGroups.keys()];
  if (raceIds.length) {
    const ownRows = await db.raceParticipant.findMany({
      where: { raceId: { in: raceIds }, userId: row.userId, status: "ACCEPTED" },
      select: { raceId: true },
    });
    const ownRaceIds = new Set(ownRows.map((participant) => participant.raceId));
    facts.filter((fact) => ownRaceIds.has(fact.qualifyingRaceId)).forEach((fact) => implicated.add(fact.id));
  }

  const referralCodes = [...new Set(facts.map((fact) => fact.referralCode).filter(Boolean))];
  if (referralCodes.length) {
    const opens = await db.linkOpen.findMany({
      where: { kind: "referral", code: { in: referralCodes }, createdAt: { gte: contest.startsAt, lt: contest.endsAt } },
      select: { ipHash: true, ipNetHash: true },
    });
    const counts = new Map();
    for (const open of opens) {
      for (const hash of [open.ipHash, open.ipNetHash].filter(Boolean)) counts.set(hash, (counts.get(hash) || 0) + 1);
    }
    if ([...counts.values()].some((count) => count >= 2)) facts.forEach((fact) => implicated.add(fact.id));
  }

  return implicated;
}

function outcomeRelevantRows(standings) {
  const leader = standings.find((row) => row.verifiedCount > 0) || null;
  if (!leader) return standings.filter((row) => row.reviewableCount > 0);
  return standings.filter((row) => row.entrantId === leader.entrantId || row.verifiedCount + row.reviewableCount >= leader.verifiedCount);
}

async function unresolvedGlobalOutcomeFacts({ contest, standings, db }) {
  try {
    const relevant = outcomeRelevantRows(standings);
    const implicated = new Set();
    for (const row of relevant) {
      const rowFacts = await implicatedFactsForEntrant({ contest, row, db });
      rowFacts.forEach((id) => implicated.add(id));
    }
    if (!implicated.size) return [];
    const reviews = await db.giveawayPointReview.findMany({
      where: { contestId: contest.id, referralFactId: { in: [...implicated] } },
      select: { referralFactId: true },
    });
    const decided = new Set(reviews.map((review) => review.referralFactId));
    return [...implicated].filter((id) => !decided.has(id)).sort();
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError("Contest review evidence is incomplete", "REVIEW_EVIDENCE_INCOMPLETE");
  }
}

module.exports = { implicatedFactsForEntrant, outcomeRelevantRows, unresolvedGlobalOutcomeFacts };
