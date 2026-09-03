-- Deleting a professor used to cascade through Class to sessions, assignments,
-- questions, and every response — a semester of education records in one
-- statement. Nothing in the app deletes a professor (admins deactivate), so
-- this constraint exists for raw SQL, Prisma Studio, and future scripts: the
-- delete now fails until the classes are transferred or removed first.
ALTER TABLE "Class" DROP CONSTRAINT "Class_professorId_fkey";
ALTER TABLE "Class" ADD CONSTRAINT "Class_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
