import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { requestJson, retrySeconds } from '../src/api-runtime.js';
import { normalizeTailscaleDevice, hasHiddenTag, extractPublicEndpoint } from '../src/helpers.js';

let source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
for (const file of ['helpers.js', 'i18n.js', 'update-lifecycle.js', 'api-runtime.js']) {
  source = source.replace(JSON.stringify('./' + file), JSON.stringify(new URL('../src/' + file, import.meta.url).href));
}
source += '\nexport {editOrSend, enrichDeviceCountries, dashboardView, deviceListView, deviceDetailView, drainNotificationOutbox, sendStatusNotification, updateSyncHealth, drainAuxiliaryAlerts};';
const app = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const now = () => Math.floor(Date.now() / 1000);
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

function setup(t) {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) db.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; db.close(); });
  const adapter = {
    prepare(sql) { return {
      values: [], bind(...values) { this.values = values; return this; },
      async all() { return { results: db.prepare(sql).all(...this.values) }; },
      async first() { return db.prepare(sql).get(...this.values); },
      execute() { return { meta: db.prepare(sql).run(...this.values) }; },
      async run() { return this.execute(); }
    }; },
    async batch(statements) {
      db.exec('BEGIN');
      try { const result = statements.map(s => s.execute()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { STATUS_DB: adapter, TAILSCALE_CLIENT_ID: crypto.randomUUID(), TAILSCALE_CLIENT_SECRET: 'fake', BOT_TOKEN: 'fake', ADMIN_USER_ID: '1' };
  const devices = [{ id: 'n1', name: 'node.example.ts.net', connectedToControl: true, tags: [] }];
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/oauth/token')) return response({ access_token: 'mock', expires_in: 3600 });
    if (String(url).includes('/devices?')) return response({ devices });
    return response({ ok: true, result: true });
  };
  return { db, env, devices, calls };
}

test('concurrent sync cannot hide valid devices', async t => {
  const { db, env } = setup(t);
  const results = await Promise.allSettled([app.syncTailscaleDevices(env, false), app.syncTailscaleDevices(env, false)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(db.prepare('SELECT enabled FROM servers').get().enabled, 1);
  await app.syncTailscaleDevices(env, false);
  assert.equal(db.prepare('SELECT enabled FROM servers').get().enabled, 1);
});

test('Cron delegates to its private scheduler and surfaces failed execution', async t => {
  const { env, calls } = setup(t);
  const scheduledTime = Date.now();
  let pending;
  let forwarded;
  let status = 200;
  env.SCHEDULER = { getByName(name) {
    assert.equal(name, 'monitor');
    return { async fetch(url, init) {
      forwarded = JSON.parse(init.body);
      return response({ ok: status === 200 }, status);
    } };
  } };
  const ctx = { waitUntil(promise) { pending = promise; } };
  await app.default.scheduled({ scheduledTime }, env, ctx);
  await pending;
  assert.deepEqual(forwarded, { scheduledTime });
  assert.equal(calls.length, 0);
  status = 500;
  await app.default.scheduled({ scheduledTime }, env, ctx);
  await assert.rejects(pending, /Scheduled checks failed: HTTP 500/);
});

test('private scheduler validates requests and drains the original D1 notification queue', async t => {
  const { db, env, calls } = setup(t);
  const scheduler = new app.StatusScheduler({}, env);
  for (const body of ['null', '{}', 'not-json', '{"scheduledTime":-1}']) {
    assert.equal((await scheduler.fetch(new Request('https://scheduler/checks', { method: 'POST', body }))).status, 400);
  }
  assert.equal((await scheduler.fetch(new Request('https://scheduler/checks'))).status, 405);
  assert.equal(calls.length, 0);
  assert.equal((await app.default.fetch(new Request('https://public.example/checks', { method: 'POST', body: '{}' }), env)).status, 404);
  await app.syncTailscaleDevices(env, false);
  db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'scheduler','down',?,1)").run(JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  const result = await scheduler.fetch(new Request('https://scheduler/checks', { method: 'POST', body: JSON.stringify({ scheduledTime: Date.now() }) }));
  assert.equal(result.status, 200);
  assert.equal(db.prepare("SELECT sent_at FROM notification_outbox WHERE check_token='scheduler'").get().sent_at > 0, true);
});

test('message and button refresh render the same dashboard', async t => {
  const { env } = setup(t);
  const fetchImpl = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      sent.push({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) });
    }
    return fetchImpl(url, init);
  };
  await app.processUpdate({ message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/status' } }, env);
  await app.processUpdate({ callback_query: {
    id: 'query', from: { id: 1 }, data: 'home',
    message: { chat: { id: 1, type: 'private' }, message_id: 10 }
  } }, env);
  assert.equal(sent.find(call => call.method === 'sendMessage').body.text,
    sent.find(call => call.method === 'editMessageText').body.text);
});

test('dashboard shows ten devices per page and keeps refresh on the selected page', async t => {
  const { env, devices, calls } = setup(t);
  devices.splice(0, devices.length, ...Array.from({ length: 120 }, (_, index) => ({
    id: `n${index + 1}`, name: `node${String(index + 1).padStart(3, '0')}-${'x'.repeat(24)}.example.ts.net`,
    connectedToControl: true, tags: []
  })));
  await app.syncTailscaleDevices(env, false);
  const first = await app.dashboardView(env);
  const second = await app.dashboardView(env, '', 1);
  assert.match(first.text, /node001/);
  assert.doesNotMatch(first.text, /node011/);
  assert.match(second.text, /node011/);
  assert.doesNotMatch(second.text, /node001/);
  assert.match(first.text, /node010/);
  assert.doesNotMatch(second.text, /node021/);
  assert.equal(first.reply_markup.inline_keyboard[1].at(-1).callback_data, 'page:1');
  assert.equal(second.reply_markup.inline_keyboard[0][1].callback_data, 'home:1');
  for (let page = 0; page < 12; page++) assert.ok((await app.dashboardView(env, '', page)).text.length < 4096);

  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) sent.push({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) });
    return originalFetch(url, init);
  };
  const apiCallsBeforePaging = calls.filter(url => url.includes('/devices?')).length;
  await app.processUpdate({ callback_query: {
    id: 'next-page', from: { id: 1 }, data: 'page:1',
    message: { chat: { id: 1, type: 'private' }, message_id: 10 }
  } }, env);
  assert.equal(sent.find(call => call.method === 'editMessageText').body.text, second.text);
  assert.equal(calls.filter(url => url.includes('/devices?')).length, apiCallsBeforePaging);
  await app.processUpdate({ callback_query: {
    id: 'refresh-page', from: { id: 1 }, data: 'home:1',
    message: { chat: { id: 1, type: 'private' }, message_id: 10 }
  } }, env);
  assert.equal(sent.filter(call => call.method === 'editMessageText').at(-1).body.text, second.text);
  assert.equal(calls.filter(url => url.includes('/devices?')).length, apiCallsBeforePaging + 1);
});

