// Public interface of the web module (audit Phase 9d): deep-link verification
// files, share landing pages, and the sharing config surface (share URLs +
// store links) that the share-link routes and app-version gate consume.
const {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
} = require("./deepLinkFiles");
const {
  renderRaceLandingPage,
  renderRaceNotFoundPage,
} = require("./raceLandingPage");
const {
  renderReferralLandingPage,
  renderReferralNotFoundPage,
} = require("./referralLandingPage");
const {
  renderTournamentLandingPage,
  renderTournamentNotFoundPage,
} = require("./tournamentLandingPage");
const sharing = require("./sharing");

module.exports = {
  buildAppleAppSiteAssociation,
  buildAssetLinks,
  renderRaceLandingPage,
  renderRaceNotFoundPage,
  renderReferralLandingPage,
  renderReferralNotFoundPage,
  renderTournamentLandingPage,
  renderTournamentNotFoundPage,
  sharing,
};
