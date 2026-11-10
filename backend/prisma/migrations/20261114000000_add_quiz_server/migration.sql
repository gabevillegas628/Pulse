-- CreateTable
CREATE TABLE "QuizServer" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "uploadDir" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuizServer_pkey" PRIMARY KEY ("id")
);
