const { ValidationError } = require("../../../shared/errors/AppError");
const { User } = require("../models/user");
const {
  validateDiscoverableNameComponent,
  normalizeDiscoverableNameSearch,
  combinedDiscoverableName,
  suggestAvailableDisplayName,
} = require("../services/discoverableName");

function buildSetDiscoverableName(dependencies = {}) {
  const userModel = dependencies.User || User;

  return async function setDiscoverableName({ userId, firstName, lastName }) {
    const first = validateDiscoverableNameComponent(firstName, {
      required: true,
      label: "First name",
    });
    if (!first.valid) {
      throw new ValidationError(first.error, "INVALID_FIRST_NAME");
    }
    const last = validateDiscoverableNameComponent(lastName, {
      required: false,
      label: "Last name",
    });
    if (!last.valid) {
      throw new ValidationError(last.error, "INVALID_LAST_NAME");
    }

    const discoverableNameSearch = normalizeDiscoverableNameSearch(
      combinedDiscoverableName(first.value, last.value)
    );
    const user = await userModel.update(userId, {
      firstName: first.value,
      lastName: last.value,
      discoverableNameSearch,
    });
    const suggestedDisplayName = await suggestAvailableDisplayName({
      firstName: first.value,
      lastName: last.value,
      userModel,
      excludeUserId: userId,
    });
    return { user, suggestedDisplayName };
  };
}

const setDiscoverableName = buildSetDiscoverableName();

module.exports = { buildSetDiscoverableName, setDiscoverableName };