test('messages and callbacks reject other owners and non-owner chats', async t => {
  const { env, calls } = setup(t);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) sent.push({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) });
    return originalFetch(url, init);
  };
  await app.processUpdate({ message: { from: { id: 2 }, chat: { id: 2, type: 'private' }, text: '/status' } }, env);
  await app.processUpdate({ message: { from: { id: 1 }, chat: { id: 2, type: 'private' }, text: '/status' } }, env);
  assert.equal(sent.length, 0);
  await app.processUpdate({ message: { from: { id: 1 }, chat: { id: -100, type: 'supergroup' }, text: '/status' } }, env);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /私聊/);
  for (const [from, chat] of [[2, { id: 1, type: 'private' }], [1, { id: 1, type: 'supergroup' }], [1, { id: 2, type: 'private' }]]) {
    await app.processUpdate({ callback_query: { id: `denied-${sent.length}`, from: { id: from }, data: 'home', message: { chat, message_id: 10 } } }, env);
  }
  assert.equal(sent.length, 4);
  assert.ok(sent.slice(1).every(call => call.method === 'answerCallbackQuery' && call.body.show_alert === true));
  assert.equal(calls.filter(url => url.includes('/devices?')).length, 0);
});

test('stale sync alerts once and sends recovery only after an alert was delivered', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, true);
  db.prepare("UPDATE runtime_state SET until_at = ? WHERE key = 'visibility'").run(now() - 181);
  await app.updateSyncHealth(env);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'sync_lost'").get().n, 1);
  await app.updateSyncHealth(env);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'sync_lost'").get().n, 1);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.ok(db.prepare("SELECT sent_at FROM auxiliary_alerts WHERE kind = 'sync_lost'").get().sent_at > 0);
  await app.syncTailscaleDevices(env, true);
  await app.updateSyncHealth(env);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.ok(db.prepare("SELECT sent_at FROM auxiliary_alerts WHERE kind = 'sync_restored'").get().sent_at > 0);
});

