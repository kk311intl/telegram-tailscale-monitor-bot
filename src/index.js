import {
  clampInteger,
  compareTailscaleAddresses,
  countryCodeToFlag,
  escapeHtml,
  evaluateObservation,
  formatAge,
  formatLocalTime,
  hasHiddenTag,
  normalizeTailscaleDevice,
  notificationFailurePlan
} from "./helpers.js";
import { claimUpdate, completeUpdate, releaseUpdate } from "./update-lifecycle.js";
import { acquireLease, releaseLease, readState, checkCooldown, setCooldown, retrySeconds, requestJson } from "./api-runtime.js";
import { t } from "./i18n.js";

const TELEGRAM_API = "https://api.telegram.org";
const TAILSCALE_API = "https://api.tailscale.com/api/v2";
const MAX_BODY_BYTES = 256 * 1024;
const API_TIMEOUT_MS = 10000;
const LIST_PAGE_SIZE = 10;
const GEOIP_API = "https://api.country.is";
const GEOIP_CACHE_SECONDS = 7 * 86400;
const GEOIP_RETRY_SECONDS = 6 * 3600;
const GEOIP_LOOKUPS_PER_SYNC = 5;
const SYNC_ALERT_SECONDS = 5 * 60;
const KEY_EXPIRY_WARNING_SECONDS = 7 * 86400;
let oauthCache = { clientId: "", token: "", expiresAt: 0 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: env.HEALTH_SERVICE || "tailscale-server-monitor", monitor: "tailscale-api" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.ADMIN_USER_ID) {
      return new Response("Service configuration error", { status: 503 });
    }
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!(await secureEqual(supplied, env.WEBHOOK_SECRET))) {
      return new Response("Forbidden", { status: 403 });
    }
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return new Response("Payload too large", { status: 413 });
    let update;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        return new Response("Payload too large", { status: 413 });
      }
      update = JSON.parse(body);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!update || !Number.isSafeInteger(update.update_id)) return new Response("Bad request", { status: 400 });
    const updateContext = await claimUpdate(env.STATUS_DB, update.update_id);
    if (updateContext.state === "done") return json({ ok: true, duplicate: true });
    if (updateContext.state === "busy") {
      return json({ ok: false, retry: true }, { status: 503, headers: { "retry-after": "2" } });
    }
    try {
      await processUpdate(update, env);
      await completeUpdate(env.STATUS_DB, updateContext);
      return json({ ok: true });
    } catch (error) {
      console.error("Update processing failed", safeError(error));
      await releaseUpdate(env.STATUS_DB, updateContext, error);
      return json({ ok: false, retry: true }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledChecks(event, env));
  }
};

export async function processUpdate(update, env) {
  if (update.callback_query) return processCallback(update.callback_query, env);
  if (update.message) return processMessage(update.message, env);
}

async function processMessage(message, env) {
  if (!message?.from || message.from.is_bot) return;
  if (String(message.from.id) !== String(env.ADMIN_USER_ID)) return;
  if (message.chat?.type !== "private") {
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: t(env.BOT_LANGUAGE, "privateOnly") });
    return;
  }
  if (String(message.chat.id) !== String(env.ADMIN_USER_ID)) return;
  const text = String(message.text || "").trim();
  const command = parseCommand(text);
  if (command === "start") return telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    ...(await dashboardView(env))
  });
  if (command === "status") return telegram(env, "sendMessage", {
    chat_id: message.chat.id, ...(await refreshDashboard(env))
  });
  if (command === "list") return sendDeviceList(message.chat.id, env, 0);
  const match = text.match(/^\/device(?:@[A-Za-z0-9_]+)?\s+(\d+)$/i);
  if (match) return sendDeviceDetail(message.chat.id, env, Number(match[1]));
  return telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: t(env.BOT_LANGUAGE, "prompt"),
    reply_markup: mainKeyboard(env)
  });
}

async function processCallback(query, env) {
  const privateOwnerChat = query?.message?.chat?.type === "private" &&
    String(query.message.chat.id) === String(env.ADMIN_USER_ID);
  if (!query?.from || String(query.from.id) !== String(env.ADMIN_USER_ID) || !privateOwnerChat) {
    if (query?.id) await telegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: t(env.BOT_LANGUAGE, "unauthorized"), show_alert: true });
    return;
  }
  try {
    await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
  } catch (error) {
    if (error.telegramErrorCode !== 400 || !/query is too old|query ID is invalid/i.test(error.message)) throw error;
  }
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [action, rawId = "", rawPage = ""] = String(query.data || "").split(":");
  if (action === "home") return editOrSend(chatId, messageId, await refreshDashboard(env, Number(rawId || 0)), env);
  if (action === "page") return editOrSend(chatId, messageId, await dashboardView(env, "", Number(rawId || 0)), env);
  if (action === "list") return editDeviceList(chatId, messageId, env, Number(rawId || 0));
  if (action === "detail") return editDeviceDetail(chatId, messageId, env, Number(rawId), Number(rawPage || 0));
  if (action === "check") {
    const id = Number(rawId);
    const warning = await syncWarning(env);
    await drainNotificationOutbox(env, 5);
    return editDeviceDetail(chatId, messageId, env, id, Number(rawPage || 0), warning);
  }
}

