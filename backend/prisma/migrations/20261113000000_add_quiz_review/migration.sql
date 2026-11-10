-- CreateTable
CREATE TABLE "QuizGroupDecision" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizGroupDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizOverride" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "features" JSONB,
    "note" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizDecisionLog" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "groupKey" TEXT,
    "pageId" TEXT,
    "fromPoints" DOUBLE PRECISION,
    "toPoints" DOUBLE PRECISION,
    "papers" INTEGER,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuizDecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuizGroupDecision_assessmentId_slotId_groupKey_key" ON "QuizGroupDecision"("assessmentId", "slotId", "groupKey");

-- CreateIndex
CREATE UNIQUE INDEX "QuizOverride_pageId_slotId_key" ON "QuizOverride"("pageId", "slotId");

-- CreateIndex
CREATE INDEX "QuizDecisionLog_assessmentId_createdAt_idx" ON "QuizDecisionLog"("assessmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuizGroupDecision" ADD CONSTRAINT "QuizGroupDecision_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "QuizContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizOverride" ADD CONSTRAINT "QuizOverride_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "QuizPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

