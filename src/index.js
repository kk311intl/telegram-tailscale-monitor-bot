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
import { acquireLease, releaseLease, readState, checkCooldown, setCooldown, retrySeconds, requestJson, readBoundedText } from "./api-runtime.js";
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
let oauthCache = { clientId: "", token: "", expiresAt: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: env.HEALTH_SERVICE || "tailscale-server-monitor", monitor: "tailscale-api" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !/^[1-9]\d*$/.test(String(env.ADMIN_USER_ID || "")) || !Number.isSafeInteger(Number(env.ADMIN_USER_ID))) {
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
      const body = await readBoundedText(request.body, MAX_BODY_BYTES, request.signal);
      update = JSON.parse(body);
    } catch (error) {
      if (error instanceof RangeError && error.message === "Body size limit exceeded") return new Response("Payload too large", { status: 413 });
      return new Response("Bad request", { status: 400 });
    }
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return new Response("Bad request", { status: 400 });
    const sender = (update.callback_query || update.message)?.from;
    if (!sender || !Number.isSafeInteger(sender.id) || sender.id < 1 || sender.is_bot || String(sender.id) !== String(env.ADMIN_USER_ID)) return json({ ok: true });
    const updateContext = await claimUpdate(env.STATUS_DB, update.update_id);
    if (updateContext.state === "done") return json({ ok: true, duplicate: true });
    if (updateContext.state === "busy") {
      return json({ ok: false, retry: true }, { status: 503, headers: { "retry-after": "2" } });
    }
    try {
      await processUpdate(update, env, ctx);
      await completeUpdate(env.STATUS_DB, updateContext);
      return json({ ok: true });
    } catch (error) {
      console.error("Update processing failed", safeError(error));
      const code = Number(error.telegramErrorCode || 0);
      if (code >= 400 && code < 500 && code !== 429) {
        await completeUpdate(env.STATUS_DB, updateContext);
        return json({ ok: true });
      }
      await releaseUpdate(env.STATUS_DB, updateContext, error);
      return json({ ok: false, retry: true }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.SCHEDULER.getByName("monitor").fetch("https://scheduler/checks", {
      method: "POST", body: JSON.stringify({ scheduledTime: event.scheduledTime })
    }).then(response => {
      if (!response.ok) throw new Error(`Scheduled checks failed: HTTP ${response.status}`);
    }));
  }
};

export class StatusScheduler {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/notifications") {
      this.ctx.waitUntil(drainNotificationOutbox(this.env, 5));
      return json({ ok: true });
    }
    if (path !== "/checks") return new Response("Not found", { status: 404 });
    let event;
    try { event = await request.json(); }
    catch { return new Response("Bad request", { status: 400 }); }
    if (!Number.isSafeInteger(event?.scheduledTime) || event.scheduledTime < 0) {
      return new Response("Bad request", { status: 400 });
    }
    return json({ ok: true, ...(await runScheduledChecks(event, this.env)) });
  }
}

export async function processUpdate(update, env, ctx) {
  const work = { queued: false };
  if (update.callback_query) await processCallback(update.callback_query, env, work);
  else if (update.message) await processMessage(update.message, env, work);
  if (!work.queued) return;
  if (!ctx?.waitUntil) return drainNotificationOutbox(env, 5);
  ctx.waitUntil(env.SCHEDULER.getByName("monitor").fetch("https://scheduler/notifications", {
    method: "POST"
  }).then(response => {
    if (!response.ok) throw new Error(`Notification delivery failed: HTTP ${response.status}`);
  }));
}

