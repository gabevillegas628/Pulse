-- AlterTable
ALTER TABLE "QuizContent" ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "QuizExcusal" (
    "assessmentId" TEXT NOT NULL,
    "netId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizExcusal_pkey" PRIMARY KEY ("assessmentId","netId")
);

-- AddForeignKey
ALTER TABLE "QuizExcusal" ADD CONSTRAINT "QuizExcusal_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "QuizContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