test('sync recovery cancels a lost alert that was never delivered', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, true);
  db.prepare("UPDATE runtime_state SET until_at = ? WHERE key = 'visibility'").run(now() - 181);
  await app.updateSyncHealth(env);
  await app.syncTailscaleDevices(env, true);
  await app.updateSyncHealth(env);
  assert.ok(db.prepare("SELECT failed_at FROM auxiliary_alerts WHERE kind = 'sync_lost'").get().failed_at > 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'sync_restored'").get().n, 0);
});

test('inventory alerts ignore first sync and hidden tags, then report visible changes', async t => {
  const { db, env, devices } = setup(t);
  env.HIDDEN_TAGS = 'tag:personal';
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auxiliary_alerts').get().n, 0);
  devices.push({ id: 'n2', name: 'new.example.ts.net', connectedToControl: true, tags: [] });
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'device_added'").get().n, 1);
  devices[1].tags = ['tag:personal'];
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'device_removed'").get().n, 0);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.ok(db.prepare("SELECT failed_at FROM auxiliary_alerts WHERE kind = 'device_added'").get().failed_at > 0);
  devices[1].tags = [];
  await app.syncTailscaleDevices(env, true);
  devices.pop();
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'device_removed'").get().n, 1);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.ok(db.prepare("SELECT sent_at FROM auxiliary_alerts WHERE kind = 'device_removed'").get().sent_at > 0);
});

test('key expiry alert is deduplicated and cancelled if the key is renewed', async t => {
  const { db, env, devices } = setup(t);
  devices[0].expires = new Date((now() + 3 * 86400) * 1000).toISOString();
  await app.syncTailscaleDevices(env, true);
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auxiliary_alerts WHERE kind = 'key_expiring'").get().n, 1);
  devices[0].expires = new Date((now() + 30 * 86400) * 1000).toISOString();
  await app.syncTailscaleDevices(env, true);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.ok(db.prepare("SELECT failed_at FROM auxiliary_alerts WHERE kind = 'key_expiring'").get().failed_at > 0);
});

test('auxiliary alerts respect Telegram retry-after without duplicate delivery', async t => {
  const { db, env, devices } = setup(t);
  await app.syncTailscaleDevices(env, true);
  devices.push({ id: 'n2', name: 'second.example.ts.net', connectedToControl: true, tags: [] });
  await app.syncTailscaleDevices(env, true);
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      sends++;
      if (sends === 1) return response({ ok: false, error_code: 429, parameters: { retry_after: 17 } }, 429);
    }
    return originalFetch(url, init);
  };
  await app.drainAuxiliaryAlerts(env, 5);
  const row = db.prepare("SELECT attempts, sent_at, next_attempt_at FROM auxiliary_alerts WHERE kind = 'device_added'").get();
  assert.equal(row.attempts, 1);
  assert.equal(row.sent_at, 0);
  assert.ok(row.next_attempt_at >= now() + 16);
  await app.drainAuxiliaryAlerts(env, 5);
  assert.equal(sends, 1);
});

test('expired sync lease is fenced even if a new worker acquired it', async t => {
  const { db, env } = setup(t);
  const fetchImpl = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const result = await fetchImpl(url, init);
    if (String(url).includes('/devices?')) db.exec("UPDATE runtime_state SET token = 'new-worker' WHERE key = 'sync'");
    return result;
  };
  await assert.rejects(app.syncTailscaleDevices(env, false), /同步已逾時/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM servers').get().n, 0);
  assert.equal(db.prepare("SELECT token FROM runtime_state WHERE key = 'sync'").get().token, 'new-worker');
});

