-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "sectionId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "targetSectionId" TEXT;

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Section_joinCode_key" ON "Section"("joinCode");

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_targetSectionId_fkey" FOREIGN KEY ("targetSectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;
