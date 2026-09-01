const COUNT_FIELDS = Object.freeze([
  "messages", "activity", "friends", "races", "tournaments", "items",
  "powerups", "inventory", "participants", "blocks",
]);
const {
  runWithRequestQueryCounter,
  currentRequestQueryCount,
} = require("./requestQueryCounter");

function buildApiContractMetric({ body, statusCode, durationMs = 0, request = {}, sqlCount = null }) {
  if (!body || typeof body !== "object" || typeof body.contract !== "string") return null;
  const resultCounts = {};
  for (const field of COUNT_FIELDS) {
    if (Array.isArray(body[field])) resultCounts[field] = body[field].length;
  }
  const tournament = body.tournament;
  const bracketRaceCount = Array.isArray(tournament?.races)
    ? tournament.races.length
    : Array.isArray(tournament?.matchups)
      ? tournament.matchups.length
      : null;
  return {
    event: "api_contract_performance",
    endpoint: body.contract,
    contract: body.contract,
    outcome: Number(statusCode) < 400 ? "success" : "error",
    statusCode: Number(statusCode) || 200,
    durationMs: Math.max(0, Number(durationMs) || 0),
    responseBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
    resultCounts,
    ...(Number.isInteger(sqlCount) ? { sqlCount } : {}),
    ...(body.contract === "race-message-streams-v1"
      ? { messageMode: request.query?.activity === "false" ? "activity_only" : "combined" }
      : {}),
    ...(bracketRaceCount == null ? {} : { bracketRaceCount }),
  };
}

function createApiContractLogSampler({ successEvery = 100 } = {}) {
  const counts = new Map();
  const interval = Math.max(1, Number(successEvery) || 100);
  return ({ contract, statusCode }) => {
    if (typeof contract !== "string") return false;
    if (Number(statusCode) >= 400) return true;
    const count = counts.get(contract) || 0;
    counts.set(contract, count + 1);
    return count % interval === 0;
  };
}

function createApiContractTelemetry({
  logger = console,
  now = () => Date.now(),
  successEvery = 100,
} = {}) {
  const shouldLog = createApiContractLogSampler({ successEvery });
  return function apiContractTelemetry(req, res, next) {
    const startedAt = now();
    const sendJson = res.json.bind(res);
    res.json = function instrumentedJson(body) {
      if (!shouldLog({ contract: body?.contract, statusCode: res.statusCode })) {
        return sendJson(body);
      }
      const metric = buildApiContractMetric({
        body,
        statusCode: res.statusCode,
        durationMs: now() - startedAt,
        request: req,
        sqlCount: currentRequestQueryCount(),
      });
      if (metric) logger.log(JSON.stringify(metric));
      return sendJson(body);
    };
    return runWithRequestQueryCounter(next);
  };
}

module.exports = {
  buildApiContractMetric,
  createApiContractLogSampler,
  createApiContractTelemetry,
};
