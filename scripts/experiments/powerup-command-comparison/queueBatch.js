const { randomUUID } = require('node:crypto');
// These handlers insert self effects and feed rows. They do not mutate step
// totals, transfer inventory or require intermediate scorer persistence. All
// other commands remain ordered single-command execution boundaries.
const BATCH_TYPES = new Set(['COMPRESSION_SOCKS','MIRROR','UMBRELLA','DECOY','STEALTH_MODE','RUNNERS_HIGH']);
function makeBatchClient(tx, metrics) {
  const reads = new Map(); let feed = [];
  const delegates = new Map();
  async function flush() {
    if (!feed.length) return;
    const data = feed; feed = [];
    await tx.racePowerupEvent.createMany({ data });
    metrics.bulkFeedRows += data.length;
  }
  const client = new Proxy(tx, {
    get(target, model) {
      const value = target[model];
      if (!value || typeof value !== 'object' || String(model).startsWith('$')) return typeof value === 'function' ? value.bind(target) : value;
      if (delegates.has(model)) return delegates.get(model);
      const delegate = new Proxy(value, { get(inner, method) {
        if (typeof inner[method] !== 'function') return inner[method];
        return async (...args) => {
          if (model === 'racePowerupEvent' && method === 'create' && !args[0].select && !args[0].include) {
            const row = { id: randomUUID(), targetUserId: null, powerupType: null, metadata: null, createdAt: new Date(), ...args[0].data };
            feed.push(row); return structuredClone(row);
          }
          // Never allow a consumer to read a feed row before its insert.
          if (model === 'racePowerupEvent') await flush();
          const cached = model === 'race' && ['findUnique','findFirst'].includes(method);
          const key = cached ? JSON.stringify(args) : null;
          if (cached && reads.has(key)) { metrics.sharedReads++; return structuredClone(reads.get(key)); }
          // Relation projections in the race context include participant and
          // user scalars. Any relevant mutation invalidates that shared read.
          if (['race','raceParticipant','user'].includes(model) && !String(method).startsWith('find') && method !== 'count') reads.clear();
          const result = await inner[method](...args);
          if (cached) reads.set(key, structuredClone(result));
          return result;
        };
      } });
      delegates.set(model, delegate); return delegate;
    },
  });
  return { client, flush, checkpoint: () => feed.length, restore: length => { feed.length = length; reads.clear(); } };
}
module.exports = { makeBatchClient, BATCH_TYPES };
