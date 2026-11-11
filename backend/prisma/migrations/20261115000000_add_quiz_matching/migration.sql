-- AlterTable
ALTER TABLE "QuizContent" ADD COLUMN     "classId" TEXT;

-- AlterTable
ALTER TABLE "QuizPage" ADD COLUMN     "matchedAt" TIMESTAMP(3),
ADD COLUMN     "studentNetId" TEXT;

-- AddForeignKey
ALTER TABLE "QuizContent" ADD CONSTRAINT "QuizContent_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE SET NULL ON UPDATE CASCADE;

