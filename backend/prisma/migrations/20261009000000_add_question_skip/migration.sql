-- CreateTable
CREATE TABLE "QuestionSkip" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "sectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionSkip_questionId_idx" ON "QuestionSkip"("questionId");

-- AddForeignKey
ALTER TABLE "QuestionSkip" ADD CONSTRAINT "QuestionSkip_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionSkip" ADD CONSTRAINT "QuestionSkip_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE CASCADE ON UPDATE CASCADE;