test('rapid refresh does not count another offline observation; recovery event retains previous lastSeen', async t => {
  const { db, env, devices } = setup(t);
  await app.syncTailscaleDevices(env, true);
  devices[0].connectedToControl = false;
  devices[0].lastSeen = '2026-09-01T00:00:00Z';
  await app.syncTailscaleDevices(env, true);
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare('SELECT consecutive_failures FROM servers').get().consecutive_failures, 1);
  db.exec(`UPDATE servers SET last_results = json_set(last_results, '$[0].observationAt', ${now() - 61})`);
  await app.syncTailscaleDevices(env, true);
  assert.equal(db.prepare('SELECT status FROM servers').get().status, 'down');
  devices[0].connectedToControl = true;
  devices[0].lastSeen = '2026-09-02T00:00:00Z';
  await app.syncTailscaleDevices(env, true);
  const payload = JSON.parse(db.prepare("SELECT payload FROM notification_outbox WHERE event = 'recovered'").get().payload);
  assert.equal(db.prepare("SELECT detail FROM status_events WHERE event = 'recovered'").get().detail, '2026-09-01T00:00:00Z');
  assert.equal(Object.hasOwn(payload, 'previousLastSeen'), false);
});

test('personal tag after 32 entries hides device and cancels unsent notifications atomically', async t => {
  const { db, env, devices } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.exec("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'q','down','{}',1)");
  devices[0].tags = [...Array.from({ length: 32 }, (_, i) => 'tag:t' + i), 'tag:personal'];
  env.HIDDEN_TAGS = ' tag:personal ';
  assert.ok(hasHiddenTag(normalizeTailscaleDevice(devices[0]), new Set(['tag:personal'])));
  await app.syncTailscaleDevices(env, false);
  assert.equal(db.prepare('SELECT enabled FROM servers').get().enabled, 0);
  assert.ok(db.prepare('SELECT failed_at FROM notification_outbox').get().failed_at > 0);
  assert.match((await app.deviceDetailView(env, 1, 0)).text, /已移除或隱藏/);
});

test('GeoIP is opt-in and the title is escaped', async t => {
  const { db, env, devices, calls } = setup(t);
  devices[0].clientConnectivity = { endpoints: ['8.8.8.8:41641'] };
  env.BOT_TITLE = '<My & Bot>';
  await app.syncTailscaleDevices(env, false);
  assert.equal(calls.filter(url => url.includes('country.is')).length, 0);
  assert.equal(JSON.parse(db.prepare('SELECT last_results FROM servers').get().last_results)[0].country, '');
  assert.match((await app.dashboardView(env)).text, /&lt;My &amp; Bot&gt;/);
  env.GEOIP_ENABLED = 'true';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('country.is')
    ? response({ country: 'JP' })
    : previousFetch(url, init);
  await app.syncTailscaleDevices(env, false);
  assert.equal(JSON.parse(db.prepare('SELECT last_results FROM servers').get().last_results)[0].country, 'JP');
  env.GEOIP_ENABLED = 'false';
  await app.syncTailscaleDevices(env, false);
  assert.equal(JSON.parse(db.prepare('SELECT last_results FROM servers').get().last_results)[0].country, '');
});

