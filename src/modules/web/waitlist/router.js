// POST /waitlist/android — public, unauthenticated email capture for the
// marketing site's Android waitlist (barastep.com). Called by the browser, never
// by the app, so no session, no X-App-Version gating, and no app-compat surface.

const { Router } = require("express");
const { prisma: defaultPrisma } = require("../../../db");
const { asyncHandler } = require("../../../shared/http/asyncHandler");
const { ValidationError } = require("../../../shared/errors/AppError");
const { addAndroidWaitlistEntry, isValidEmail } = require("./model");

function createWaitlistRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;

  // Always answers 200 { ok: true } on success — whether the address was newly
  // added or already on the list. The response deliberately does NOT reveal
  // which: the UI shows identical copy either way, and a distinguishable
  // response would let anyone probe whether a given address is on the list.
  router.post(
    "/android",
    asyncHandler(async (req, res) => {
      const email = req.body ? req.body.email : undefined;
      if (!isValidEmail(email)) {
        throw new ValidationError("Invalid email", "WAITLIST_INVALID_EMAIL");
      }
      await addAndroidWaitlistEntry({ email }, { prisma });
      res.json({ ok: true });
    })
  );

  return router;
}

module.exports = { createWaitlistRouter };
