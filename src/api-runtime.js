export const nowSeconds = () => Math.floor(Date.now() / 1000);
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function readBoundedText(stream, maximum, signal) {
  if (!stream) return "";
  const reader = stream.getReader();
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) { cancel(); throw new RangeError("Body size limit exceeded"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function readState(db, key) {
  return await db.prepare('SELECT * FROM runtime_state WHERE key = ?').bind(key).first() || {};
}

export async function acquireLease(db, key, seconds) {
  const token = crypto.randomUUID();
  const now = nowSeconds();
  const result = await db.prepare(`
    INSERT INTO runtime_state(key, token, until_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET token = excluded.token, until_at = excluded.until_at
    WHERE runtime_state.until_at <= ?
  `).bind(key, token, now + seconds, now).run();
  return Number(result.meta?.changes) === 1 ? token : '';
}

export async function releaseLease(db, key, token) {
  await db.prepare("UPDATE runtime_state SET token = '', until_at = 0 WHERE key = ? AND token = ?")
    .bind(key, token).run();
}

export function retrySeconds(value, fallback, now = nowSeconds()) {
  if (value != null && String(value).trim() !== '') {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(1, Math.ceil(date / 1000 - now));
  }
  return fallback;
}

export async function checkCooldown(db, key) {
  if (!db) return;
  const state = await readState(db, key);
  if (state.until_at > nowSeconds()) {
    const error = new Error(`${key}: 冷卻中，請稍後重試`);
    error.retryAfter = state.until_at - nowSeconds();
    error.telegramErrorCode = key === 'telegram' ? 429 : undefined;
    throw error;
  }
}

export async function setCooldown(db, key, seconds) {
  if (!db) return;
  await db.prepare(`INSERT INTO runtime_state(key, until_at, failures) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET until_at = MAX(runtime_state.until_at, excluded.until_at),
    failures = runtime_state.failures + 1`).bind(key, nowSeconds() + seconds).run();
}

// Deadline includes headers and the entire JSON body, even if a fetch implementation ignores abort.
export async function requestJson(fetchImpl, url, init, label, timeoutMs = 10000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
        let data;
        if (response.body) {
          const text = await readBoundedText(response.body, MAX_JSON_RESPONSE_BYTES, controller.signal);
          try { data = JSON.parse(text); } catch { data = null; }
        } else {
          data = await response.json().catch(() => null);
        }
        return { response, data };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`${label}: 請求逾時`)); }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${label}: 請求逾時`);
    if (error instanceof RangeError && error.message === "Body size limit exceeded") throw new Error(`${label}: 回應過大`);
    throw new Error(`${label}: 連線或回應格式錯誤`);
  } finally { clearTimeout(timer); }
}
