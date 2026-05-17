-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('IN_CLASS', 'HOMEWORK');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deadline" TIMESTAMP(3),
ADD COLUMN     "type" "SessionType" NOT NULL DEFAULT 'IN_CLASS';
