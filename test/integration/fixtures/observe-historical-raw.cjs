// Passive observation only: the production model still executes every query.
const { StepSample } = require('../../../src/modules/steps/models/stepSample');
const reads = [];
let afterRead = null;
const original = StepSample.findRowsForUserRanges;
StepSample.findRowsForUserRanges = async function(...args) {
  const rows = await original.apply(this, args);
  reads.push({ bounds: args[0], rows: rows.length });
  if (afterRead) { const hook = afterRead; afterRead = null; await hook(); }
  return rows;
};
module.exports = { reads, setAfterRead(hook) { afterRead = hook; } };
