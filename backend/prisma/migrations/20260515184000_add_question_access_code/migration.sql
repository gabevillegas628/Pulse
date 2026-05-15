-- AlterTable: add unique access code to each question for per-question QR/code entry
ALTER TABLE "Question" ADD COLUMN "accessCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Question" ADD CONSTRAINT "Question_accessCode_key" UNIQUE ("accessCode");
ALTER TABLE "Question" ALTER COLUMN "accessCode" DROP DEFAULT;
