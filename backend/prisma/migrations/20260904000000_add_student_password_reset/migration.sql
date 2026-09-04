-- A pending "forgot password" link, one row per token.
--
-- Only the SHA-256 of the token is stored: a read of this table must not hand
-- anyone a working reset link. The unique index on it is also the lookup path —
-- redeeming a link is an indexed read of exactly one row.
--
-- Cascade from Student because a token is meaningless without the account it
-- resets, and unlike the education records elsewhere in this schema there is
-- nothing here worth keeping after the student is gone.
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

CREATE INDEX "PasswordResetToken_studentId_idx" ON "PasswordResetToken"("studentId");

-- The sweep that deletes expired rows orders by this.
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
