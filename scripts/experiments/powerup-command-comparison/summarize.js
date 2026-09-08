const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || 'artifacts/powerup-command-comparison');
function delta(start, end, key) {
  if (!start || !end) return null;
  return end.reduce((sum, p, i) => sum + p[key] - start[i][key], 0);
}
function p95(values) {
  const sorted = values.sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * .95)] : null;
}
const rows = fs.readdirSync(root).sort().flatMap(name => {
  const file = path.join(root, name, 'result.json');
  if (!fs.existsSync(file)) return [];
  const r = JSON.parse(fs.readFileSync(file));
  const worker = r.processes?.find(p => p.role === 'worker');
  const queue = worker?.metrics.at(-1)?.queueMetrics;
  const commandPhases = r.startedCommands.flatMap(start => {
    const request = r.results.find(row => row.powerupId === start.powerupId && row.phase === 'load');
    return request ? [{ beforeHandlerMs: start.at - request.sentAt, afterHandlerStartMs: request.completedAt - start.at }] : [];
  });
  return [{ run: name, arm: r.arm, profile: r.profile, rate: r.rate, syncRate: r.syncRate,
    successful: r.powerup?.statuses['200'] || 0, statuses: r.powerup?.statuses,
    p50: r.powerup?.latency.p50, p95: r.powerup?.latency.p95, p99: r.powerup?.latency.p99,
    successfulP95: r.powerup?.successfulLatency.p95, syncP95: r.sync?.latency.p95,
    beforeHandlerP95: p95(commandPhases.map(p => p.beforeHandlerMs)),
    afterHandlerStartP95: p95(commandPhases.map(p => p.afterHandlerStartMs)),
    loadCpuSeconds: r.loadDbCpu?.cpuSeconds, loadWindowMs: r.loadDbCpu?.elapsedMs,
    loadSql: delta(r.processStart, r.processLoadEnd, 'queries'),
    loadAppCpuMs: delta(r.processStart, r.processLoadEnd, 'cpuMs'),
    totalSql: delta(r.processStart, r.processDrainEnd, 'queries'),
    totalCpuSeconds: r.dbCpu?.cpuSeconds, measuredElapsedMs: r.measuredElapsedMs,
    maxResolutionLag: Math.max(0, ...r.samples.map(s => s.oldest_resolution_seconds)),
    maxLockWaiters: Math.max(0, ...r.samples.map(s => s.lock_waiters)),
    drain: r.drain, oracle: r.oracle, commandOutcomes: r.commandOutcomes,
    postTaskOutcomes: r.postTaskOutcomes, queue,
    queueMeanOccupancy: queue?.occupancies.length ? queue.occupancies.reduce((a, b) => a + b, 0) / queue.occupancies.length : null,
    deadlineMisses: r.powerup?.deadlineMisses, fatal: r.fatal,
    forcedStops: r.processes?.filter(p => p.forcedStop).length,
    hashes: r.hashes, sourceCommit: r.sourceCommit, sourceDiffSha256: r.sourceDiffSha256,
  }];
});
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(rows, null, 2));
console.table(rows.map(r => ({ run: r.run, successes: r.successful, p95: r.p95?.toFixed(1),
  syncP95: r.syncP95?.toFixed(1), dbCpu: r.loadCpuSeconds?.toFixed(2), sql: r.loadSql,
  occupancy: r.queueMeanOccupancy?.toFixed(2), passed: r.oracle?.passed })));
