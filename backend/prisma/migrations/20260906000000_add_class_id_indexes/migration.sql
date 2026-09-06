-- Everything the class page reads is scoped to one class, and until now only
-- TextbookView could answer that from an index. Session, Assignment, Section and
-- Enrollment were all sequential scans, on the four tables the roster and session
-- tabs hit on every load.
--
-- Enrollment is the pointed one: its primary key is (studentId, classId), which
-- serves "what is this student enrolled in" and cannot serve "who is in this
-- class" — the query the roster is made of.
CREATE INDEX "Session_classId_idx" ON "Session"("classId");
CREATE INDEX "Assignment_classId_idx" ON "Assignment"("classId");
CREATE INDEX "Section_classId_idx" ON "Section"("classId");
CREATE INDEX "Enrollment_classId_idx" ON "Enrollment"("classId");
