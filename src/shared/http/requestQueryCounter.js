const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const phaseStorage = new AsyncLocalStorage();

function runWithRequestQueryCounter(callback) {
  return storage.run({ count: 0 }, callback);
}

function incrementRequestQueryCount() {
  const context = storage.getStore();
  if (context) context.count += 1;
  const phaseContext = phaseStorage.getStore();
  if (phaseContext) phaseContext.count += 1;
}

function currentRequestQueryCount() {
  return storage.getStore()?.count ?? null;
}

function runWithPhaseQueryCounter(context, callback) {
  return phaseStorage.run(context, callback);
}

module.exports = {
  runWithRequestQueryCounter,
  incrementRequestQueryCount,
  currentRequestQueryCount,
  runWithPhaseQueryCounter,
};
