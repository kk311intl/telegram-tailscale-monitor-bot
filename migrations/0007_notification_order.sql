CREATE INDEX IF NOT EXISTS idx_notification_outbox_server_pending
  ON notification_outbox(server_id, sent_at, failed_at, id);
