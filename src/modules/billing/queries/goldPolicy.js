const {
  GOLD_BENEFIT_VERSION,
  GOLD_CHARACTER_PRODUCTS,
} = require("../catalog");
const { membershipFor } = require("./bootstrap");

const GOLD_CHARACTER_SKUS = new Set(Object.keys(GOLD_CHARACTER_PRODUCTS));

async function goldMembershipForUser(db, userId, now = new Date()) {
  if (!db.billingIdentity) return { isMember: false, membership: null };
  const identity = await db.billingIdentity.findUnique({
    where: { userId },
    select: { id: true, deletedAt: true },
  });
  if (!identity || identity.deletedAt) return { isMember: false, membership: null };
  const membership = await membershipFor(db, identity.id, now);
  if (membership.givesAccess !== true) return { isMember: false, membership };

  // Active access is not sufficient to establish the Bara Gold contract.
  // Legacy monthly/permanent records retain historical membership semantics,
  // but must not receive new Gold-only benefits. The durable contract is
  // copied to every renewal/subscription snapshot by billing fulfillment.
  const activeContract = await db.billingSubscription.findFirst({
    where: {
      identityId: identity.id,
      givesAccess: true,
      OR: [
        { accessUntil: { gt: now } },
        { providerStatus: { in: ["in_grace_period", "unknown"] } },
      ],
    },
    orderBy: { accessUntil: "desc" },
    select: { benefitContract: true },
  });
  return {
    isMember: activeContract?.benefitContract === GOLD_BENEFIT_VERSION,
    membership,
  };
}

function isGoldCharacterSku(sku) {
  return typeof sku === "string" && GOLD_CHARACTER_SKUS.has(sku);
}

function directCharacterPurchase(sku) {
  const storeProductId = GOLD_CHARACTER_PRODUCTS[sku];
  return storeProductId
    ? { available: true, storeProductId }
    : { available: false, storeProductId: null };
}

function characterPolicy(item, isMember) {
  const goldAccess = isGoldCharacterSku(item?.sku);
  const owned = item?.owned === true;
  const directPurchase = directCharacterPurchase(item?.sku);
  const coinPurchaseAllowed = !goldAccess || isMember;
  const canPurchase = !owned && item?.active === true && item?.earnOnly !== true && coinPurchaseAllowed;
  return {
    goldAccess,
    benefitVersion: goldAccess ? GOLD_BENEFIT_VERSION : null,
    coinPurchaseAllowed,
    directPurchase,
    unavailableReason: !owned && goldAccess && !isMember
      ? "requires_gold_or_direct_purchase"
      : null,
    canPurchase,
  };
}

async function goldPolicyForUser(db, userId) {
  const { isMember } = await goldMembershipForUser(db, userId);
  return {
    version: GOLD_BENEFIT_VERSION,
    isMember,
    weeklyProductId: "bara_plus_weekly_v1",
    monthlyProductId: "bara_plus_monthly_v1",
  };
}

module.exports = {
  GOLD_CHARACTER_SKUS,
  goldMembershipForUser,
  goldPolicyForUser,
  isGoldCharacterSku,
  directCharacterPurchase,
  characterPolicy,
};
