-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "link_opens" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_opens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "link_opens_kind_created_at_idx" ON "link_opens"("kind", "created_at");
