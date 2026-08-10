// Public interface of the web module (audit Phase 9d): deep-link verification
// files, share landing pages, the sharing config surface (share URLs + store
// links) that the share-link routes and app-version gate consume, and the
// Android waitlist router behind the marketing site's capture form.
//
// ./theme.js is deliberately NOT re-exported here: its two consumers (the two
// landing-page shells) require it directly, and the marketing site reads it
// through web/scripts/generate-theme-css.mjs. A barrel export nothing imports
// is just a second name for the same file.
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
const { createWaitlistRouter } = require("./waitlist/router");

module.exports = {
  createWaitlistRouter,
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
