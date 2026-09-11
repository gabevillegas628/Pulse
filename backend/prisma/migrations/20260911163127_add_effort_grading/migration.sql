-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "effortGradingDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "effortGrading" BOOLEAN;

-- AlterTable
ALTER TABLE "Response" ADD COLUMN     "aiReason" TEXT;
