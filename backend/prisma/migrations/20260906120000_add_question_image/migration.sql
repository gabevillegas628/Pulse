-- A question can carry one image: the diagram, spectrum or photo the wording refers
-- to, shown above the answer input on the student's phone.
--
-- Nullable and unbacked by a foreign key on purpose. The value is a "/uploads/<name>"
-- path this server minted, and the file behind it is reference-counted at delete time
-- rather than owned by the row — class duplication copies the path field-for-field, so
-- two questions can legitimately point at one file.
ALTER TABLE "Question" ADD COLUMN "imageUrl" TEXT;
