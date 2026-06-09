-- ============================================================
-- Migration: session-run-assignment-split
-- Splits Session (IN_CLASS + HOMEWORK) into:
--   Session (IN_CLASS question set) + SessionRun (one class meeting)
--   Assignment (homework)
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- STEP 1: New tables and nullable columns
-- ────────────────────────────────────────────────────────────

CREATE TABLE "Assignment" (
    "id"        TEXT            NOT NULL,
    "classId"   TEXT            NOT NULL,
    "title"     TEXT            NOT NULL,
    "status"    "SessionStatus" NOT NULL DEFAULT 'OPEN',
    "deadline"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Assignment"
    ADD CONSTRAINT "Assignment_classId_fkey"
    FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SessionRun" (
    "id"        TEXT            NOT NULL,
    "sessionId" TEXT            NOT NULL,
    "sectionId" TEXT,
    "status"    "SessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionRun_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SessionRun"
    ADD CONSTRAINT "SessionRun_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SessionRun"
    ADD CONSTRAINT "SessionRun_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SessionRun_sessionId_idx" ON "SessionRun"("sessionId");
CREATE INDEX "SessionRun_sectionId_idx" ON "SessionRun"("sectionId");

-- Add nullable assignmentId to Question and QuestionGroup
ALTER TABLE "Question"
    ADD COLUMN "assignmentId" TEXT,
    ALTER COLUMN "sessionId" DROP NOT NULL;

ALTER TABLE "QuestionGroup"
    ADD COLUMN "assignmentId" TEXT,
    ALTER COLUMN "sessionId" DROP NOT NULL;

-- Add nullable runId to Response
ALTER TABLE "Response" ADD COLUMN "runId" TEXT;

-- Add nullable assignmentId to DeadlineExtension (populated before making it required)
ALTER TABLE "DeadlineExtension" ADD COLUMN "assignmentId" TEXT;

-- ────────────────────────────────────────────────────────────
-- STEP 2: Data migration
-- ────────────────────────────────────────────────────────────

-- 2a. Migrate HOMEWORK sessions → Assignment (same id, preserves references)
INSERT INTO "Assignment" ("id", "classId", "title", "status", "deadline", "createdAt", "updatedAt")
SELECT
    id,
    "classId",
    title,
    status,
    deadline,
    "createdAt",
    "updatedAt"
FROM "Session"
WHERE type = 'HOMEWORK';

-- 2b. Re-point homework Questions to Assignment, clear Session FK
UPDATE "Question"
SET "assignmentId" = "sessionId",
    "sessionId"    = NULL
WHERE "sessionId" IN (SELECT id FROM "Session" WHERE type = 'HOMEWORK');

-- 2c. Re-point homework QuestionGroups to Assignment, clear Session FK
UPDATE "QuestionGroup"
SET "assignmentId" = "sessionId",
    "sessionId"    = NULL
WHERE "sessionId" IN (SELECT id FROM "Session" WHERE type = 'HOMEWORK');

-- 2d. Re-point DeadlineExtensions to Assignment
--     (HOMEWORK session ids now exist in Assignment with the same id)
UPDATE "DeadlineExtension" de
SET "assignmentId" = de."sessionId"
WHERE de."sessionId" IN (SELECT id FROM "Session" WHERE type = 'HOMEWORK');

-- 2e. Create one SessionRun per non-DRAFT IN_CLASS session
INSERT INTO "SessionRun" ("id", "sessionId", "sectionId", "status", "openedAt", "closedAt", "createdAt")
SELECT
    gen_random_uuid()::text,
    s.id,
    s."targetSectionId",
    CASE s.status
        WHEN 'OPEN'     THEN 'OPEN'::"SessionStatus"
        WHEN 'CLOSED'   THEN 'CLOSED'::"SessionStatus"
        WHEN 'ARCHIVED' THEN 'ARCHIVED'::"SessionStatus"
        ELSE                 'CLOSED'::"SessionStatus"
    END,
    COALESCE(s."openedAt", s."createdAt"),
    s."closedAt",
    s."createdAt"
FROM "Session" s
WHERE s.type = 'IN_CLASS'
  AND s.status <> 'DRAFT';

-- 2f. Point Response.runId to the SessionRun for IN_CLASS responses
--     Each question belongs to one session; each session has exactly one run at this point.
UPDATE "Response" r
SET "runId" = sr.id
FROM "SessionRun" sr
JOIN "Question" q ON q."sessionId" = sr."sessionId"
WHERE r."questionId" = q.id;

-- ────────────────────────────────────────────────────────────
-- STEP 3: Drop old structure
-- ────────────────────────────────────────────────────────────

-- 3a. DeadlineExtension: drop old sessionId, make assignmentId required, add FK + indexes
ALTER TABLE "DeadlineExtension"
    DROP CONSTRAINT IF EXISTS "DeadlineExtension_sessionId_fkey";

DROP INDEX IF EXISTS "DeadlineExtension_sessionId_idx";
DROP INDEX IF EXISTS "DeadlineExtension_sessionId_studentId_key";

ALTER TABLE "DeadlineExtension"
    DROP COLUMN "sessionId",
    ALTER COLUMN "assignmentId" SET NOT NULL;

ALTER TABLE "DeadlineExtension"
    ADD CONSTRAINT "DeadlineExtension_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "DeadlineExtension_assignmentId_studentId_key"
    ON "DeadlineExtension"("assignmentId", "studentId");

CREATE INDEX "DeadlineExtension_assignmentId_idx" ON "DeadlineExtension"("assignmentId");

-- 3b. Delete HOMEWORK sessions — their questions/groups are already re-pointed
--     Cascade on Session→Question does not fire for rows where sessionId IS NULL
DELETE FROM "Session" WHERE type = 'HOMEWORK';

-- 3c. Drop obsolete columns from Session
ALTER TABLE "Session"
    DROP CONSTRAINT IF EXISTS "Session_targetSectionId_fkey",
    DROP COLUMN IF EXISTS "type",
    DROP COLUMN IF EXISTS "deadline",
    DROP COLUMN IF EXISTS "openedAt",
    DROP COLUMN IF EXISTS "closedAt",
    DROP COLUMN IF EXISTS "targetSectionId";

-- 3d. Drop the SessionType enum
DROP TYPE IF EXISTS "SessionType";

-- 3e. Add FKs for the new nullable columns
ALTER TABLE "Question"
    ADD CONSTRAINT "Question_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuestionGroup"
    ADD CONSTRAINT "QuestionGroup_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Response"
    ADD CONSTRAINT "Response_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "SessionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3f. Remaining indexes
CREATE INDEX "Question_assignmentId_idx"      ON "Question"("assignmentId");
CREATE INDEX "QuestionGroup_assignmentId_idx" ON "QuestionGroup"("assignmentId");
CREATE INDEX "Response_runId_idx"             ON "Response"("runId");
CREATE INDEX "Response_studentId_idx"         ON "Response"("studentId");

COMMIT;