export async function runScheduledChecks(event, env) {
  await syncWarning(env);
  try {
    await updateSyncHealth(env);
    await drainAuxiliaryAlerts(env, 5);
  } catch (error) {
    console.error("Auxiliary alert processing failed", safeError(error));
  }
  await drainNotificationOutbox(env, 5);
  const scheduledSeconds = Math.floor(Number(event?.scheduledTime || Date.now()) / 1000);
  if (Math.floor(scheduledSeconds / 60) % 60 === 17) {
    await env.STATUS_DB.batch([
      env.STATUS_DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?").bind(scheduledSeconds - 7 * 86400),
      env.STATUS_DB.prepare("DELETE FROM pending_actions WHERE expires_at < ?").bind(scheduledSeconds),
      env.STATUS_DB.prepare("DELETE FROM status_events WHERE created_at < ?").bind(scheduledSeconds - 90 * 86400),
      env.STATUS_DB.prepare(`
        DELETE FROM notification_outbox
        WHERE (sent_at > 0 AND sent_at < ?) OR (failed_at > 0 AND failed_at < ?)
      `).bind(scheduledSeconds - 90 * 86400, scheduledSeconds - 90 * 86400),
      env.STATUS_DB.prepare(`
        DELETE FROM auxiliary_alerts
        WHERE (sent_at > 0 AND sent_at < ?) OR (failed_at > 0 AND failed_at < ?)
      `).bind(scheduledSeconds - 90 * 86400, scheduledSeconds - 90 * 86400)
    ]);
  }
}

export async function fetchTailscaleDevices(env, fetchImpl = fetch) {
  const token = await getTailscaleAccessToken(env, fetchImpl);
  const tailnet = encodeURIComponent(String(env.TAILSCALE_TAILNET || "-").trim() || "-");
  const { response, data } = await tailscaleJson(env, fetchImpl, `${TAILSCALE_API}/tailnet/${tailnet}/devices?fields=all`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" }
  }, "Tailscale Devices API");
  if (!response.ok) throw new Error(`Tailscale Devices API: HTTP ${response.status}`);
  if (!Array.isArray(data?.devices)) throw new Error("Tailscale Devices API: 回應格式無效");
  return data.devices.map(normalizeTailscaleDevice);
}

