-- Device checks no longer use the legacy per-device due-time index.
DROP INDEX IF EXISTS idx_servers_due;