test('429 edit does not send a fallback message and cooldown is shared', async t => {
  const { env, calls } = setup(t);
  globalThis.fetch = async url => { calls.push(String(url)); return response({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, 429); };
  await assert.rejects(app.editOrSend(1, 1, { text: 'test' }, env));
  await assert.rejects(app.editOrSend(1, 1, { text: 'test' }, env));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/editMessageText'));
});

test('Tailscale 429 persists Retry-After and blocks repeated manual refresh', async t => {
  const { env, calls, db } = setup(t);
  globalThis.fetch = async url => { calls.push(String(url)); return response({}, 429, { 'retry-after': '180' }); };
  await assert.rejects(app.syncTailscaleDevices(env, false));
  await assert.rejects(app.syncTailscaleDevices(env, false));
  assert.equal(calls.length, 1);
  assert.ok(db.prepare("SELECT until_at FROM runtime_state WHERE key = 'tailscale'").get().until_at >= now() + 179);
  assert.equal(retrySeconds(new Date((now() + 120) * 1000).toUTCString(), 60), 120);
});

test('stalled response body respects deadline', async () => {
  await assert.rejects(requestJson(async () => ({ json: () => new Promise(() => {}) }), 'https://test.invalid', {}, 'test', 15), /請求逾時/);
});

test('stale GeoIP failure retries in six hours while keeping prior country', async () => {
  const checkedAt = now();
  const previous = { publicIp: '8.8.8.8', country: 'JP', countryCheckedAt: checkedAt - 8 * 86400 };
  const [device] = await app.enrichDeviceCountries([{ id: 'n', publicIp: previous.publicIp }], new Map([['n', { last_results: JSON.stringify([previous]) }]]), checkedAt, async () => response({}, 429));
  assert.equal(device.country, 'JP');
  assert.equal(device.countryCheckedAt, previous.countryCheckedAt);
  assert.equal(device.countryRetryAt, checkedAt + 6 * 3600);
});

test('private mapped IPv6 never becomes a GeoIP candidate', () => {
  for (const address of ['[::ffff:192.168.1.1]:41641', '[::ffff:127.0.0.1]:1', '[64:ff9b::c0a8:101]:1', '10.0.0.1:1']) assert.equal(extractPublicEndpoint([address]), '');
  assert.equal(extractPublicEndpoint(['[2606:4700:4700::1111]:1']), '2606:4700:4700::1111');
});

test('sync failure does not stop pending delivery with fresh visibility, stale visibility suppresses data', async t => {
  const { db, env, calls } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'q','down',?,1)").run(JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes('/devices?') ? response({}, 503) : originalFetch(url, init);
  await app.runScheduledChecks({}, env);
  assert.ok(db.prepare('SELECT sent_at FROM notification_outbox').get().sent_at > 0);
  db.exec("UPDATE runtime_state SET until_at = 1 WHERE key = 'visibility'");
  const view = await app.dashboardView(env);
  assert.match(view.text, /已過期/);
  assert.ok(!view.text.includes('node'));
});

test('scheduled status delivery runs before auxiliary work', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'priority','down',?,1)").run(JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  const prepare = env.STATUS_DB.prepare;
  let deliveredBeforeAuxiliary = false;
  env.STATUS_DB.prepare = sql => {
    if (sql.includes("INSERT OR IGNORE INTO runtime_state") && sql.includes("monitor-health")) {
      deliveredBeforeAuxiliary = db.prepare("SELECT sent_at FROM notification_outbox WHERE check_token='priority'").get().sent_at > 0;
    }
    return prepare(sql);
  };
  await app.runScheduledChecks({}, env);
  assert.equal(deliveredBeforeAuxiliary, true);
});

test('an interrupted delivery cannot block the next minute of device sync', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'bounded-lock','down',?,1)").run(JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  let remainingSyncLease = 0;
  globalThis.fetch = async () => {
    remainingSyncLease = db.prepare("SELECT until_at FROM runtime_state WHERE key='sync'").get().until_at - now();
    return response({ ok: true, result: true });
  };
  await app.drainNotificationOutbox(env, 5);
  assert.ok(remainingSyncLease >= 10 && remainingSyncLease < 60);
});

test('a replaced sync lease cannot claim or send a notification', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'fenced-delivery','down',?,1)").run(JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  const prepare = env.STATUS_DB.prepare;
  env.STATUS_DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('UPDATE notification_outbox SET lease_token')) {
      const run = statement.run;
      statement.run = async () => {
        db.prepare("UPDATE runtime_state SET token='replacement', until_at=? WHERE key='sync'").run(now() + 120);
        return run.call(statement);
      };
    }
    return statement;
  };
  let sends = 0;
  globalThis.fetch = async () => { sends++; return response({ ok: true }); };
  await app.drainNotificationOutbox(env, 5);
  assert.equal(sends, 0);
  assert.equal(db.prepare("SELECT lease_until FROM notification_outbox WHERE check_token='fenced-delivery'").get().lease_until, 0);
  assert.equal(db.prepare("SELECT token FROM runtime_state WHERE key='sync'").get().token, 'replacement');
});

