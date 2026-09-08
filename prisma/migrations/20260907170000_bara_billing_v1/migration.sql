-- CreateTable
CREATE TABLE "billing_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_purchases" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "canonical_key" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "grant_version" INTEGER NOT NULL DEFAULT 1,
    "purchased_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "granted_coins" INTEGER NOT NULL DEFAULT 0,
    "granted_credits" INTEGER NOT NULL DEFAULT 0,
    "recovered_coins" INTEGER NOT NULL DEFAULT 0,
    "absorbed_coins" INTEGER NOT NULL DEFAULT 0,
    "revoked_credits" INTEGER NOT NULL DEFAULT 0,
    "refunded_at" TIMESTAMP(3),
    "refund_observed_at" TIMESTAMP(3),
    "refund_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_subscriptions" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "period_starts_at" TIMESTAMP(3) NOT NULL,
    "access_until" TIMESTAMP(3) NOT NULL,
    "gives_access" BOOLEAN NOT NULL DEFAULT false,
    "trial" BOOLEAN NOT NULL DEFAULT false,
    "renews" BOOLEAN NOT NULL DEFAULT false,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "management_url" TEXT,

    CONSTRAINT "billing_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_lots" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "granted" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_credit_entries" (
    "id" TEXT NOT NULL,
    "lot_id" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_inbox" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reconciliation" (
    "identity_id" TEXT NOT NULL,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMP(3),
    "lease_token" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_reconciliation_pkey" PRIMARY KEY ("identity_id")
);

-- CreateTable
CREATE TABLE "billing_cosmetic_releases" (
    "month" TEXT NOT NULL,
    "shop_item_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_cosmetic_releases_pkey" PRIMARY KEY ("month")
);

-- CreateTable
CREATE TABLE "billing_cosmetic_grants" (
    "id" TEXT NOT NULL,
    "identity_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "shop_item_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_cosmetic_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_reroll_operations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_reroll_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_identities_user_id_key" ON "billing_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_purchases_canonical_key_key" ON "billing_purchases"("canonical_key");

-- CreateIndex
CREATE INDEX "billing_purchases_identity_id_purchased_at_idx" ON "billing_purchases"("identity_id", "purchased_at");

-- CreateIndex
CREATE INDEX "billing_purchases_store_environment_transaction_id_idx" ON "billing_purchases"("store", "environment", "transaction_id");

-- CreateIndex
CREATE INDEX "billing_subscriptions_identity_id_access_until_idx" ON "billing_subscriptions"("identity_id", "access_until");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_lots_source_key_key" ON "billing_credit_lots"("source_key");

-- CreateIndex
CREATE INDEX "billing_credit_lots_identity_id_kind_created_at_idx" ON "billing_credit_lots"("identity_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_credit_entries_lot_id_operation_key_key" ON "billing_credit_entries"("lot_id", "operation_key");

-- CreateIndex
CREATE INDEX "billing_inbox_identity_id_processed_at_idx" ON "billing_inbox"("identity_id", "processed_at");

-- CreateIndex
CREATE INDEX "billing_reconciliation_next_attempt_at_lease_until_idx" ON "billing_reconciliation"("next_attempt_at", "lease_until");

-- CreateIndex
CREATE UNIQUE INDEX "billing_cosmetic_grants_identity_id_month_key" ON "billing_cosmetic_grants"("identity_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "billing_reroll_operations_user_id_request_key_key" ON "billing_reroll_operations"("user_id", "request_key");
