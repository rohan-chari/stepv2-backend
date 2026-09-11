// Passive observation at the public worker boundary, like observe-fingerprint.cjs.
// Every call still executes the production implementation with its actual DB.
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const reads = [];
const { prisma } = require('../../../src/db');
prisma.$on('query', query => context.getStore()?.queries.push(query.query));
const originalQuery = prisma.$queryRawUnsafe;
prisma.$queryRawUnsafe = async function(...args) {
  const result = await originalQuery.apply(this, args);
  const observation = context.getStore();
  if (observation) (observation.statements ||= []).push({ sql: args[0], params: args.slice(1) });
  if (observation && args[0].includes('AS "r_id"')) {
    observation.rosterJsonBytes = Buffer.byteLength(JSON.stringify(result));
    observation.witnessJsonBytes = Buffer.byteLength(JSON.stringify(result.map(r => r.f_witness ?? null)));
    observation.witnesses = result.map(r => r.f_witness);
  }
  return result;
};
const moduleUnderObservation = require('../../../src/modules/races/services/raceResolutionInputFingerprint');
const original = moduleUnderObservation.buildRaceResolutionInputFingerprint;
moduleUnderObservation.buildRaceResolutionInputFingerprint = async function(options) {
  const observation = { transaction: !!options.client, queries: [], now: options.now };
  return context.run(observation, async () => {
    try { observation.value = await original(options); }
    catch (error) { console.error('Observed fingerprint failure:', error); throw error; }
    reads.push(observation);
    return observation.value;
  });
};
module.exports = { reads };
