-- Per-question auto-close toggle. Mirrors the liveThemes/liveThemesDefault pair:
-- Question.autoClose is nullable and inherits Class.autoCloseDefault when null.
-- The countdown itself is ephemeral (in-memory, per run) — only the toggle persists.
ALTER TABLE "Class" ADD COLUMN     "autoCloseDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Question" ADD COLUMN  "autoClose" BOOLEAN;
