// Observe calls made by the real production entrypoint. Never invoke the
// fingerprint directly, substitute a result, or change the worker's behavior.
require("./observe-resolution.cjs");
const fingerprint = require("../../../../src/modules/races/services/raceResolutionInputFingerprint");
const build = fingerprint.buildRaceResolutionInputFingerprint;
fingerprint.buildRaceResolutionInputFingerprint = async function (options) {
  const value = await build(options);
  if (process.send)
    process.send({
      kind: "fingerprint",
      includePresentation: options.includePresentation !== false,
      balanceConfigVersion: options.balanceConfigVersion,
      value,
    });
  return value;
};
