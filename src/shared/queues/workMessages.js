const STEP_SYNC_VERSION = 1;
const POWERUP_RECALC_VERSION = 1;
const RACE_DIRTY_VERSION = 1;

function required(fields, name) {
  if (typeof fields?.[name] !== "string" || fields[name].length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return fields[name];
}

function integerString(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function parseStepSync(fields) {
  if (Number(fields.schemaVersion) !== STEP_SYNC_VERSION) {
    throw new TypeError("unsupported STEP_SYNC schemaVersion");
  }
  const canonicalJson = required(fields, "canonicalJson");
  let canonical;
  try { canonical = JSON.parse(canonicalJson); }
  catch { throw new TypeError("canonicalJson is invalid"); }
  return {
    schemaVersion: STEP_SYNC_VERSION,
    syncId: required(fields, "syncId"),
    userId: required(fields, "userId"),
    idempotencyKey: required(fields, "idempotencyKey"),
    timeZone: fields.timeZone || "UTC",
    homePull: fields.homePull === "true",
    requestHash: required(fields, "requestHash"),
    canonical,
    requestedAt: required(fields, "requestedAt"),
  };
}

function parsePowerupRecalc(fields) {
  if (Number(fields.schemaVersion) !== POWERUP_RECALC_VERSION) {
    throw new TypeError("unsupported POWERUP_RECALC schemaVersion");
  }
  return {
    schemaVersion: POWERUP_RECALC_VERSION,
    userId: required(fields, "userId"),
    raceId: required(fields, "raceId"),
    participantId: required(fields, "participantId"),
    sourceGeneration: integerString(fields.sourceGeneration, "sourceGeneration"),
    requestedAt: required(fields, "requestedAt"),
  };
}

function parseRaceDirty(fields) {
  if (Number(fields.schemaVersion) !== RACE_DIRTY_VERSION) {
    throw new TypeError("unsupported RACE_DIRTY schemaVersion");
  }
  return {
    schemaVersion: RACE_DIRTY_VERSION,
    raceId: required(fields, "raceId"),
    userId: fields.userId || null,
    sourceGeneration: fields.sourceGeneration
      ? integerString(fields.sourceGeneration, "sourceGeneration")
      : null,
    reason: required(fields, "reason"),
    requestedAt: required(fields, "requestedAt"),
  };
}

module.exports = {
  STEP_SYNC_VERSION,
  POWERUP_RECALC_VERSION,
  RACE_DIRTY_VERSION,
  parseStepSync,
  parsePowerupRecalc,
  parseRaceDirty,
};