async function getTailscaleAccessToken(env, fetchImpl) {
  const clientId = String(env.TAILSCALE_CLIENT_ID || "").trim();
  const clientSecret = String(env.TAILSCALE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) throw new Error("尚未設定 TAILSCALE_CLIENT_ID 或 TAILSCALE_CLIENT_SECRET");
  const now = Date.now();
  if (oauthCache.clientId === clientId && oauthCache.token && oauthCache.expiresAt > now + 60000) return oauthCache.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" });
  const { response, data } = await tailscaleJson(env, fetchImpl, `${TAILSCALE_API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString()
  }, "Tailscale OAuth");
  if (!response.ok) throw new Error(`Tailscale OAuth: HTTP ${response.status}`);
  if (!data?.access_token || !Number.isFinite(Number(data.expires_in))) throw new Error("Tailscale OAuth: 回應格式無效");
  oauthCache = {
    clientId,
    token: String(data.access_token),
    expiresAt: now + Math.max(60, Number(data.expires_in)) * 1000
  };
  return oauthCache.token;
}

async function tailscaleJson(env, fetchImpl, url, init, label) {
  await checkCooldown(env.STATUS_DB, 'tailscale');
  const result = await requestJson(fetchImpl, url, init, label, API_TIMEOUT_MS);
  if (result.response.status === 429) {
    const state = env.STATUS_DB ? await readState(env.STATUS_DB, 'tailscale') : {};
    const fallback = Math.min(900, 60 * 2 ** Math.min(Number(state.failures || 0), 4)) + Math.floor(Math.random() * 15);
    await setCooldown(env.STATUS_DB, 'tailscale', retrySeconds(result.response.headers.get('retry-after'), fallback));
  }
  return result;
}

export async function syncTailscaleDevices(env, notify) {
  const lease = await acquireLease(env.STATUS_DB, 'sync', 120);
  if (!lease) throw new Error('設備正在同步，請稍後更新');
  try {
  const fetchedDevices = await fetchTailscaleDevices(env);
  const checkedAt = nowSeconds();
  const syncToken = crypto.randomUUID();
  const existingQuery = await env.STATUS_DB.prepare(
    "SELECT * FROM servers WHERE ports = 'tailscale'"
  ).all();
  const existingById = new Map((existingQuery.results || []).map((row) => [String(row.host), row]));
  const hasBaseline = Number((await readState(env.STATUS_DB, 'visibility')).until_at || 0) > 0;
  const fetchedIds = new Set(fetchedDevices.map((device) => device.id));
  const hiddenTags = new Set(String(env.HIDDEN_TAGS || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const visibleDevices = fetchedDevices.filter((device) => !hasHiddenTag(device, hiddenTags));
  const devices = env.GEOIP_ENABLED === "true"
    ? await enrichDeviceCountries(visibleDevices, existingById, checkedAt)
    : visibleDevices.map((device) => ({ ...device, country: "" }));
  const statements = [];
  const fence = "EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())";
  for (const device of devices) {
    const existing = existingById.get(device.id);
    statements.push(...persistTailscaleDevice(device, checkedAt, syncToken, env, notify, existing, lease));
    if (notify && env.BOT_TOKEN && env.ADMIN_USER_ID) {
      const payload = { deviceId: device.id, name: device.displayName };
      if (hasBaseline && !existing) statements.push(auxiliaryAlertStatement(env.STATUS_DB,
        `device-added:${device.id}:${syncToken}`, 'device_added', payload, checkedAt, lease));
      const expiresAt = Math.floor(Date.parse(device.expires) / 1000);
      if (Number.isFinite(expiresAt) && expiresAt > checkedAt && expiresAt <= checkedAt + KEY_EXPIRY_WARNING_SECONDS) {
        statements.push(auxiliaryAlertStatement(env.STATUS_DB,
          `key-expiring:${device.id}:${device.expires}`, 'key_expiring', { ...payload, expires: device.expires }, checkedAt, lease));
      }
    }
  }
  if (notify && hasBaseline && env.BOT_TOKEN && env.ADMIN_USER_ID) {
    for (const row of existingQuery.results || []) {
      if (Number(row.enabled) === 1 && !fetchedIds.has(String(row.host))) {
        statements.push(auxiliaryAlertStatement(env.STATUS_DB,
          `device-removed:${row.host}:${syncToken}`, 'device_removed', { deviceId: String(row.host), name: row.name }, checkedAt, lease));
      }
    }
  }
  statements.push(env.STATUS_DB.prepare(`
    UPDATE servers SET enabled = 0, updated_at = ?
    WHERE ports = 'tailscale' AND enabled = 1 AND COALESCE(last_check_token, '') != ? AND ${fence}
  `).bind(checkedAt, syncToken, lease));
  statements.push(env.STATUS_DB.prepare(`UPDATE notification_outbox SET failed_at = ?, last_error = 'device hidden'
    WHERE sent_at = 0 AND failed_at = 0 AND server_id IN (SELECT id FROM servers WHERE ports = 'tailscale' AND enabled = 0)
    AND ${fence}`).bind(checkedAt, lease));
  statements.push(env.STATUS_DB.prepare(`INSERT INTO runtime_state(key, until_at)
    SELECT 'visibility', ? WHERE ${fence}
    ON CONFLICT(key) DO UPDATE SET until_at = excluded.until_at`).bind(checkedAt + 120, lease));
  const results = await env.STATUS_DB.batch(statements);
  if (Number(results.at(-1)?.meta?.changes) !== 1) throw new Error('同步已逾時，未套用設備資料');
  await env.STATUS_DB.prepare("UPDATE runtime_state SET failures = 0, until_at = 0 WHERE key = 'tailscale'").run();
  return devices.length;
  } finally { await releaseLease(env.STATUS_DB, 'sync', lease); }
}

function auxiliaryAlertStatement(db, key, kind, payload, createdAt, lease) {
  return db.prepare(`INSERT OR IGNORE INTO auxiliary_alerts(alert_key, kind, payload, next_attempt_at, created_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())`
  ).bind(key, kind, JSON.stringify(payload), createdAt, createdAt, lease);
}

async function enrichDeviceCountries(devices, existingById, checkedAt, fetchImpl = fetch) {
  const candidates = [];
  const enriched = devices.map((device) => {
    const previous = parseDevice(existingById.get(device.id)?.last_results);
    const samePublicIp = Boolean(device.publicIp && device.publicIp === previous.publicIp);
    const cachedCountry = samePublicIp && /^[A-Z]{2}$/.test(String(previous.country || "").toUpperCase())
      ? String(previous.country).toUpperCase()
      : "";
    const countryCheckedAt = samePublicIp ? Number(previous.countryCheckedAt || 0) : 0;
    const countryRetryAt = samePublicIp ? Number(previous.countryRetryAt || 0) : 0;
    const next = { ...device, country: cachedCountry, countryCheckedAt, countryRetryAt };
    if (device.publicIp && checkedAt >= countryRetryAt && (!cachedCountry || checkedAt - countryCheckedAt >= GEOIP_CACHE_SECONDS)) {
      candidates.push(next);
    }
    return next;
  });
  await Promise.all(candidates.slice(0, GEOIP_LOOKUPS_PER_SYNC).map(async (device) => {
    try {
      const { response, data } = await requestJson(
        fetchImpl,
        `${GEOIP_API}/${encodeURIComponent(device.publicIp)}`,
        { headers: { accept: "application/json" } },
        "GeoIP"
      );
      if (!response.ok) throw new Error(`GeoIP: HTTP ${response.status}`);
      const country = String(data?.country || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new Error("GeoIP: 回應格式無效");
      device.country = country;
      device.countryCheckedAt = checkedAt;
      device.countryRetryAt = 0;
    } catch (error) {
      device.countryRetryAt = checkedAt + GEOIP_RETRY_SECONDS;
      console.error("GeoIP lookup failed", safeError(error));
    }
  }));
  return enriched;
}

function persistTailscaleDevice(device, checkedAt, syncToken, env, notify, existing, lease) {
  const base = existing && Number(existing.enabled) === 1 ? existing : { status: "unknown" };
  const previousDevice = parseDevice(existing?.last_results);
  const canCount = device.connectedToControl || !base.consecutive_failures || checkedAt - Number(previousDevice.observationAt || existing?.last_checked_at || 0) >= 60;
  const observation = canCount
    ? evaluateObservation(base, device.connectedToControl, clampInteger(env.OFFLINE_AFTER, 2, 10, 2))
    : { status: base.status, failures: base.consecutive_failures, successes: 0, event: null };
  device.observationAt = canCount ? checkedAt : Number(previousDevice.observationAt || existing?.last_checked_at || 0);
  const changedAt = observation.event ? checkedAt : Number(existing?.last_changed_at || 0);
  const eventLastSeen = observation.event === "recovered" ? previousDevice.lastSeen : device.lastSeen;
  const metadata = JSON.stringify([device]);
  if (!existing) {
    return [env.STATUS_DB.prepare(`
      INSERT INTO servers(
        name, host, ports, enabled, status, consecutive_failures, consecutive_successes,
        last_checked_at, last_changed_at, last_results, last_error,
        revision, last_check_token, created_at, updated_at
      ) SELECT ?, ?, 'tailscale', 1, ?, ?, ?, ?, 0, ?, '', 0, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
    `).bind(
      device.displayName, device.id, observation.status, observation.failures, observation.successes,
      checkedAt, metadata, syncToken, checkedAt, checkedAt, lease
    )];
  }
  const checkToken = `${syncToken}:${existing.id}`;
  const statements = [env.STATUS_DB.prepare(`
    UPDATE servers SET name = ?, enabled = 1, status = ?, consecutive_failures = ?,
      consecutive_successes = ?, last_checked_at = ?, last_changed_at = ?, last_results = ?,
      last_error = '', revision = revision + 1, last_check_token = ?, updated_at = ?
    WHERE id = ? AND revision = ? AND host = ? AND ports = 'tailscale'
      AND EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
  `).bind(
    device.displayName, observation.status, observation.failures, observation.successes,
    checkedAt, changedAt, metadata, syncToken, checkedAt,
    existing.id, Number(existing.revision || 0), device.id, lease
  )];
  if (observation.event) {
    statements.push(env.STATUS_DB.prepare(`
      INSERT INTO status_events(server_id, event, detail, created_at)
      SELECT id, ?, ?, ? FROM servers WHERE id = ? AND last_check_token = ?
    `).bind(observation.event, eventLastSeen || "", checkedAt, existing.id, syncToken));
    if (notify && env.BOT_TOKEN && env.ADMIN_USER_ID) {
      statements.push(env.STATUS_DB.prepare(`
        INSERT INTO notification_outbox(server_id, check_token, event, payload, next_attempt_at, created_at)
        SELECT id, ?, ?, ?, ?, ? FROM servers WHERE id = ? AND last_check_token = ?
      `).bind(checkToken, observation.event, JSON.stringify({
        id: existing.id,
        name: device.displayName,
        device,
        event: observation.event,
        eventTime: checkedAt
      }), checkedAt, checkedAt, existing.id, syncToken));
    }
  }
  return statements;
}

async function drainNotificationOutbox(env, limit) {
  if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) return;
  if (!(await visibilityFresh(env))) return;
  const due = await env.STATUS_DB.prepare(`
    SELECT n.* FROM notification_outbox n
    JOIN servers s ON s.id = n.server_id
    WHERE s.ports = 'tailscale' AND s.enabled = 1 AND n.sent_at = 0 AND n.failed_at = 0
      AND n.next_attempt_at <= ? AND n.lease_until <= ?
    ORDER BY n.next_attempt_at ASC, n.id ASC LIMIT ?
  `).bind(nowSeconds(), nowSeconds(), limit).all();
  for (const notification of due.results || []) {
    if (!(await visibilityFresh(env))) break;
    if ((await readState(env.STATUS_DB, 'telegram')).until_at > nowSeconds()) break;
    await deliverNotification(notification, env);
  }
}

async function deliverNotification(notification, env) {
  const syncLease = await acquireLease(env.STATUS_DB, 'sync', 120);
  if (!syncLease) return;
  try {
  if (!(await visibilityFresh(env))) return;
  const leaseToken = crypto.randomUUID();
  const claimed = await env.STATUS_DB.prepare(`
    UPDATE notification_outbox SET lease_token = ?, lease_until = ?
    WHERE id = ? AND sent_at = 0 AND failed_at = 0 AND next_attempt_at <= ? AND lease_until <= ?
      AND server_id IN (SELECT id FROM servers WHERE ports = 'tailscale' AND enabled = 1)
  `).bind(leaseToken, nowSeconds() + 60, notification.id, nowSeconds(), nowSeconds()).run();
  if (Number(claimed.meta?.changes || 0) !== 1) return;
  try {
    const payload = JSON.parse(notification.payload);
    await sendStatusNotification(payload, env);
    await env.STATUS_DB.prepare(`
      UPDATE notification_outbox SET sent_at = ?, last_error = '', lease_token = '', lease_until = 0
      WHERE id = ? AND sent_at = 0 AND lease_token = ?
    `).bind(nowSeconds(), notification.id, leaseToken).run();
  } catch (error) {
    const plan = notificationFailurePlan(error, notification.attempts, nowSeconds());
    if (plan.terminal) {
      await env.STATUS_DB.prepare(`
        UPDATE notification_outbox SET attempts = ?, failed_at = ?, last_error = ?, lease_token = '', lease_until = 0
        WHERE id = ? AND sent_at = 0 AND lease_token = ?
      `).bind(plan.attempts, nowSeconds(), safeError(error), notification.id, leaseToken).run();
    } else {
      await env.STATUS_DB.prepare(`
        UPDATE notification_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, lease_token = '', lease_until = 0
        WHERE id = ? AND sent_at = 0 AND lease_token = ?
      `).bind(plan.attempts, plan.nextAttemptAt, safeError(error), notification.id, leaseToken).run();
    }
    console.error("Status notification failed", safeError(error));
  }
  } finally { await releaseLease(env.STATUS_DB, 'sync', syncLease); }
}

async function sendStatusNotification(payload, env) {
  const offline = payload.event === "down";
  const label = deviceLabel(payload.name, payload.device, env);
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_USER_ID,
    text: [
      `${offline ? "🔴" : "🟢"} <b>${t(env.BOT_LANGUAGE, offline ? "offlineTitle" : "recoveredTitle")}</b>`,
      `<b>${escapeHtml(label)}</b>`,
      offline
        ? `${t(env.BOT_LANGUAGE, "lastOnline")}${t(env.BOT_LANGUAGE, "colon")}${formatTailscaleTime(payload.device.lastSeen, env.TIME_ZONE, env.BOT_LANGUAGE)}`
        : `${t(env.BOT_LANGUAGE, "recoveryTime")}${t(env.BOT_LANGUAGE, "colon")}${formatLocalTime(payload.eventTime, env.TIME_ZONE)}`
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: t(env.BOT_LANGUAGE, "viewDetails"), callback_data: `detail:${payload.id}:0` }]] }
  });
}

async function updateSyncHealth(env) {
  if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) return;
  const lease = await acquireLease(env.STATUS_DB, 'monitor-health-lock', 120);
  if (!lease) return;
  try {
    const now = nowSeconds();
    await env.STATUS_DB.prepare("INSERT OR IGNORE INTO runtime_state(key, until_at) VALUES ('monitor-health', ?)").bind(now).run();
    const state = await readState(env.STATUS_DB, 'monitor-health');
    const visibility = await readState(env.STATUS_DB, 'visibility');
    const lastSuccess = Math.max(0, Number(visibility.until_at || 0) - 120);
    if (lastSuccess > 0 && now - lastSuccess < SYNC_ALERT_SECONDS) {
      if (state.token) {
        const lostKey = `sync-lost:${state.token}`;
        const lost = await env.STATUS_DB.prepare("SELECT sent_at FROM auxiliary_alerts WHERE alert_key = ?").bind(lostKey).first();
        const statement = lost?.sent_at > 0
          ? env.STATUS_DB.prepare(`INSERT OR IGNORE INTO auxiliary_alerts(alert_key, kind, payload, next_attempt_at, created_at)
              VALUES (?, 'sync_restored', '{}', ?, ?)`).bind(`sync-restored:${state.token}`, now, now)
          : env.STATUS_DB.prepare("UPDATE auxiliary_alerts SET failed_at = ?, last_error = 'sync restored before delivery' WHERE alert_key = ? AND sent_at = 0 AND failed_at = 0").bind(now, lostKey);
        await env.STATUS_DB.batch([
          statement,
          env.STATUS_DB.prepare("UPDATE runtime_state SET token = '', until_at = 0 WHERE key = 'monitor-health'")
        ]);
      } else if (state.until_at) {
        await env.STATUS_DB.prepare("UPDATE runtime_state SET until_at = 0 WHERE key = 'monitor-health'").run();
      }
      return;
    }
    const episode = lastSuccess || Number(state.until_at || now);
    if (!state.token && now - episode >= SYNC_ALERT_SECONDS) {
      await env.STATUS_DB.batch([
        env.STATUS_DB.prepare(`INSERT OR IGNORE INTO auxiliary_alerts(alert_key, kind, payload, next_attempt_at, created_at)
          VALUES (?, 'sync_lost', '{}', ?, ?)`).bind(`sync-lost:${episode}`, now, now),
        env.STATUS_DB.prepare("UPDATE runtime_state SET token = ? WHERE key = 'monitor-health'").bind(String(episode))
      ]);
    }
  } finally { await releaseLease(env.STATUS_DB, 'monitor-health-lock', lease); }
}

async function drainAuxiliaryAlerts(env, limit) {
  if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) return;
  const due = await env.STATUS_DB.prepare(`SELECT * FROM auxiliary_alerts
    WHERE sent_at = 0 AND failed_at = 0 AND next_attempt_at <= ? AND lease_until <= ?
    ORDER BY CASE WHEN kind LIKE 'sync_%' THEN 0 ELSE 1 END, id LIMIT ?`
  ).bind(nowSeconds(), nowSeconds(), limit).all();
  for (const alert of due.results || []) {
    if ((await readState(env.STATUS_DB, 'telegram')).until_at > nowSeconds()) break;
    await deliverAuxiliaryAlert(alert, env);
  }
}

async function deliverAuxiliaryAlert(alert, env) {
  const health = alert.kind === 'sync_lost' || alert.kind === 'sync_restored';
  const healthLease = health ? await acquireLease(env.STATUS_DB, 'monitor-health-lock', 120) : '';
  if (health && !healthLease) return;
  try {
    const leaseToken = crypto.randomUUID();
    const now = nowSeconds();
    const claimed = await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET lease_token = ?, lease_until = ?
      WHERE id = ? AND sent_at = 0 AND failed_at = 0 AND next_attempt_at <= ? AND lease_until <= ?`
    ).bind(leaseToken, now + 60, alert.id, now, now).run();
    if (Number(claimed.meta?.changes || 0) !== 1) return;
    try {
      const payload = JSON.parse(alert.payload);
      const validity = await auxiliaryAlertValidity(alert, payload, env);
      if (validity === 'wait') {
        await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET lease_token = '', lease_until = 0, next_attempt_at = ?
          WHERE id = ? AND lease_token = ?`).bind(nowSeconds() + 60, alert.id, leaseToken).run();
        return;
      }
      if (validity === 'cancel') {
        await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET failed_at = ?, last_error = 'condition no longer applies', lease_token = '', lease_until = 0
          WHERE id = ? AND lease_token = ?`).bind(nowSeconds(), alert.id, leaseToken).run();
        return;
      }
      await sendAuxiliaryAlert(alert.kind, payload, env);
      await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET sent_at = ?, last_error = '', lease_token = '', lease_until = 0
        WHERE id = ? AND sent_at = 0 AND lease_token = ?`).bind(nowSeconds(), alert.id, leaseToken).run();
    } catch (error) {
      const plan = notificationFailurePlan(error, alert.attempts, nowSeconds());
      if (plan.terminal) {
        await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET attempts = ?, failed_at = ?, last_error = ?, lease_token = '', lease_until = 0
          WHERE id = ? AND sent_at = 0 AND lease_token = ?`
        ).bind(plan.attempts, nowSeconds(), safeError(error), alert.id, leaseToken).run();
      } else {
        await env.STATUS_DB.prepare(`UPDATE auxiliary_alerts SET attempts = ?, next_attempt_at = ?, last_error = ?, lease_token = '', lease_until = 0
          WHERE id = ? AND sent_at = 0 AND lease_token = ?`
        ).bind(plan.attempts, plan.nextAttemptAt, safeError(error), alert.id, leaseToken).run();
      }
      console.error("Auxiliary alert failed", safeError(error));
    }
  } finally {
    if (healthLease) await releaseLease(env.STATUS_DB, 'monitor-health-lock', healthLease);
  }
}

