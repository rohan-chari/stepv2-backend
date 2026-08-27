const { ValidationError } = require("../../../shared/errors/AppError");
const { DeviceRegistration: defaultDeviceRegistration } = require("../models/deviceRegistration");
const { isTokenLifecycleRequired } = require("../../steps/models/globalStepEventGeneration");

const INSTALLATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function validation(message, code) {
  throw new ValidationError(message, code);
}

function validateToken(value, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string" || value.length === 0) {
    validation("deviceToken is required", "DEVICE_TOKEN_REQUIRED");
  }
  if (Buffer.byteLength(value, "utf8") > 4096) {
    validation("deviceToken must be at most 4096 bytes", "DEVICE_TOKEN_TOO_LONG");
  }
  return value;
}

function validateInstallationId(value, { optional = true } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string" || !INSTALLATION_ID.test(value)) {
    validation("installationId is invalid", "INSTALLATION_ID_INVALID");
  }
  return value;
}

function pinnedIosEnvironment(env = process.env) {
  return env.NODE_ENV === "production" || env.APNS_PRODUCTION === "true"
    ? "production"
    : "sandbox";
}

function validateProviderEnvironment(platform, value, env = process.env) {
  if (platform !== "ios") return null;
  const pinned = pinnedIosEnvironment(env);
  if (value == null) return pinned;
  if (value !== "production" && value !== "sandbox") {
    validation("providerEnvironment is invalid", "PROVIDER_ENVIRONMENT_INVALID");
  }
  if (value !== pinned) {
    validation("providerEnvironment does not match this backend", "PROVIDER_ENVIRONMENT_MISMATCH");
  }
  return pinned;
}

function buildRegisterDeviceToken(dependencies = {}) {
  const registrations = dependencies.DeviceRegistration || defaultDeviceRegistration;
  const env = dependencies.env || process.env;
  const generationReady = dependencies.generationReady ||
    (() => isTokenLifecycleRequired({ now: new Date() }));
  return async function registerDeviceToken({ userId, body = {}, metrics = {} }) {
    const deviceToken = validateToken(body.deviceToken);
    if (body.platform !== "ios" && body.platform !== "android") {
      validation("platform must be 'ios' or 'android'", "DEVICE_PLATFORM_INVALID");
    }
    const installationId = validateInstallationId(body.installationId);
    const providerEnvironment = validateProviderEnvironment(body.platform, body.providerEnvironment, env);
    const lifecycleEnabled = await generationReady();
    await registrations.register({
      userId,
      token: deviceToken,
      platform: body.platform,
      installationId,
      providerEnvironment,
      ...metrics,
      lifecycleEnabled,
    });
    return {
      success: true,
      registrationVersion: 2,
      installationAccepted: installationId !== null,
    };
  };
}

module.exports = {
  INSTALLATION_ID,
  validateToken,
  validateInstallationId,
  validateProviderEnvironment,
  pinnedIosEnvironment,
  buildRegisterDeviceToken,
};
