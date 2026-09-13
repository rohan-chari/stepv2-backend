const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const baseline = resolve(process.argv[2]);
const candidate = resolve(process.argv[3]);
const directory = resolve(process.argv[4]);
const results = [];
for (let pair = 0; pair < 10; pair++) {
  for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
    const output = join(directory, `mixed-${pair}-${variant}.json`);
    const run = spawnSync(process.execPath, [join(__dirname, 'deadline-loaded.cjs'),
      variant === 'baseline' ? baseline : candidate, output, '100'], {
      env: process.env, encoding: 'utf8', timeout: 180000, maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    results.push({ pair, variant, ...JSON.parse(readFileSync(output, 'utf8')) });
    process.stdout.write(`pair ${pair} ${variant} complete\n`);
  }
}
writeFileSync(join(directory, 'mixed-paired-summary.json'), JSON.stringify(results, null, 2) + '\n');
