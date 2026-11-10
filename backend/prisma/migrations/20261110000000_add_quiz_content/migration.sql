-- CreateEnum
CREATE TYPE "QuizContentKind" AS ENUM ('KEY', 'LAYOUT', 'ASSESSMENT');

-- CreateTable
CREATE TABLE "QuizContent" (
    "id" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "kind" "QuizContentKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizContent_professorId_kind_slug_key" ON "QuizContent"("professorId", "kind", "slug");

-- AddForeignKey
ALTER TABLE "QuizContent" ADD CONSTRAINT "QuizContent_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

