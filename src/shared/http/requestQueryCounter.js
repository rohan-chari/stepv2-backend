const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

function runWithRequestQueryCounter(callback) {
  return storage.run({ count: 0 }, callback);
}

function incrementRequestQueryCount() {
  const context = storage.getStore();
  if (context) context.count += 1;
}

function currentRequestQueryCount() {
  return storage.getStore()?.count ?? null;
}

module.exports = {
  runWithRequestQueryCounter,
  incrementRequestQueryCount,
  currentRequestQueryCount,
};
