const {
  appSettings: defaultAppSettings,
  ACTIVE_COMPETITION_LIMIT_MINIMUM,
  ACTIVE_COMPETITION_LIMIT_MAXIMUM,
} = require("../../../shared/config/appSettings");
const {
  buildGetActiveCompetitionLimit,
} = require("../queries/getActiveCompetitionLimit");

function invalidLimitError() {
  const error = new Error(
    `activeCompetitionLimit must be an integer from ${ACTIVE_COMPETITION_LIMIT_MINIMUM} to ${ACTIVE_COMPETITION_LIMIT_MAXIMUM}`,
  );
  error.statusCode = 400;
  error.code = "INVALID_ACTIVE_COMPETITION_LIMIT";
  return error;
}

function buildSetActiveCompetitionLimit(dependencies = {}) {
  const settings = dependencies.appSettings || defaultAppSettings;
  const getActiveCompetitionLimit =
    dependencies.getActiveCompetitionLimit ||
    buildGetActiveCompetitionLimit(dependencies);
  const logger = dependencies.logger || console;
  return async function setActiveCompetitionLimit(body) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "activeCompetitionLimit")
    ) {
      throw invalidLimitError();
    }
    const value = body.activeCompetitionLimit;
    if (
      !Number.isInteger(value) ||
      value < ACTIVE_COMPETITION_LIMIT_MINIMUM ||
      value > ACTIVE_COMPETITION_LIMIT_MAXIMUM
    ) {
      throw invalidLimitError();
    }
    await settings.setActiveCompetitionLimit(value, { logger });
    return getActiveCompetitionLimit();
  };
}

const setActiveCompetitionLimit = buildSetActiveCompetitionLimit();

module.exports = {
  buildSetActiveCompetitionLimit,
  setActiveCompetitionLimit,
  invalidLimitError,
};
