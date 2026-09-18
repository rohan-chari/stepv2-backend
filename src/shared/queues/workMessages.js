const STEP_SYNC_VERSION = 1;
const POWERUP_RECALC_VERSION = 1;
const RACE_DIRTY_VERSION = 1;
const GLOBAL_EVENT_BOUNDARY_VERSION = 1;
const NOTIFICATION_DELIVERY_VERSION = 1;

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
    legacyEventRecap: fields.legacyEventRecap === "true",
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

function parseGlobalEventBoundary(fields) {
  if (Number(fields.schemaVersion) !== GLOBAL_EVENT_BOUNDARY_VERSION) {
    throw new TypeError("unsupported GLOBAL_EVENT_BOUNDARY schemaVersion");
  }
  const boundaryType = required(fields, "boundaryType");
  if (!["START", "END"].includes(boundaryType)) {
    throw new TypeError("boundaryType is invalid");
  }
  return {
    schemaVersion: GLOBAL_EVENT_BOUNDARY_VERSION,
    boundaryType,
    entitlementId: required(fields, "entitlementId"),
    scheduleRevision: Number(fields.scheduleRevision || 0),
    scheduledAt: required(fields, "scheduledAt"),
    enqueuedAt: required(fields, "enqueuedAt"),
  };
}

function parseNotificationDelivery(fields) {
  if (Number(fields.schemaVersion) !== NOTIFICATION_DELIVERY_VERSION) {
    throw new TypeError("unsupported NOTIFICATION_DELIVERY schemaVersion");
  }
  return {
    schemaVersion: NOTIFICATION_DELIVERY_VERSION,
    recipientUserId: required(fields, "recipientUserId"),
    type: required(fields, "type"),
    deliveryKey: required(fields, "deliveryKey"),
    sourceType: required(fields, "sourceType"),
    sourceId: required(fields, "sourceId"),
    sourceRevision: Number(fields.sourceRevision || 0),
    availableAt: required(fields, "availableAt"),
    expiresAt: required(fields, "expiresAt"),
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
    timeZone: fields.timeZone || null,
    sourceGeneration: fields.sourceGeneration
      ? integerString(fields.sourceGeneration, "sourceGeneration")
      : null,
    jobGeneration: fields.jobGeneration
      ? integerString(fields.jobGeneration, "jobGeneration")
      : null,
    reason: required(fields, "reason"),
    requestedAt: required(fields, "requestedAt"),
  };
}

module.exports = {
  STEP_SYNC_VERSION,
  POWERUP_RECALC_VERSION,
  RACE_DIRTY_VERSION,
  GLOBAL_EVENT_BOUNDARY_VERSION,
  NOTIFICATION_DELIVERY_VERSION,
  parseStepSync,
  parsePowerupRecalc,
  parseRaceDirty,
  parseGlobalEventBoundary,
  parseNotificationDelivery,
};
