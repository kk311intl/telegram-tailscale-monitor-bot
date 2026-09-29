CREATE TABLE IF NOT EXISTS auxiliary_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('sync_lost', 'sync_restored', 'device_added', 'device_removed', 'key_expiring')),
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL DEFAULT 0,
  failed_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auxiliary_alerts_due
  ON auxiliary_alerts(sent_at, failed_at, next_attempt_at, lease_until, id);