async function auxiliaryAlertValidity(alert, payload, env) {
  if (alert.kind === 'sync_lost') {
    const state = await readState(env.STATUS_DB, 'monitor-health');
    return state.token && alert.alert_key === `sync-lost:${state.token}` && !(await visibilityFresh(env)) ? 'send' : 'cancel';
  }
  if (alert.kind === 'sync_restored') {
    if ((await readState(env.STATUS_DB, 'monitor-health')).token) return 'cancel';
    return await visibilityFresh(env) ? 'send' : 'wait';
  }
  if (!(await visibilityFresh(env))) return 'wait';
  const row = await env.STATUS_DB.prepare("SELECT enabled, last_results FROM servers WHERE host = ? AND ports = 'tailscale'")
    .bind(payload.deviceId).first();
  if (alert.kind === 'device_added') return Number(row?.enabled) === 1 ? 'send' : 'cancel';
  if (alert.kind === 'device_removed') return row && Number(row.enabled) === 0 ? 'send' : 'cancel';
  if (alert.kind === 'key_expiring') {
    const expiresAt = Math.floor(Date.parse(payload.expires) / 1000);
    return Number(row?.enabled) === 1 && parseDevice(row.last_results).expires === payload.expires &&
      Number.isFinite(expiresAt) && expiresAt > nowSeconds() ? 'send' : 'cancel';
  }
  return 'cancel';
}