test('invalid webhook secret is rejected before database access', async t => {
  const { env, db } = setup(t);
  env.WEBHOOK_SECRET = 'secret';
  const res = await app.default.fetch(new Request('https://test.invalid/webhook', { method: 'POST', body: '{}' }), env);
  assert.equal(res.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processed_updates').get().n, 0);
});

test('health service name can preserve a private deployment identity', async t => {
  const { env } = setup(t);
  const request = new Request('https://test.invalid/health');
  const generic = await app.default.fetch(request, env);
  assert.equal((await generic.json()).service, 'tailscale-server-monitor');
  env.HEALTH_SERVICE = 'telegram-server-status';
  const privateHealth = await app.default.fetch(request, env);
  assert.equal((await privateHealth.json()).service, 'telegram-server-status');
});

test('/start returns the valid cached dashboard without external sync or menu setup', async t => {
  const { env, calls } = setup(t);
  await app.syncTailscaleDevices(env, false);
  calls.length = 0;
  await app.processUpdate({
    message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/start' }
  }, env);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/sendMessage'));
});

test('deployment language controls views and scheduled notification text', async t => {
  const { env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  env.TIME_ZONE = 'UTC';
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return response({ ok: true, result: true });
  };
  for (const [lang, online, list, lastSeen, offline, recovered] of [
    ['zh', '在線', '設備列表', '最後上線', '最後在線', '恢復時間'],
    ['ja', 'オンライン', '端末一覧', '最終接続', '最終オンライン', '復旧時刻'],
    ['en', 'Online', 'Device list', 'Last seen online', 'Last online', 'Recovered at']
  ]) {
    env.BOT_LANGUAGE = lang;
    assert.match((await app.dashboardView(env)).text, new RegExp(online));
    assert.match((await app.deviceListView(env, 0)).text, new RegExp(list));
    assert.match((await app.deviceDetailView(env, 1, 0)).text, new RegExp(lastSeen));
    await app.sendStatusNotification({ id: 1, name: 'node', device: { lastSeen: '2026-09-01T00:00:00Z' }, event: 'down', eventTime: 1 }, env);
    assert.match(sent.at(-1).text, new RegExp(offline));
    assert.match(sent.at(-1).text, /2026-09-01 00:00:00 UTC\+0/);
    assert.doesNotMatch(sent.at(-1).text, /1970-01-01 00:00:01 UTC\+0/);
    await app.sendStatusNotification({ id: 1, name: 'node', device: {}, previousLastSeen: '2026-09-01T00:00:00Z', event: 'recovered', eventTime: 2 }, env);
    assert.match(sent.at(-1).text, new RegExp(recovered));
    assert.match(sent.at(-1).text, /1970-01-01 00:00:02 UTC\+0/);
    assert.doesNotMatch(sent.at(-1).text, new RegExp(lastSeen));
    assert.doesNotMatch(sent.at(-1).text, /2026-09-01 00:00:00 UTC\+0/);
  }
});

test('notification queue stops after a 429 and resumes only after cooldown', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  for (const token of ['a', 'b']) db.prepare("INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,?,'down',?,1)").run(token, JSON.stringify({ id: 1, name: 'node', device: {}, event: 'down', eventTime: 1 }));
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, 429); };
  await app.drainNotificationOutbox(env, 5);
  await app.drainNotificationOutbox(env, 5);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT SUM(attempts) AS n FROM notification_outbox').get().n, 1);
  db.exec("UPDATE runtime_state SET until_at = 0 WHERE key = 'telegram'; UPDATE notification_outbox SET next_attempt_at = 0");
  globalThis.fetch = async () => { calls++; return response({ ok: true, result: true }); };
  await app.drainNotificationOutbox(env, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE sent_at > 0').get().n, 2);
});

test('sync transaction failure rolls back all device and visibility changes', async t => {
  const { db, env, devices } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.exec("CREATE TRIGGER reject_new BEFORE INSERT ON servers WHEN NEW.host = 'bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  devices[0].connectedToControl = false;
  devices.push({ id: 'bad', name: 'bad', connectedToControl: true });
  await assert.rejects(app.syncTailscaleDevices(env, false), /test failure/);
  assert.equal(db.prepare('SELECT consecutive_failures FROM servers WHERE host = ?').get('n1').consecutive_failures, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM servers').get().n, 1);
});

test('expired visibility prevents notification delivery during upstream outage', async t => {
  const { db, env } = setup(t);
  await app.syncTailscaleDevices(env, false);
  db.exec("UPDATE runtime_state SET until_at = 0 WHERE key = 'visibility'; INSERT INTO notification_outbox(server_id,check_token,event,payload,created_at) VALUES (1,'old','down','{}',1)");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ ok: true }); };
  await app.drainNotificationOutbox(env, 5);
  assert.equal(calls, 0);
  assert.equal(db.prepare('SELECT attempts FROM notification_outbox').get().attempts, 0);
});
