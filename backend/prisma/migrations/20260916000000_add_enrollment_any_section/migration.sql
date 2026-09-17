-- Lets a professor mark a student as able to answer in any section of a class.
--
-- Defaulted false, so every existing enrollment keeps exactly the access it has today and
-- the column is backfilled without a table rewrite of anything that matters.
ALTER TABLE "Enrollment" ADD COLUMN "anySection" BOOLEAN NOT NULL DEFAULT false;
