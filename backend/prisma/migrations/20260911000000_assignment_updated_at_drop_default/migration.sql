-- Assignment.updatedAt carried a DB-level DEFAULT CURRENT_TIMESTAMP because the
-- session/run/assignment split was hand-written SQL. Prisma's @updatedAt sets the
-- value from the client and expects no database default, so the recorded history
-- and the live databases disagreed by exactly this one column.
--
-- Dropping it aligns both. No data changes: every write already supplies updatedAt.
ALTER TABLE "Assignment" ALTER COLUMN "updatedAt" DROP DEFAULT;
