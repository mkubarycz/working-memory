-- 002_soft_delete.sql
-- Adds `deleted_at INTEGER` to all three tables. Soft delete is the default
-- delete semantics across the API; rows with `deleted_at IS NOT NULL` are
-- hidden from list/get/search calls unless `include_deleted` is set.
--
-- The old `entries_au` trigger re-inserted into the FTS index on ANY update
-- to `entries`, which would resurrect a soft-deleted row in search results
-- the moment we set `deleted_at`. Drop it; the API treats `entries.body` as
-- append-only and maintains the FTS index explicitly on delete.

PRAGMA foreign_keys = ON;

ALTER TABLE workstreams ADD COLUMN deleted_at INTEGER;
ALTER TABLE sessions    ADD COLUMN deleted_at INTEGER;
ALTER TABLE entries     ADD COLUMN deleted_at INTEGER;

DROP TRIGGER IF EXISTS entries_au;
