const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, existsSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
test('retired recap runtime is absent from production source', () => {
  for (const file of [
    'src/modules/steps/jobs/globalEventSummary.js',
    ...['globalEventSummaryCapture','globalEventSummaryLifecycle','durableGlobalEventCapture',
      'durableCaptureCleanup','durableCaptureScoringPlan','durableCaptureStageScoring',
      'durableCaptureIntervalProjection','durableCaptureSnapshot','durableCaptureFacts',
      'durablePreparedScoringInputs','durableScoringMethod','globalEventCaptureFactCache','capturedHitchhikeInputs']
      .map(name => `src/modules/steps/services/${name}.js`),
  ]) assert.equal(existsSync(resolve(root, file)), false, file);
  for (const file of ['src/index.js','src/modules/steps/index.js',
    'src/modules/steps/commands/recordStepSyncV2.js','src/modules/races/jobs/raceResolutionQueueV2.js',
    'src/modules/races/jobs/raceExpiry.js','src/modules/steps/services/globalStepEventEntitlement.js',
    'src/modules/steps/services/globalStepEventRetention.js']) {
    assert.doesNotMatch(readFileSync(resolve(root,file),'utf8'), /globalEventSummaryCapture|global_event_summary_work|scheduleGlobalSummary|publishDurableQueueWakeup\(["']summary/);
  }
});
test('every production source file is independent of all retired recap storage and SQL functions', () => {
  const forbidden = /\b(?:global_event_summary_work|global_event_user_summaries|global_event_capture_artifacts|durable_global_event_capture_requests|durable_capture_[a-z_]+)\b/;
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (/\.(?:js|cjs|json|sql)$/.test(entry.name)) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), forbidden, file);
      }
    }
  }
  inspect(resolve(root, 'src'));
});
