const { ValidationError, ConflictError } = require("../../../shared/errors/AppError");
const { DeviceRegistration: defaultDeviceRegistration } = require("../models/deviceRegistration");
const { validateToken, validateInstallationId } = require("./registerDeviceToken");

function buildRemoveDeviceToken(dependencies = {}) {
  const registrations = dependencies.DeviceRegistration || defaultDeviceRegistration;
  return async function removeDeviceToken({ userId, body = {} }) {
    if (body.deviceToken == null && body.installationId == null) {
      throw new ValidationError(
        "deviceToken or installationId is required",
        "DEVICE_REGISTRATION_IDENTIFIER_REQUIRED",
      );
    }
    const token = validateToken(body.deviceToken, { optional: true });
    const installationId = validateInstallationId(body.installationId);
    const result = await registrations.remove({ userId, token, installationId });
    if (result.mismatch) {
      throw new ConflictError(
        "deviceToken and installationId identify different registrations",
        "REGISTRATION_MISMATCH",
      );
    }
    return { success: true, removed: result.removed };
  };
}

module.exports = { buildRemoveDeviceToken };
