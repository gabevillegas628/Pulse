-- CreateEnum
CREATE TYPE "ThemeSetStatus" AS ENUM ('WAITING', 'BOOTSTRAPPING', 'ACTIVE', 'RECLUSTERING', 'FAILED');

-- CreateEnum
CREATE TYPE "ThemeSource" AS ENUM ('AI', 'PROFESSOR');

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "liveThemesDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "liveThemes" BOOLEAN;

-- CreateTable
CREATE TABLE "ThemeSet" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "status" "ThemeSetStatus" NOT NULL DEFAULT 'WAITING',
    "model" TEXT,
    "bootstrapN" INTEGER,
    "classifyCalls" INTEGER NOT NULL DEFAULT 0,
    "lastClusteredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThemeSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThemeCategory" (
    "id" TEXT NOT NULL,
    "themeSetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "isOther" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ThemeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResponseTheme" (
    "id" TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "source" "ThemeSource" NOT NULL DEFAULT 'AI',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResponseTheme_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThemeSet_runId_idx" ON "ThemeSet"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "ThemeSet_questionId_runId_key" ON "ThemeSet"("questionId", "runId");

-- CreateIndex
CREATE INDEX "ThemeCategory_themeSetId_idx" ON "ThemeCategory"("themeSetId");

-- CreateIndex
CREATE UNIQUE INDEX "ResponseTheme_responseId_key" ON "ResponseTheme"("responseId");

-- CreateIndex
CREATE INDEX "ResponseTheme_categoryId_idx" ON "ResponseTheme"("categoryId");

-- AddForeignKey
ALTER TABLE "ThemeSet" ADD CONSTRAINT "ThemeSet_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeSet" ADD CONSTRAINT "ThemeSet_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SessionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThemeCategory" ADD CONSTRAINT "ThemeCategory_themeSetId_fkey" FOREIGN KEY ("themeSetId") REFERENCES "ThemeSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponseTheme" ADD CONSTRAINT "ResponseTheme_responseId_fkey" FOREIGN KEY ("responseId") REFERENCES "Response"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResponseTheme" ADD CONSTRAINT "ResponseTheme_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ThemeCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

