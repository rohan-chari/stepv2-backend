function preparationActions(previous, desired) {
  if (!desired?.code || !desired?.dataset || !desired?.hardware) {
    throw new Error("environment binding requires code, dataset, and hardware fingerprints");
  }
  if (!previous || previous.hardware !== desired.hardware) {
    return ["ensureVm", "ensureDatabase", "ensureRedis", "ensureBackend"];
  }
  if (previous.dataset !== desired.dataset) return ["ensureDatabase", "ensureBackend"];
  if (previous.code !== desired.code) return ["ensureBackend"];
  return [];
}

async function prepareEnvironment({ provider, previous, desired } = {}) {
  const actions = preparationActions(previous, desired);
  for (const action of actions) {
    if (typeof provider?.[action] !== "function") throw new Error(`provider is missing ${action}`);
    await provider[action]({ previous, desired });
  }
  return { binding: desired, actions, prepared: true };
}

module.exports = { preparationActions, prepareEnvironment };
