function buildViewerDisplayPlacementMap(entries, maskedUserIds) {
  const masked = maskedUserIds instanceof Set ? maskedUserIds : new Set(maskedUserIds || []);
  const maskedPlacements = (entries || [])
    .filter((entry) => entry?.userId && masked.has(entry.userId))
    .map((entry) => Number(entry.placement))
    .filter((placement) => Number.isInteger(placement) && placement > 0);
  const visible = (entries || [])
    .filter((entry) => entry?.userId && !masked.has(entry.userId))
    .sort((a, b) => {
      const ap = Number(a.placement);
      const bp = Number(b.placement);
      const aValid = Number.isInteger(ap) && ap > 0;
      const bValid = Number.isInteger(bp) && bp > 0;
      if (aValid && bValid && ap !== bp) return ap - bp;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return String(a.userId).localeCompare(String(b.userId));
    });
  return new Map(visible.map((entry, index) => {
    const canonical = Number(entry.placement);
    const displayPlacement = Number.isInteger(canonical) && canonical > 0
      ? canonical - maskedPlacements.filter((placement) => placement < canonical).length
      : index + 1;
    return [entry.userId, displayPlacement];
  }));
}

module.exports = { buildViewerDisplayPlacementMap };
