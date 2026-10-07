// Covers OAuth, device/GeoIP reads and up to five bounded notification requests.
const UPDATE_LEASE_SECONDS = 180;

export async function claimUpdate(database, updateId, now = nowSeconds()) {
  const leaseToken = crypto.randomUUID();
  const result = await database.prepare(`
    INSERT INTO processed_updates(update_id, processed_at, status, lease_token, lease_until)
    VALUES (?, ?, 'processing', ?, ?)
    ON CONFLICT(update_id) DO UPDATE SET
      processed_at = excluded.processed_at, status = 'processing',
      lease_token = excluded.lease_token, lease_until = excluded.lease_until,
      last_error = ''
    WHERE processed_updates.status = 'failed'
       OR (processed_updates.status = 'processing' AND processed_updates.lease_until <= ?)
  `).bind(updateId, now, leaseToken, now + UPDATE_LEASE_SECONDS, now).run();
  if (Number(result.meta.changes || 0) === 1) {
    return { state: "claimed", updateId, leaseToken };
  }
  const existing = await database.prepare(
    "SELECT status FROM processed_updates WHERE update_id = ?"
  ).bind(updateId).first();
  return { state: existing?.status === "done" ? "done" : "busy", updateId, leaseToken: "" };
}

export async function completeUpdate(database, context) {
  const result = await database.prepare(`
    UPDATE processed_updates SET status = 'done', lease_token = '', lease_until = 0, last_error = ''
    WHERE update_id = ? AND status = 'processing' AND lease_token = ?
  `).bind(context.updateId, context.leaseToken).run();
  if (Number(result.meta.changes || 0) !== 1) throw new Error("Webhook update completion lease lost");
}

export async function releaseUpdate(database, context, error) {
  await database.prepare(`
    UPDATE processed_updates SET status = 'failed', attempts = attempts + 1,
      lease_token = '', lease_until = 0, last_error = ?
    WHERE update_id = ? AND status = 'processing' AND lease_token = ?
  `).bind(safeError(error), context.updateId, context.leaseToken).run();
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }
function safeError(error) { return String(error?.message || error || "未知錯誤").replace(/[\r\n]+/g, " ").slice(0, 300); }
