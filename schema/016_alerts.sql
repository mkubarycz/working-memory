-- 016_alerts.sql
-- First-class alerts: structured "needs attention" items raised by agents
-- or background tasks. M:N with topics.
--
-- All new tables, so a plain `CREATE TABLE IF NOT EXISTS` under the runner's
-- default BEGIN/COMMIT is safe — there is no table rebuild here and therefore
-- no cascading-delete hazard (cf. schema/005_safe_topic_rebuild_template.sql).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS alerts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  description         TEXT    NOT NULL,
  recommended_action  TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'alert'
                        CHECK (status IN ('alert','informational','closed')),
  dedupe_key          TEXT,
  created_by          TEXT    NOT NULL DEFAULT 'system',
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- One OPEN alert per dedupe_key. Closing an alert frees the key so a
-- recurrence can re-raise. Partial index = the dedupe guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedupe_open
  ON alerts(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status != 'closed';

CREATE TABLE IF NOT EXISTS alert_topics (
  alert_id    INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  topic_slug  TEXT    NOT NULL REFERENCES topics(slug) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (alert_id, topic_slug)
);

CREATE INDEX IF NOT EXISTS idx_alert_topics_topic ON alert_topics(topic_slug);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
