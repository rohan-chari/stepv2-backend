async function isStrictFlagEnabled(settings, key) {
  try {
    return (await settings.getFlag(key)) === true;
  } catch {
    return false;
  }
}

module.exports = { isStrictFlagEnabled };
