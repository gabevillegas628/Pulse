-- CreateEnum
CREATE TYPE "QuizGradeStatus" AS ENUM ('NONE', 'PENDING', 'GRADING', 'GRADED', 'FAILED');

-- AlterTable
ALTER TABLE "QuizPage" ADD COLUMN     "gradeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gradeClaimedAt" TIMESTAMP(3),
ADD COLUMN     "gradeError" TEXT,
ADD COLUMN     "gradeStatus" "QuizGradeStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "gradedAt" TIMESTAMP(3),
ADD COLUMN     "maxPoints" DOUBLE PRECISION,
ADD COLUMN     "pointsAuto" DOUBLE PRECISION,
ADD COLUMN     "reads" JSONB,
ADD COLUMN     "toReview" INTEGER,
ADD COLUMN     "usage" JSONB;

-- CreateTable
CREATE TABLE "QuizSlotResult" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "blankBy" TEXT,
    "transcription" TEXT,
    "groupKey" TEXT,
    "detail" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "pointsAuto" DOUBLE PRECISION NOT NULL,
    "maxPoints" DOUBLE PRECISION NOT NULL,
    "needsReview" BOOLEAN NOT NULL,
    "reviewReasons" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizSlotResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizReadCache" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizReadCache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "QuizSlotResult_slotId_groupKey_idx" ON "QuizSlotResult"("slotId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSlotResult_pageId_slotId_key" ON "QuizSlotResult"("pageId", "slotId");

-- CreateIndex
CREATE INDEX "QuizPage_gradeStatus_idx" ON "QuizPage"("gradeStatus");

-- AddForeignKey
ALTER TABLE "QuizSlotResult" ADD CONSTRAINT "QuizSlotResult_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "QuizPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