async function sendAuxiliaryAlert(kind, payload, env) {
  const lang = env.BOT_LANGUAGE;
  const name = escapeHtml(payload.name || '');
  const messages = {
    sync_lost: `⚠️ <b>${t(lang, 'syncLostTitle')}</b>\n${t(lang, 'syncLostBody')}`,
    sync_restored: `🟢 <b>${t(lang, 'syncRestoredTitle')}</b>`,
    device_added: `🆕 <b>${t(lang, 'deviceAddedTitle')}</b>\n<b>${name}</b>`,
    device_removed: `⚪ <b>${t(lang, 'deviceRemovedTitle')}</b>\n<b>${name}</b>`,
    key_expiring: `⚠️ <b>${t(lang, 'keyExpiringTitle')}</b>\n<b>${name}</b>\n${t(lang, 'keyExpires')}${t(lang, 'colon')}${formatTailscaleTime(payload.expires, env.TIME_ZONE, lang)}`
  };
  await telegram(env, 'sendMessage', { chat_id: env.ADMIN_USER_ID, text: messages[kind], parse_mode: 'HTML' });
}

async function syncWarning(env) {
  try {
    await syncTailscaleDevices(env, true);
    return "";
  } catch (error) {
    console.error("Tailscale sync failed", safeError(error));
    return safeError(error);
  }
}

