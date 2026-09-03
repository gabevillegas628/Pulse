-- Admin is a flag on Professor, not a second kind of account. requireProfessor
-- re-reads the row on every request, so both fields take effect on the next
-- request after they change — no token minting or revocation involved.
-- deactivatedAt rather than a delete: Class cascades from Professor, and a
-- delete would take classes, sessions, and responses with it.
ALTER TABLE "Professor" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Professor" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
