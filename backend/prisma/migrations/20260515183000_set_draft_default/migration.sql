-- AlterTable: set DRAFT as the default status for new sessions
-- Separated from the enum addition because PostgreSQL cannot use a newly added
-- enum value as a column default within the same transaction.
ALTER TABLE "Session" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
