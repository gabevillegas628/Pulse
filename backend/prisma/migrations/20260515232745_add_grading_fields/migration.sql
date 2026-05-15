-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "correctAnswer" TEXT;

-- AlterTable
ALTER TABLE "Response" ADD COLUMN     "aiScore" DOUBLE PRECISION;
