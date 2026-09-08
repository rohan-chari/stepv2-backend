// Unchanged-release HTTP oracle process. Instrument the captured RNG before
// loading the original application; no handler or transaction is substituted.
const http = require('node:http');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const originalRandom = Math.random;
Math.random = () => { const s = scope.getStore(); return s ? (s.draws[s.index++] ?? 0.375) : originalRandom(); };
const sourceRoot = process.argv[2];
const u = new URL(process.env.DATABASE_URL);
if (u.hostname !== 'localhost' || u.pathname !== '/steps_powerup_queue_unit_test') throw new Error('Reference requires dedicated local queue test database');
const { createApp } = require(path.join(sourceRoot, 'src/app'));
Math.random = originalRandom;
const app = createApp();
let drawsByItem = {};
const server = http.createServer((req,res) => {
  const item = req.url.match(/\/powerups\/([^/]+)\/use/)?.[1];
  scope.run({ draws: drawsByItem[item] || [], index: 0 }, () => app(req,res));
});
process.on('message', async message => {
  if (message.type === 'start') {
    drawsByItem = message.drawsByItem;
    server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', baseUrl: `http://127.0.0.1:${server.address().port}` }));
  }
  if (message.type === 'stop') server.close(() => process.exit(0));
});
