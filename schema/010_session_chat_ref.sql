-- 010_session_chat_ref.sql
-- Optional, free-form text pointing at the chat (or other conversational
-- surface) that produced this session. Filled by `wm_start_session` when
-- the caller supplies `chat_ref` — typically the path to the VS Code
-- chat debug-logs folder (e.g. the value of $VSCODE_TARGET_SESSION_LOG
-- as seen by the orchestrator agent). NULL when the caller didn't pass
-- one; the session virtual doc renders "(no chat link recorded)" in
-- that case rather than fabricating anything.
--
-- Deliberately untyped at the SQL layer: VS Code may change the shape of
-- this identifier (URI scheme, deep link, etc.) and we don't want the
-- schema to care. The renderer is responsible for any formatting.
--
-- Wrapped in the standard runner BEGIN/COMMIT — a plain ALTER TABLE
-- doesn't need the unwrapped FK-toggle dance from migration 005's
-- template.

PRAGMA foreign_keys = ON;

ALTER TABLE sessions ADD COLUMN chat_ref TEXT;
