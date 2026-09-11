// Local RESP proxy for HTTP tests. It pauses a real Redis command on the wire;
// no application/cache implementation is imported or replaced.
const net = require('node:net');
const assert = require('node:assert/strict');
function frame(buffer) {
  let position = 0;
  const line = () => {
    const end = buffer.indexOf('\r\n', position);
    if (end < 0) return null;
    const value = buffer.toString('utf8', position, end); position = end + 2; return value;
  };
  const first = line();
  if (first === null) return null;
  assert.ok(first.startsWith('*'), 'Redis test proxy expects RESP arrays');
  const values = [];
  for (let i = 0; i < Number(first.slice(1)); i++) {
    const length = line();
    if (length === null) return null;
    assert.ok(length.startsWith('$'), 'Redis test proxy expects bulk command arguments');
    const size = Number(length.slice(1));
    if (buffer.length < position + size + 2) return null;
    values.push(buffer.toString('utf8', position, position + size)); position += size + 2;
  }
  return { size: position, values };
}
async function holdRedisCommand({ target, matches }) {
  const url = new URL(target);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.protocol, 'redis:');
  let release, markHeld, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { markHeld = resolve; });
  const sockets = new Set();
  const server = net.createServer(client => {
    const upstream = net.createConnection({ host: '127.0.0.1', port: Number(url.port || 6379) });
    sockets.add(client); sockets.add(upstream);
    upstream.on('data', bytes => client.write(bytes));
    for (const socket of [client, upstream]) {
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
      socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    let buffer = Buffer.alloc(0), queue = Promise.resolve();
    client.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      for (;;) {
        const parsed = frame(buffer);
        if (!parsed) break;
        const packet = buffer.subarray(0, parsed.size); buffer = buffer.subarray(parsed.size);
        queue = queue.then(async () => {
          if (!held && matches(parsed.values)) { held = true; markHeld(); await gate; }
          if (!upstream.destroyed) upstream.write(packet);
        });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const forwarded = new URL(url); forwarded.hostname = '127.0.0.1'; forwarded.port = String(server.address().port);
  return { url: forwarded.toString(), waiting, release,
    async close() { release(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { holdRedisCommand };
