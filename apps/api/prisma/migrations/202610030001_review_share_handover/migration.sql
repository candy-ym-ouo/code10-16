-- CreateEnum
CREATE TYPE "ShareAnnotationSection" AS ENUM ('GENERAL', 'GOOD_POINTS', 'MAIN_ISSUES', 'NEXT_FOCUS', 'GOALS');

-- CreateEnum
CREATE TYPE "ShareAnnotationStatus" AS ENUM ('PENDING', 'MERGED', 'CONFLICT');

-- CreateTable
CREATE TABLE "review_shares" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "note" VARCHAR(200),
    "snapshot" JSONB NOT NULL,
    "snapshot_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_accessed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "review_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_annotations" (
    "id" UUID NOT NULL,
    "share_id" UUID NOT NULL,
    "author_name" VARCHAR(80) NOT NULL,
    "section" "ShareAnnotationSection" NOT NULL,
    "content" VARCHAR(2000) NOT NULL,
    "status" "ShareAnnotationStatus" NOT NULL DEFAULT 'PENDING',
    "client_request_id" VARCHAR(80),
    "merge_batch_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "share_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotation_merge_batches" (
    "id" UUID NOT NULL,
    "share_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "merged_count" INTEGER NOT NULL,
    "conflict_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotation_merge_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_shares_token_hash_key" ON "review_shares"("token_hash");

-- CreateIndex
CREATE INDEX "review_shares_session_id_created_at_idx" ON "review_shares"("session_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "review_shares_created_by_id_created_at_idx" ON "review_shares"("created_by_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "share_annotations_share_id_client_request_id_key" ON "share_annotations"("share_id", "client_request_id");

-- CreateIndex
CREATE INDEX "share_annotations_share_id_status_idx" ON "share_annotations"("share_id", "status");

-- CreateIndex
CREATE INDEX "share_annotations_share_id_section_idx" ON "share_annotations"("share_id", "section");

-- CreateIndex
CREATE INDEX "annotation_merge_batches_share_id_created_at_idx" ON "annotation_merge_batches"("share_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_resource_id_created_at_idx" ON "audit_logs"("resource", "resource_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "review_shares" ADD CONSTRAINT "review_shares_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "practice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_shares" ADD CONSTRAINT "review_shares_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_annotations" ADD CONSTRAINT "share_annotations_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "review_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_annotations" ADD CONSTRAINT "share_annotations_merge_batch_id_fkey" FOREIGN KEY ("merge_batch_id") REFERENCES "annotation_merge_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_merge_batches" ADD CONSTRAINT "annotation_merge_batches_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "review_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_merge_batches" ADD CONSTRAINT "annotation_merge_batches_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