async function processMessage(message, env, work) {
  if (!message?.from || message.from.is_bot || !Number.isSafeInteger(message.chat?.id) || message.chat.id === 0) return;
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
    chat_id: message.chat.id, ...(await refreshDashboard(env, 0, work))
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

async function processCallback(query, env, work) {
  if (typeof query?.id !== "string" || !query.id) return;
  const privateOwnerChat = query?.message?.chat?.type === "private" &&
    String(query.message.chat.id) === String(env.ADMIN_USER_ID);
  if (!query?.from || query.from.is_bot || String(query.from.id) !== String(env.ADMIN_USER_ID) || !privateOwnerChat) {
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
  if (action === "home" && rawId === "") return editOrSend(chatId, messageId, await dashboardView(env), env);
  // Keep refresh buttons in older messages working; new navigation uses plain "home".
  if (action === "refresh" || action === "home") return editOrSend(chatId, messageId, await refreshDashboard(env, Number(rawId || 0), work), env);
  if (action === "page") return editOrSend(chatId, messageId, await dashboardView(env, "", Number(rawId || 0)), env);
  if (action === "list") return editDeviceList(chatId, messageId, env, Number(rawId || 0));
  if (action === "detail") return editDeviceDetail(chatId, messageId, env, Number(rawId), Number(rawPage || 0));
  if (action === "check") {
    const id = Number(rawId);
    const warning = await syncWarning(env, work);
    return editDeviceDetail(chatId, messageId, env, id, Number(rawPage || 0), warning);
  }
}

export async function runScheduledChecks(event, env) {
  let sync;
  let syncError;
  try { sync = await syncTailscaleDevices(env, true); }
  catch (error) {
    if (["SYNC_BUSY", "API_COOLDOWN"].includes(error.code)) console.info("Tailscale sync skipped", error.code);
    else { syncError = error; console.error("Tailscale sync failed", safeError(error)); }
  }
  await drainNotificationOutbox(env, 5);
  if (sync) await refreshDeviceCountries(sync.devices, env);
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
        DELETE FROM auxiliary_alerts WHERE created_at < ?
      `).bind(scheduledSeconds - 90 * 86400)
    ]);
  }
  if (syncError) throw syncError;
  return { sync: sync ? "ok" : "skipped" };
}

export async function fetchTailscaleDevices(env, fetchImpl = fetch) {
  const token = await getTailscaleAccessToken(env, fetchImpl);
  const tailnet = encodeURIComponent(String(env.TAILSCALE_TAILNET || "-").trim() || "-");
  const { response, data } = await tailscaleJson(env, fetchImpl, `${TAILSCALE_API}/tailnet/${tailnet}/devices?fields=all`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" }
  }, "Tailscale Devices API");
  if (response.status === 401) oauthCache = { clientId: "", token: "", expiresAt: 0 };
  if (!response.ok) throw new Error(`Tailscale Devices API: HTTP ${response.status}`);
  if (!Array.isArray(data?.devices)) throw new Error("Tailscale Devices API: 回應格式無效");
  const devices = data.devices.map(normalizeTailscaleDevice);
  if (new Set(devices.map(device => device.id)).size !== devices.length) throw new Error("Tailscale Devices API: 設備 ID 重複");
  return devices;
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
    throw Object.assign(new Error(`${label}: HTTP 429`), { code: "API_COOLDOWN" });
  }
  return result;
}

export async function syncTailscaleDevices(env, notify) {
  const lease = await acquireLease(env.STATUS_DB, 'sync', 120);
  if (!lease) throw Object.assign(new Error('設備正在同步，請稍後更新'), { code: "SYNC_BUSY" });
  try {
  const fetchedDevices = await fetchTailscaleDevices(env);
  const checkedAt = nowSeconds();
  const syncToken = crypto.randomUUID();
  const existingQuery = await env.STATUS_DB.prepare(
    "SELECT * FROM servers WHERE ports = 'tailscale'"
  ).all();
  const existingById = new Map((existingQuery.results || []).map((row) => [String(row.host), row]));
  const previousSeen = parseLastSeenSnapshot((await readState(env.STATUS_DB, 'visibility')).token);
  const hiddenTags = new Set(String(env.HIDDEN_TAGS || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  const visibleDevices = fetchedDevices.filter((device) => !hasHiddenTag(device, hiddenTags));
  const devices = visibleDevices.map(device => env.GEOIP_ENABLED === "true"
    ? cachedDeviceCountry(device, parseDevice(existingById.get(device.id)?.last_results))
    : { ...device, country: "" });
  const visibleIds = new Set(devices.map(device => device.id));
  const statements = [];
  let queued = false;
  const fence = "EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())";
  for (const device of devices) {
    const existing = existingById.get(device.id);
    const saved = persistTailscaleDevice(device, checkedAt, syncToken, env, notify, existing, lease, previousSeen.get(device.id));
    statements.push(...saved.statements);
    queued ||= saved.queued;
  }
  for (const row of existingQuery.results || []) {
    if (Number(row.enabled) === 1 && !visibleIds.has(String(row.host))) {
      statements.push(env.STATUS_DB.prepare(`UPDATE servers SET enabled = 0, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND ports = 'tailscale' AND enabled = 1 AND ${fence}`)
      .bind(checkedAt, row.id, Number(row.revision || 0), lease));
    }
  }
  statements.push(env.STATUS_DB.prepare(`UPDATE notification_outbox SET failed_at = ?, last_error = 'device hidden'
    WHERE sent_at = 0 AND failed_at = 0 AND server_id IN (SELECT id FROM servers WHERE ports = 'tailscale' AND enabled = 0)
    AND ${fence}`).bind(checkedAt, lease));
  // A lost fence violates NOT NULL, aborting the whole batch instead of committing a partial snapshot.
  const lastSeenSnapshot = JSON.stringify(devices.map(device => [device.id, device.lastSeen]));
  statements.push(env.STATUS_DB.prepare(`INSERT INTO runtime_state(key, token, until_at)
    VALUES ('visibility', ?, CASE WHEN ${fence} THEN ? ELSE NULL END)
    ON CONFLICT(key) DO UPDATE SET token = excluded.token, until_at = excluded.until_at`)
    .bind(lastSeenSnapshot, lease, checkedAt + 120));
  let results;
  try { results = await env.STATUS_DB.batch(statements); }
  catch (error) {
    if (/NOT NULL constraint failed: runtime_state\.until_at/i.test(String(error.message))) throw new Error('同步已逾時，未套用設備資料');
    throw error;
  }
  if (Number(results.at(-1)?.meta?.changes) !== 1) throw new Error('同步已逾時，未套用設備資料');
  await env.STATUS_DB.prepare("UPDATE runtime_state SET failures = 0, until_at = 0 WHERE key = 'tailscale' AND (failures != 0 OR until_at != 0)").run();
  return { devices, queued };
  } finally { await releaseLease(env.STATUS_DB, 'sync', lease); }
}

function cachedDeviceCountry(device, previous) {
  const samePublicIp = Boolean(device.publicIp && device.publicIp === previous.publicIp);
  return { ...device,
    country: samePublicIp && /^[A-Z]{2}$/.test(String(previous.country || "").toUpperCase()) ? String(previous.country).toUpperCase() : "",
    countryCheckedAt: samePublicIp ? Number(previous.countryCheckedAt || 0) : 0,
    countryRetryAt: samePublicIp ? Number(previous.countryRetryAt || 0) : 0
  };
}

async function refreshDeviceCountries(devices, env) {
  if (env.GEOIP_ENABLED !== "true") return;
  const checkedAt = nowSeconds();
  const candidates = devices.filter(device => device.publicIp && checkedAt >= device.countryRetryAt &&
    (!device.country || checkedAt - device.countryCheckedAt >= GEOIP_CACHE_SECONDS)).slice(0, GEOIP_LOOKUPS_PER_SYNC);
  if (!candidates.length) return;
  const enriched = await enrichDeviceCountries(candidates, checkedAt);
  const lease = await acquireLease(env.STATUS_DB, 'sync', 30);
  if (!lease) return;
  try {
    await env.STATUS_DB.batch(enriched.map((device, index) => env.STATUS_DB.prepare(`
      UPDATE servers SET last_results = json_set(last_results,
        '$[0].country', ?, '$[0].countryCheckedAt', ?, '$[0].countryRetryAt', ?),
        revision = revision + 1, updated_at = ?
      WHERE host = ? AND ports = 'tailscale' AND enabled = 1
        AND json_extract(last_results, '$[0].publicIp') = ?
        AND COALESCE(json_extract(last_results, '$[0].countryCheckedAt'), 0) = ?
        AND COALESCE(json_extract(last_results, '$[0].countryRetryAt'), 0) = ?
        AND EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
    `).bind(device.country, device.countryCheckedAt, device.countryRetryAt, checkedAt, device.id,
      device.publicIp, candidates[index].countryCheckedAt, candidates[index].countryRetryAt, lease)));
  } finally { await releaseLease(env.STATUS_DB, 'sync', lease); }
}

async function enrichDeviceCountries(devices, checkedAt, fetchImpl = fetch) {
  const enriched = devices.map(device => ({ ...device }));
  await Promise.all(enriched.map(async (device) => {
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

function persistTailscaleDevice(device, checkedAt, syncToken, env, notify, existing, lease, previousLastSeen) {
  const base = existing && Number(existing.enabled) === 1 ? existing : { status: "unknown" };
  const previousDevice = parseDevice(existing?.last_results);
  if (previousLastSeen !== undefined) previousDevice.lastSeen = previousLastSeen;
  const offlineAfter = clampInteger(env.OFFLINE_AFTER, 2, 10, 2);
  const canCount = device.connectedToControl || !base.consecutive_failures || checkedAt - Number(previousDevice.observationAt || existing?.last_checked_at || 0) >= 60;
  const observation = canCount
    ? evaluateObservation(base, device.connectedToControl, offlineAfter)
    : { status: base.status, failures: base.consecutive_failures, successes: 0, event: null };
  observation.failures = Math.min(observation.failures, offlineAfter);
  observation.successes = Math.min(observation.successes, 1);
  device.observationAt = canCount ? checkedAt : Number(previousDevice.observationAt || existing?.last_checked_at || 0);
  const changedAt = observation.event ? checkedAt : Number(existing?.last_changed_at || 0);
  const eventLastSeen = observation.event === "recovered" ? previousDevice.lastSeen : device.lastSeen;
  const metadata = JSON.stringify([device]);
  if (existing && Number(existing.enabled) === 1 && existing.name === device.displayName &&
      existing.status === observation.status && !existing.last_error &&
      Number(existing.consecutive_failures || 0) === observation.failures &&
      Number(existing.consecutive_successes || 0) === observation.successes &&
      stableDeviceMetadata(previousDevice) === stableDeviceMetadata(device)) return { statements: [], queued: false };
  if (!existing) {
    return { queued: false, statements: [env.STATUS_DB.prepare(`
      INSERT INTO servers(
        name, host, ports, enabled, status, consecutive_failures, consecutive_successes,
        last_checked_at, last_changed_at, last_results, last_error,
        revision, last_check_token, created_at, updated_at
      ) SELECT ?, ?, 'tailscale', 1, ?, ?, ?, ?, 0, ?, '', 0, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
    `).bind(
      device.displayName, device.id, observation.status, observation.failures, observation.successes,
      checkedAt, metadata, syncToken, checkedAt, checkedAt, lease
    )] };
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
  return { statements, queued: Boolean(observation.event && notify && env.BOT_TOKEN && env.ADMIN_USER_ID) };
}

async function drainNotificationOutbox(env, limit) {
  if (!env.BOT_TOKEN || !env.ADMIN_USER_ID) return;
  let remaining = limit;
  while (remaining > 0) {
    if (!(await visibilityFresh(env))) return;
    const due = await env.STATUS_DB.prepare(`
    SELECT n.* FROM notification_outbox n
    JOIN servers s ON s.id = n.server_id
    WHERE s.ports = 'tailscale' AND s.enabled = 1 AND n.sent_at = 0 AND n.failed_at = 0
      AND n.next_attempt_at <= ? AND n.lease_until <= ?
      AND NOT EXISTS (SELECT 1 FROM notification_outbox earlier
        WHERE earlier.server_id = n.server_id AND earlier.id < n.id
          AND earlier.sent_at = 0 AND earlier.failed_at = 0)
    ORDER BY n.next_attempt_at ASC, n.id ASC LIMIT ?
    `).bind(nowSeconds(), nowSeconds(), remaining).all();
    let processed = false;
    for (const notification of due.results || []) {
      if (!(await visibilityFresh(env))) return;
      if ((await readState(env.STATUS_DB, 'telegram')).until_at > nowSeconds()) return;
      processed = await deliverNotification(notification, env) || processed;
      remaining--;
    }
    if (!processed) return;
  }
}

async function deliverNotification(notification, env) {
  const syncLease = await acquireLease(env.STATUS_DB, 'sync', 30);
  if (!syncLease) return false;
  try {
  if (!(await visibilityFresh(env))) return false;
  const leaseToken = crypto.randomUUID();
  const claimed = await env.STATUS_DB.prepare(`
    UPDATE notification_outbox SET lease_token = ?, lease_until = ?
    WHERE id = ? AND sent_at = 0 AND failed_at = 0 AND next_attempt_at <= ? AND lease_until <= ?
      AND server_id IN (SELECT id FROM servers WHERE ports = 'tailscale' AND enabled = 1)
      AND EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
  `).bind(leaseToken, nowSeconds() + 60, notification.id, nowSeconds(), nowSeconds(), syncLease).run();
  if (Number(claimed.meta?.changes || 0) !== 1) return false;
  try {
    const payload = JSON.parse(notification.payload);
    await sendStatusNotification(payload, env, syncLease);
    await markDeliverySent(env.STATUS_DB, 'notification_outbox', notification.id, leaseToken);
  } catch (error) {
    await recordDeliveryFailure(env.STATUS_DB, 'notification_outbox', notification, leaseToken, error);
    console.error("Status notification failed", safeError(error));
  }
  return true;
  } finally { await releaseLease(env.STATUS_DB, 'sync', syncLease); }
}

// Table names are fixed by delivery callers, never taken from a payload.
async function markDeliverySent(db, table, id, leaseToken) {
  await db.prepare(`UPDATE ${table} SET sent_at = ?, last_error = '', lease_token = '', lease_until = 0
    WHERE id = ? AND sent_at = 0 AND lease_token = ?`).bind(nowSeconds(), id, leaseToken).run();
}

async function recordDeliveryFailure(db, table, notification, leaseToken, error) {
  const plan = notificationFailurePlan(error, notification.attempts, nowSeconds());
  const field = plan.terminal ? 'failed_at' : 'next_attempt_at';
  const timestamp = plan.terminal ? nowSeconds() : plan.nextAttemptAt;
  await db.prepare(`UPDATE ${table} SET attempts = ?, ${field} = ?, last_error = ?, lease_token = '', lease_until = 0
    WHERE id = ? AND sent_at = 0 AND lease_token = ?`
  ).bind(plan.attempts, timestamp, safeError(error), notification.id, leaseToken).run();
}

async function sendStatusNotification(payload, env, visibilityLease) {
  if (!payload || !Number.isSafeInteger(payload.id) || payload.id < 1 || typeof payload.name !== "string" ||
      !payload.device || typeof payload.device !== "object" || Array.isArray(payload.device) ||
      !["down", "recovered"].includes(payload.event) || !Number.isSafeInteger(payload.eventTime) ||
      payload.eventTime < 0 || !Number.isFinite(new Date(payload.eventTime * 1000).getTime())) {
    throw new SyntaxError("Invalid status notification payload");
  }
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
  }, visibilityLease);
}


async function syncWarning(env, work) {
  try {
    const result = await syncTailscaleDevices(env, true);
    if (work) work.queued ||= result.queued;
    return "";
  } catch (error) {
    console.error("Tailscale sync failed", safeError(error));
    return safeError(error);
  }
}

async function refreshDashboard(env, page = 0, work) {
  const warning = await syncWarning(env, work);
  return dashboardView(env, warning, page);
}

async function dashboardView(env, warning = "", requestedPage = 0) {
  if (!(await visibilityFresh(env))) return unavailableView(env);
  const devices = await visibleDeviceRows(env);
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
      warning ? `\n⚠️ ${t(env.BOT_LANGUAGE, "syncFailed")}` : null,
      "",
      `<b>${t(env.BOT_LANGUAGE, "allDevices")}</b>${pages > 1 ? ` · ${page + 1}/${pages}` : ""}`,
      ...lines
    ].filter(line => line !== null).join("\n"),
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

async function visibleDeviceRows(env) {
  const query = await env.STATUS_DB.prepare("SELECT * FROM servers WHERE ports = 'tailscale' AND enabled = 1").all();
  return (query.results || []).sort(compareDeviceRows);
}

function pageNavigation(env, page, pages, action) {
  const buttons = [];
  if (page > 0) buttons.push({ text: t(env.BOT_LANGUAGE, "previous"), callback_data: `${action}:${page - 1}` });
  buttons.push({ text: `${page + 1}/${pages}`, callback_data: `${action}:${page}` });
  if (page + 1 < pages) buttons.push({ text: t(env.BOT_LANGUAGE, "next"), callback_data: `${action}:${page + 1}` });
  return buttons;
}

function mainKeyboard(env, page = 0, pages = 1) {
  const buttons = [[
    { text: `📋 ${t(env.BOT_LANGUAGE, "deviceList")}`, callback_data: "list:0" },
    { text: `🔄 ${t(env.BOT_LANGUAGE, "refresh")}`, callback_data: `refresh:${page}` }
  ]];
  if (pages > 1) buttons.push(pageNavigation(env, page, pages, 'page'));
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
  const allRows = await visibleDeviceRows(env);
  const total = allRows.length;
  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = Math.min(pages - 1, clampInteger(requestedPage, 0, Number.MAX_SAFE_INTEGER, 0));
  const rows = allRows.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
  const buttons = rows.map((row) => [{
    text: `${statusIcon(row.status)} ${truncate(deviceLabel(row.name, parseDevice(row.last_results), env), 33)}`,
    callback_data: `detail:${row.id}:${page}`
  }]);
  buttons.push(pageNavigation(env, page, pages, 'list'));
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
  page = clampInteger(page, 0, Number.MAX_SAFE_INTEGER, 0);
  if (!(await visibilityFresh(env))) return unavailableView(env);
  const row = await getDeviceRow(env, id);
  if (!row) return { text: t(env.BOT_LANGUAGE, "removed"), reply_markup: mainKeyboard(env) };
  if (Number(row.visibility_until || 0) <= nowSeconds()) return unavailableView(env);
  const device = parseDevice(row.last_results);
  const latestSeen = parseLastSeenSnapshot(row.visibility_snapshot);
  if (latestSeen.has(String(row.host))) device.lastSeen = latestSeen.get(String(row.host));
  const label = deviceLabel(row.name, device, env);
  return {
    text: [
      `${statusIcon(row.status)} <b>${escapeHtml(label)}</b>`,
      `${t(env.BOT_LANGUAGE, "status")}${t(env.BOT_LANGUAGE, "colon")}${statusLabel(row.status, env.BOT_LANGUAGE)}`,
      `${t(env.BOT_LANGUAGE, "system")}${t(env.BOT_LANGUAGE, "colon")}${escapeHtml(device.os || t(env.BOT_LANGUAGE, "unknown"))}`,
      `${t(env.BOT_LANGUAGE, "lastOnline")}${t(env.BOT_LANGUAGE, "colon")}${formatTailscaleTime(device.lastSeen, env.TIME_ZONE, env.BOT_LANGUAGE)}`,
      `${t(env.BOT_LANGUAGE, "apiSync")}${t(env.BOT_LANGUAGE, "colon")}${formatAge(Number(row.visibility_until || 0) - 120, undefined, env.BOT_LANGUAGE)}`,
      warning ? `\n⚠️ ${t(env.BOT_LANGUAGE, "syncFailed")}` : ""
    ].filter(Boolean).join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [
      [{ text: `🔄 ${t(env.BOT_LANGUAGE, "refresh")}`, callback_data: `check:${row.id}:${page}` }],
      [{ text: t(env.BOT_LANGUAGE, "backList"), callback_data: `list:${page}` }, { text: t(env.BOT_LANGUAGE, "backOverview"), callback_data: "home" }]
    ] }
  };
}

async function getDeviceRow(env, id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = await env.STATUS_DB.prepare(
    `SELECT servers.*,
      (SELECT token FROM runtime_state WHERE key = 'visibility') AS visibility_snapshot,
      (SELECT until_at FROM runtime_state WHERE key = 'visibility') AS visibility_until
      FROM servers WHERE id = ? AND ports = 'tailscale' AND enabled = 1`
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

async function telegram(env, method, payload, visibilityLease = '') {
  await checkCooldown(env.STATUS_DB, 'telegram');
  const lease = await acquireLease(env.STATUS_DB, 'telegram-send', 30);
  if (!lease) throw Object.assign(new Error('Telegram 發送中，請稍後重試'), { telegramErrorCode: 429, retryAfter: 1 });
  try {
    await checkCooldown(env.STATUS_DB, 'telegram');
    const renewed = await env.STATUS_DB.prepare(`UPDATE runtime_state SET until_at = unixepoch() + 30
      WHERE ((key = 'telegram-send' AND token = ?) OR (? != '' AND key = 'sync' AND token = ?))
        AND EXISTS (SELECT 1 FROM runtime_state WHERE key = 'telegram-send' AND token = ? AND until_at > unixepoch())
        AND (? = '' OR (EXISTS (SELECT 1 FROM runtime_state WHERE key = 'sync' AND token = ? AND until_at > unixepoch())
          AND EXISTS (SELECT 1 FROM runtime_state WHERE key = 'visibility' AND until_at > unixepoch())))
        AND NOT EXISTS (SELECT 1 FROM runtime_state WHERE key = 'telegram' AND until_at > unixepoch())`
    ).bind(lease, visibilityLease, visibilityLease, lease, visibilityLease, visibilityLease).run();
    if (Number(renewed.meta?.changes || 0) !== (visibilityLease ? 2 : 1)) {
      throw Object.assign(new Error('Telegram or notification visibility lease expired'), { telegramErrorCode: 429, retryAfter: 1 });
    }
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

function stableDeviceMetadata(device) {
  const { lastSeen, observationAt, ...metadata } = device;
  return JSON.stringify(metadata);
}

function parseLastSeenSnapshot(value) {
  try { return new Map(JSON.parse(value || '[]')); }
  catch { return new Map(); }
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
function truncate(value, length) { const characters = Array.from(String(value || "")); return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : characters.join(""); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function safeError(error) { return String(error?.message || error || "未知錯誤").replace(/[\r\n]+/g, " ").slice(0, 300); }
function json(value, init = {}) {
  return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) } });
}
