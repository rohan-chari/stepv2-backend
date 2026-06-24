// Pure semantic-version helpers behind the client force-update gate. The app
// sends its running version in the X-App-Version header on every request; this
// turns that string into a comparable shape and decides whether a build is
// merely behind ("update available") or below the supported floor ("update
// required"). Everything here fails OPEN: an unparseable version never produces
// a block, so a garbled header can't lock a user out of the app.

// "1.4.2", "1.4.2+45", "1.4.2-beta.1" -> [1, 4, 2]. Returns null for anything
// without leading numeric segments (e.g. "unknown", "", null).
function parseVersion(value) {
  if (typeof value !== "string") return null;
  const core = value.trim().split(/[+-]/)[0];
  if (!core) return null;
  const segments = core.split(".");
  const parsed = [];
  for (const segment of segments) {
    if (!/^\d+$/.test(segment)) return null;
    parsed.push(Number(segment));
  }
  return parsed.length > 0 ? parsed : null;
}

// -1 / 0 / 1 comparing a vs b. Missing trailing segments count as zero
// ("1.4" === "1.4.0"). Returns null if either side is unparseable.
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l < r) return -1;
    if (l > r) return 1;
  }
  return 0;
}

// Decide the gate for one client. The floor is INCLUSIVE: being exactly on
// minSupportedVersion is supported. Any comparison that can't be made (unknown
// client version, unset/garbled policy) yields no block and no nudge.
function evaluateVersionGate({ appVersion, minSupportedVersion, latestVersion }) {
  const belowFloor = compareVersions(appVersion, minSupportedVersion);
  const belowLatest = compareVersions(appVersion, latestVersion);

  return {
    updateRequired: belowFloor === -1,
    updateAvailable: belowFloor === -1 || belowLatest === -1,
  };
}

module.exports = { parseVersion, compareVersions, evaluateVersionGate };
