const assert = require('node:assert/strict');
const { it } = require('node:test');
const { catalogFor, parseGoldMonthlyContractCutoverAt, readBillingConfig } = require('../../../src/modules/billing/catalog');

it('omits retired annual and permanent products from every active catalog', () => {
 const legacy = catalogFor('ios', { gold: false });
 const gold = catalogFor('ios', { gold: true });
 for (const catalog of [legacy, gold]) {
  assert.equal(catalog.some(p => p.id === 'plus_annual'), false);
  assert.equal(catalog.some(p => p.id === 'plus_permanent'), false);
 }
 assert.equal(legacy.some(p => p.id === 'plus_monthly'), true);
 assert.equal(gold.some(p => p.id === 'plus_weekly'), true);
 assert.equal(gold.some(p => p.id === 'plus_monthly'), true);
});

it('accepts a UTC cutover, normalizes it, and leaves a missing value disabled', () => {
 assert.equal(parseGoldMonthlyContractCutoverAt(undefined), null);
 assert.equal(parseGoldMonthlyContractCutoverAt('2026-09-16T12:34:56Z'), '2026-09-16T12:34:56.000Z');
 assert.equal(readBillingConfig({ BARA_GOLD_MONTHLY_CONTRACT_CUTOVER_AT: '2026-09-16T12:34:56Z' }).monthlyGoldContractCutoverAt, '2026-09-16T12:34:56.000Z');
});

it('rejects malformed or non-UTC cutover values before billing starts', () => {
 for (const value of ['not-a-date', '2026-09-16T12:34:56', '2026-09-16T12:34:56-04:00']) {
  assert.throws(() => parseGoldMonthlyContractCutoverAt(value), /BARA_GOLD_MONTHLY_CONTRACT_CUTOVER_AT/);
 }
});
