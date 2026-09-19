const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBillingEnvironmentAllowed } = require('../../../src/modules/billing/services/billingEnvironmentPolicy');

test('billing environment policy allows normal realms and one-way admin TestFlight sandbox fulfillment', () => {
  assert.equal(isBillingEnvironmentAllowed({
    identityEnvironment: 'production',
    purchaseEnvironment: 'production',
  }), true);

  assert.equal(isBillingEnvironmentAllowed({
    identityEnvironment: 'sandbox',
    purchaseEnvironment: 'sandbox',
  }), true);

  assert.equal(isBillingEnvironmentAllowed({
    identityEnvironment: 'production',
    purchaseEnvironment: 'sandbox',
    allowSandboxForProduction: true,
  }), true);

  assert.equal(isBillingEnvironmentAllowed({
    identityEnvironment: 'production',
    purchaseEnvironment: 'sandbox',
  }), false);

  assert.equal(isBillingEnvironmentAllowed({
    identityEnvironment: 'sandbox',
    purchaseEnvironment: 'production',
    allowSandboxForProduction: true,
  }), false);
});