async function refreshDashboard(env, page = 0) {
  const warning = await syncWarning(env);
  await drainNotificationOutbox(env, 5);
  return dashboardView(env, warning, page);
}

async function dashboardView(env, warning = "", requestedPage = 0) {
  if (!(await visibilityFresh(env))) return unavailableView(env);
  const query = await env.STATUS_DB.prepare(`
    SELECT * FROM servers WHERE ports = 'tailscale' AND enabled = 1
  `).all();
  const devices = (query.results || []).sort(compareDeviceRows);
  const pages = Math.max(1, Math.ceil(devices.length / LIST_PAGE_SIZE));
  const page = clampInteger(requestedPage, 0, pages - 1, 0);
  const lines = devices.length
    ? devices.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE).map((row) => formatDashboardDevice(row, env))
    : [t(env.BOT_LANGUAGE, "noDevices")];
  return {
    text: [
      `<b>${escapeHtml(truncate(env.BOT_TITLE || t(env.BOT_LANGUAGE, "dashboardTitle"), 80))}</b>`,
      "",
      `🟢 ${t(env.BOT_LANGUAGE, "online")}${t(env.BOT_LANGUAGE, "colon")}${devices.filter((item) => item.status === "up").length}`,
      `🔴 ${t(env.BOT_LANGUAGE, "offline")}${t(env.BOT_LANGUAGE, "colon")}${devices.filter((item) => item.status === "down").length}`,
      `⚪ ${t(env.BOT_LANGUAGE, "pending")}${t(env.BOT_LANGUAGE, "colon")}${devices.filter((item) => item.status === "unknown").length}`,
      `📋 ${t(env.BOT_LANGUAGE, "total")}${t(env.BOT_LANGUAGE, "colon")}${devices.length}`,
      warning ? `\n⚠️ ${t(env.BOT_LANGUAGE, "syncFailed")}` : "",
      "",
      `<b>${t(env.BOT_LANGUAGE, "allDevices")}</b>${pages > 1 ? ` · ${page + 1}/${pages}` : ""}`,
      ...lines
    ].filter(Boolean).join("\n"),
    parse_mode: "HTML",
    reply_markup: mainKeyboard(env, page, pages)
  };
}

