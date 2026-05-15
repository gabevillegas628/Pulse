-- AlterEnum
-- Must be outside a transaction because PostgreSQL requires the enum value
-- to be committed before it can be referenced (e.g. as a column default).
ALTER TYPE "SessionStatus" ADD VALUE 'DRAFT';
