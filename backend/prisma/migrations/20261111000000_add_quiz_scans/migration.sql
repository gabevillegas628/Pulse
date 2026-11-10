-- CreateEnum
CREATE TYPE "QuizPageStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'NEEDS_VERSION', 'FAILED');

-- CreateTable
CREATE TABLE "QuizBatch" (
    "id" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "visionDocId" TEXT,
    "pageCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizPage" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "status" "QuizPageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "versionForced" TEXT,
    "version" TEXT,
    "method" TEXT,
    "markers" INTEGER,
    "match" DOUBLE PRECISION,
    "fits" JSONB,
    "slots" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuizBatch_assessmentId_idx" ON "QuizBatch"("assessmentId");

-- CreateIndex
CREATE INDEX "QuizPage_status_idx" ON "QuizPage"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QuizPage_batchId_index_key" ON "QuizPage"("batchId", "index");

-- AddForeignKey
ALTER TABLE "QuizBatch" ADD CONSTRAINT "QuizBatch_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizBatch" ADD CONSTRAINT "QuizBatch_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "QuizContent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizPage" ADD CONSTRAINT "QuizPage_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "QuizBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

