-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "apple_id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steps" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "steps" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_apple_id_key" ON "users"("apple_id");

-- CreateIndex
CREATE INDEX "steps_user_id_date_idx" ON "steps"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "steps_user_id_date_key" ON "steps"("user_id", "date");

-- AddForeignKey
ALTER TABLE "steps" ADD CONSTRAINT "steps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