function formatDashboardDevice(row, env) {
  const label = deviceLabel(row.name, parseDevice(row.last_results), env);
  return `${statusIcon(row.status)} <b>${escapeHtml(truncate(label, 35))}</b>`;
}

function deviceLabel(name, device, env) {
  const flag = env.GEOIP_ENABLED === "true" ? countryCodeToFlag(device?.country) : "";
  return `${name}${flag ? ` ${flag}` : ""}`;
}

function compareDeviceRows(left, right) {
  const byAddress = compareTailscaleAddresses(
    parseDevice(left.last_results).addresses?.[0],
    parseDevice(right.last_results).addresses?.[0]
  );
  return byAddress || String(left.name).localeCompare(String(right.name), "zh-Hant");
}

function mainKeyboard(env, page = 0, pages = 1) {
  const buttons = [[
    { text: `📋 ${t(env.BOT_LANGUAGE, "deviceList")}`, callback_data: "list:0" },
    { text: `🔄 ${t(env.BOT_LANGUAGE, "refresh")}`, callback_data: `home:${page}` }
  ]];
  if (pages > 1) {
    const navigation = [];
    if (page > 0) navigation.push({ text: t(env.BOT_LANGUAGE, "previous"), callback_data: `page:${page - 1}` });
    navigation.push({ text: `${page + 1}/${pages}`, callback_data: `page:${page}` });
    if (page + 1 < pages) navigation.push({ text: t(env.BOT_LANGUAGE, "next"), callback_data: `page:${page + 1}` });
    buttons.push(navigation);
  }
  return { inline_keyboard: buttons };
}

async function sendDeviceList(chatId, env, page) {
  return telegram(env, "sendMessage", { chat_id: chatId, ...(await deviceListView(env, page)) });
}

async function editDeviceList(chatId, messageId, env, page) {
  return editOrSend(chatId, messageId, await deviceListView(env, page), env);
}

