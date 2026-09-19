const VALID_ENVIRONMENTS = new Set(['production', 'sandbox']);

function isBillingEnvironmentAllowed({
  identityEnvironment,
  purchaseEnvironment,
  allowSandboxForProduction = false,
}) {
  if (
    !VALID_ENVIRONMENTS.has(identityEnvironment) ||
    !VALID_ENVIRONMENTS.has(purchaseEnvironment)
  ) {
    return false;
  }
  if (identityEnvironment === purchaseEnvironment) return true;
  return (
    allowSandboxForProduction === true &&
    identityEnvironment === 'production' &&
    purchaseEnvironment === 'sandbox'
  );
}

module.exports = { isBillingEnvironmentAllowed };
