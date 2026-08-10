// Data layer for the Android waitlist. The ONLY file in this feature that
// touches Prisma — the router validates and responds, this persists.

const { prisma: defaultPrisma } = require("../../../db");

// RFC-5321 caps an email address at 254 characters. This endpoint is public and
// unauthenticated, so the cap is what stops an anonymous caller from writing
// unbounded strings into the table.
const MAX_EMAIL_LENGTH = 254;

// Deliberately loose: one @, no whitespace, a dot in the domain. Anything
// stricter rejects real addresses (plus-tags, new TLDs, unicode locals) and this
// list has no downstream delivery to protect — it's a signal of interest.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trim + lowercase. Storing the normalized form is what makes `email @unique`
// actually deliver idempotency: without it, "Person@Example.com" and
// "person@example.com" occupy two rows and the duplicate path never fires.
function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}

function isValidEmail(value) {
  if (typeof value !== "string") return false;
  const normalized = normalizeEmail(value);
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_SHAPE.test(normalized);
}

// Adds an email to the waitlist. Resubmitting an address that is already on the
// list is a SUCCESS, not an error: the caller is a marketing form, and a user who
// refreshes and resubmits should see the same confirmation, not a failure. The
// unique constraint on `email` is what makes that safe under concurrency —
// P2002 means "someone (possibly this same user, twice) already added it".
async function addAndroidWaitlistEntry({ email }, { prisma = defaultPrisma } = {}) {
  const normalized = normalizeEmail(email);
  try {
    await prisma.androidWaitlistEntry.create({ data: { email: normalized } });
  } catch (error) {
    // P2002 = unique constraint violation. Any other error is a real failure and
    // must propagate to the error middleware.
    if (!error || error.code !== "P2002") throw error;
  }
}

module.exports = {
  addAndroidWaitlistEntry,
  isValidEmail,
  normalizeEmail,
  MAX_EMAIL_LENGTH,
};