async function deviceListView(env, requestedPage) {
  if (!(await visibilityFresh(env))) return unavailableView(env);
  const query = await env.STATUS_DB.prepare(`
    SELECT * FROM servers WHERE ports = 'tailscale' AND enabled = 1
  `).all();
  const allRows = (query.results || []).sort(compareDeviceRows);
  const total = allRows.length;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Number(requestedPage || 0)));
  const rows = allRows.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const buttons = rows.map((row) => [{
    text: `${statusIcon(row.status)} ${truncate(deviceLabel(row.name, parseDevice(row.last_results), env), 33)}`,
    callback_data: `detail:${row.id}:${page}`
  }]);
  const navigation = [];
  if (page > 0) navigation.push({ text: t(env.BOT_LANGUAGE, "previous"), callback_data: `list:${page - 1}` });
  navigation.push({ text: `${page + 1}/${pages}`, callback_data: `list:${page}` });
  if (page + 1 < pages) navigation.push({ text: t(env.BOT_LANGUAGE, "next"), callback_data: `list:${page + 1}` });
  buttons.push(navigation);
  buttons.push([{ text: t(env.BOT_LANGUAGE, "backOverview"), callback_data: "home" }]);
  return {
    text: `<b>${t(env.BOT_LANGUAGE, "deviceList")}</b>\n${t(env.BOT_LANGUAGE, "listSummary", total)}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons }
  };
}

async function sendDeviceDetail(chatId, env, id, page = 0) {
  return telegram(env, "sendMessage", { chat_id: chatId, ...(await deviceDetailView(env, id, page)) });
}

async function editDeviceDetail(chatId, messageId, env, id, page = 0, warning = "") {
  return editOrSend(chatId, messageId, await deviceDetailView(env, id, page, warning), env);
}

async function deviceDetailView(env, id, page, warning = "") {
  if (!(await visibilityFresh(env))) return unavailableView(env);
  const row = await getDeviceRow(env, id);
  if (!row) return { text: t(env.BOT_LANGUAGE, "removed"), reply_markup: mainKeyboard(env) };
  const device = parseDevice(row.last_results);
  const label = deviceLabel(row.name, device, env);
  return {
    text: [
      `${statusIcon(row.status)} <b>${escapeHtml(label)}</b>`,
      `${t(env.BOT_LANGUAGE, "status")}${t(env.BOT_LANGUAGE, "colon")}${statusLabel(row.status, env.BOT_LANGUAGE)}`,
      `${t(env.BOT_LANGUAGE, "system")}${t(env.BOT_LANGUAGE, "colon")}${escapeHtml(device.os || t(env.BOT_LANGUAGE, "unknown"))}`,
      `${t(env.BOT_LANGUAGE, "lastSeen")}${t(env.BOT_LANGUAGE, "colon")}${formatTailscaleTime(device.lastSeen, env.TIME_ZONE, env.BOT_LANGUAGE)}`,
      `${t(env.BOT_LANGUAGE, "apiSync")}${t(env.BOT_LANGUAGE, "colon")}${formatAge(row.last_checked_at, undefined, env.BOT_LANGUAGE)}`,
      warning ? `\n⚠️ ${t(env.BOT_LANGUAGE, "syncFailed")}` : ""
    ].filter(Boolean).join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: `🔄 ${t(env.BOT_LANGUAGE, "syncNow")}`, callback_data: `check:${row.id}:${page}` }],
      [{ text: t(env.BOT_LANGUAGE, "backList"), callback_data: `list:${page}` }, { text: t(env.BOT_LANGUAGE, "backOverview"), callback_data: "home" }]
    ] }
  };
}

async function getDeviceRow(env, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = await env.STATUS_DB.prepare(
    "SELECT * FROM servers WHERE id = ? AND ports = 'tailscale' AND enabled = 1"
  ).bind(id).first();
  return row;
}

async function visibilityFresh(env) {
  return Number((await readState(env.STATUS_DB, 'visibility')).until_at || 0) > nowSeconds();
}

function unavailableView(env) {
  return { text: t(env.BOT_LANGUAGE, "unavailable"), reply_markup: mainKeyboard(env) };
}

async function editOrSend(chatId, messageId, view, env) {
  if (messageId) {
    try {
      return await telegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, ...view });
    } catch (error) {
      if (String(error).includes("message is not modified")) return;
      if (error.telegramErrorCode !== 400 || !/message to edit not found|message can't be edited/i.test(error.message)) throw error;
    }
  }
  return telegram(env, "sendMessage", { chat_id: chatId, ...view });
}

async function telegram(env, method, payload) {
  await checkCooldown(env.STATUS_DB, 'telegram');
  const lease = await acquireLease(env.STATUS_DB, 'telegram-send', 30);
  if (!lease) throw Object.assign(new Error('Telegram 發送中，請稍後重試'), { telegramErrorCode: 429, retryAfter: 1 });
  try {
    await checkCooldown(env.STATUS_DB, 'telegram');
    const { response, data } = await requestJson(fetch, `${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }, `Telegram ${method}`, API_TIMEOUT_MS);
    if (!response.ok || !data?.ok) {
      const error = new Error(`Telegram ${method}: ${data?.description || response.status}`);
      error.telegramErrorCode = Number(data?.error_code || response.status);
      error.retryAfter = retrySeconds(data?.parameters?.retry_after ?? response.headers.get('retry-after'), 60);
      if (error.telegramErrorCode === 429) await setCooldown(env.STATUS_DB, 'telegram', error.retryAfter);
      throw error;
    }
    return data.result;
  } finally {
    await releaseLease(env.STATUS_DB, 'telegram-send', lease);
  }
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = [encoder.encode(String(left)), encoder.encode(String(right))];
  const key = await crypto.subtle.importKey("raw", encoder.encode("webhook-check"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [sa, sb] = await Promise.all([crypto.subtle.sign("HMAC", key, a), crypto.subtle.sign("HMAC", key, b)]);
  const va = new Uint8Array(sa); const vb = new Uint8Array(sb);
  let difference = va.length ^ vb.length;
  for (let index = 0; index < Math.max(va.length, vb.length); index += 1) difference |= (va[index] || 0) ^ (vb[index] || 0);
  return difference === 0;
}

function parseDevice(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object" ? parsed[0] : {};
  } catch { return {}; }
}

function formatTailscaleTime(value, timeZone, lang) {
  const seconds = Math.floor(Date.parse(String(value || "")) / 1000);
  return Number.isFinite(seconds) ? formatLocalTime(seconds, timeZone) : t(lang, "noTime");
}

function parseCommand(text) {
  const match = String(text || "").match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
  return match ? match[1].toLowerCase() : "";
}

function statusIcon(status) { return status === "up" ? "🟢" : status === "down" ? "🔴" : "⚪"; }
function statusLabel(status, lang) { return t(lang, status === "up" ? "online" : status === "down" ? "offline" : "pending"); }
function truncate(value, length) { const text = String(value || ""); return text.length > length ? `${text.slice(0, length - 1)}…` : text; }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function safeError(error) { return String(error?.message || error || "未知錯誤").replace(/[\r\n]+/g, " ").slice(0, 300); }
function json(value, init = {}) {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) } });
}
