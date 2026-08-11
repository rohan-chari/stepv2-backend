// GET /reviews/ios — public, unauthenticated. Feeds the scrolling 5-star review
// strip on barastep.com. Called by the browser, never by the app, so there is no
// session, no X-App-Version gating and no app-compat surface.
//
// Always 200. getFiveStarReviews() absorbs upstream failures and returns a
// stale-or-empty list rather than throwing (see appStoreReviews.js), so this
// route has no error path to handle.

const { Router } = require("express");
const { asyncHandler } = require("../../../shared/http/asyncHandler");
const { getFiveStarReviews } = require("./appStoreReviews");

function createReviewsRouter(dependencies = {}) {
  const router = Router();
  const loadReviews = dependencies.getFiveStarReviews || getFiveStarReviews;

  router.get(
    "/ios",
    asyncHandler(async (req, res) => {
      const { reviews } = await loadReviews();
      // The upstream feed is cached for 6h server-side; a shorter public cache
      // keeps a CDN or browser from pinning a list far longer than that.
      res.set("Cache-Control", "public, max-age=900");
      res.json({ reviews });
    })
  );

  return router;
}

module.exports = { createReviewsRouter };
