-- AlterEnum
ALTER TYPE "QuestionType" ADD VALUE 'NUMERIC';

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "tolerance" DOUBLE PRECISION,
ADD COLUMN     "unit" TEXT;
