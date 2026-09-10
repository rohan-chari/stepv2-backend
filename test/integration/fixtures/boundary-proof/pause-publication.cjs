// Test-only scheduling barrier. Execute the unchanged Lua against real Redis
// after the parent commits a concurrent marker rotation; never fake its result.
const Redis = require('ioredis');
const original = Redis.prototype.eval;
let pending = process.env.TEST_PAUSE_BOUNDARY_PUBLICATION === '1';
Redis.prototype.eval = function (script, keyCount, ...args) {
  if (!pending || keyCount !== 6 || !script.includes('local currentGeneration')) {
    return original.call(this, script, keyCount, ...args);
  }
  pending = false;
  return new Promise((resolve, reject) => {
    process.once('message', message => {
      if (message?.kind !== 'resume-boundary-publication') return reject(new Error('invalid publication barrier reply'));
      original.call(this, script, keyCount, ...args).then(resolve, reject);
    });
    process.send({ kind: 'before-boundary-publication' });
  });
};
