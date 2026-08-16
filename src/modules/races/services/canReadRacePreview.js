// Race preview-before-joining — the ONE predicate that decides whether a
// non-participant may read a race. (docs/race-preview-before-join-spec.md,
// "One shared predicate, used by all three endpoints".)
//
// Three separate access gates 403 a non-participant today — getRaceDetails,
// getRaceProgress, and routes.js's loadBootstrapAccess — and the preview screen
// calls all three. They must agree exactly or the feature is either dead on
// arrival (one gate still 403s) or leaky (one gate is more permissive than the
// others), which is why the rule lives here rather than being written out three
// times.
const {
  appSettings: defaultAppSettings,
} = require("../../../shared/config/appSettings");

// The client capability token. Computed at the ROUTE layer, where
// `req.clientFeatures` lives, and threaded into the query layer as a plain
// boolean through each call site's existing trailing options object — the query
// functions deliberately do not learn about clientFeatures (getRaceDetails's own
// header comment warns against growing its parameter list).
const RACE_PREVIEW_TOKEN = "race_preview";

function hasRacePreviewToken(clientFeatures) {
  return clientFeatures?.has?.(RACE_PREVIEW_TOKEN) === true;
}

/**
 * True only for a genuine, capability-advertising, flag-enabled public preview.
 *
 * The check ORDER is load-bearing, not stylistic: the overwhelmingly common
 * caller of all three endpoints is an actual participant, and `!myParticipant`
 * rejects them on the first line — so the appSettings lookup (last) never runs
 * on the hot path.
 *
 * @param {object}  race           needs `isPublic` and `tournamentId`.
 * @param {object=} myParticipant  the viewer's participant row, if any. A
 *   DECLINED row is still a row: a decliner is NOT `!myParticipant`, so they
 *   keep getting the real 403. Declining revokes access, unchanged.
 * @param {boolean} previewViewer  did the caller advertise `race_preview`?
 */
async function canReadRacePreview({
  race,
  myParticipant,
  previewViewer = false,
  settings = defaultAppSettings,
}) {
  if (myParticipant) return false;
  if (race?.isPublic !== true) return false;
  // Tournament matchups are excluded on purpose. A legitimate viewer of one is
  // already served by the separate `canSpectate` path, and letting an arbitrary
  // user preview a matchup would hand them a JOIN CTA that 400s
  // (TOURNAMENT_RACE_LOCKED).
  if (race?.tournamentId != null) return false;
  if (previewViewer !== true) return false;
  return (await settings.getFlag("racePreviewEnabled")) === true;
}

module.exports = {
  canReadRacePreview,
  hasRacePreviewToken,
  RACE_PREVIEW_TOKEN,
};
