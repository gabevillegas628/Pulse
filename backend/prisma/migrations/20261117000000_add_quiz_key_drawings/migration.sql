-- CreateTable
CREATE TABLE "QuizKeyDrawings" (
    "assessmentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "file" BYTEA NOT NULL,
    "drawings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizKeyDrawings_pkey" PRIMARY KEY ("assessmentId")
);

-- AddForeignKey
ALTER TABLE "QuizKeyDrawings" ADD CONSTRAINT "QuizKeyDrawings_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "QuizContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
