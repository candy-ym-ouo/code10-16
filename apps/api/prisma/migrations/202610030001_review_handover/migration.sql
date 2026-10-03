-- CreateEnum
CREATE TYPE "HandoverAnnotationKind" AS ENUM ('COMMENT', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "HandoverAnnotationStatus" AS ENUM ('PENDING', 'REJECTED', 'MERGED', 'CONFLICTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "HandoverConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "review_handovers" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_shares" (
    "id" UUID NOT NULL,
    "handover_id" UUID NOT NULL,
    "label" VARCHAR(80),
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" VARCHAR(200),
    "last_accessed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_annotations" (
    "id" UUID NOT NULL,
    "handover_id" UUID NOT NULL,
    "share_id" UUID NOT NULL,
    "author_name" VARCHAR(80) NOT NULL,
    "kind" "HandoverAnnotationKind" NOT NULL,
    "field_path" VARCHAR(40) NOT NULL,
    "start_offset" INTEGER NOT NULL,
    "end_offset" INTEGER NOT NULL,
    "quote" TEXT NOT NULL,
    "body" TEXT,
    "replacement" TEXT,
    "status" "HandoverAnnotationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "handover_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_conflicts" (
    "id" UUID NOT NULL,
    "handover_id" UUID NOT NULL,
    "field_path" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(32) NOT NULL,
    "base_text" TEXT NOT NULL,
    "versions" JSONB NOT NULL,
    "status" "HandoverConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" JSONB,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_handovers_user_id_created_at_idx" ON "review_handovers"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_handovers_session_id_idx" ON "review_handovers"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "handover_shares_token_hash_key" ON "handover_shares"("token_hash");

-- CreateIndex
CREATE INDEX "handover_shares_handover_id_idx" ON "handover_shares"("handover_id");

-- CreateIndex
CREATE INDEX "handover_annotations_handover_id_status_idx" ON "handover_annotations"("handover_id", "status");

-- CreateIndex
CREATE INDEX "handover_annotations_share_id_idx" ON "handover_annotations"("share_id");

-- CreateIndex
CREATE INDEX "handover_conflicts_handover_id_status_idx" ON "handover_conflicts"("handover_id", "status");

-- AddForeignKey
ALTER TABLE "review_handovers" ADD CONSTRAINT "review_handovers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_handovers" ADD CONSTRAINT "review_handovers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "practice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_shares" ADD CONSTRAINT "handover_shares_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "review_handovers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_annotations" ADD CONSTRAINT "handover_annotations_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "review_handovers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_annotations" ADD CONSTRAINT "handover_annotations_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "handover_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_conflicts" ADD CONSTRAINT "handover_conflicts_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "review_handovers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
