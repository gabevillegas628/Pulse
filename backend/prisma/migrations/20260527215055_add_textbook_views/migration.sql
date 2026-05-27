-- CreateTable
CREATE TABLE "TextbookView" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "chapterFilename" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TextbookView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TextbookView_classId_idx" ON "TextbookView"("classId");

-- CreateIndex
CREATE INDEX "TextbookView_classId_chapterFilename_idx" ON "TextbookView"("classId", "chapterFilename");

-- AddForeignKey
ALTER TABLE "TextbookView" ADD CONSTRAINT "TextbookView_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
