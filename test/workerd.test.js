import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

test('API body reader and redirect guard work in the native Workers runtime', async () => {
  const require = createRequire(import.meta.url);
  const dependencies = [require.resolve('wrangler/package.json')];
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(require.resolve('miniflare', { paths: dependencies })));
  const runtime = readFileSync(new URL('../src/api-runtime.js', import.meta.url), 'utf8');
  const worker = `import {readBoundedText, requestJson} from './api-runtime.js';
    export default { async fetch() {
      let stage = 'reader';
      try {
        const text = await readBoundedText(new Response('中文🟢').body, 100);
        stage = 'request-json';
        const {data} = await requestJson(fetch, 'https://test.invalid/', {}, 'test');
        stage = 'redirect';
        let blocked = false;
        try { await requestJson(fetch, 'https://test.invalid/redirect', {}, 'test'); }
        catch { blocked = true; }
        return Response.json({text, data, blocked});
      } catch (error) { return Response.json({stage, error: error.message}, {status:500}); }
    } };`;
  const destinations = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    compatibilityDate: '2026-09-01',
    modules: [
      { type: 'ESModule', path: fileURLToPath(new URL('../src/native-test.js', import.meta.url)), contents: worker },
      { type: 'ESModule', path: fileURLToPath(new URL('../src/api-runtime.js', import.meta.url)), contents: runtime }
    ],
    outboundService: request => {
      destinations.push(request.url);
      return new URL(request.url).pathname === '/redirect'
        ? new Response(null, {status:302, headers:{location:'https://other.invalid/'}})
        : new Response(JSON.stringify({ ok: true }));
    }
  }));
  try {
    const result = await mf.dispatchFetch('https://worker.invalid/');
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { text: '中文🟢', data: { ok: true }, blocked: true });
    assert.deepEqual(destinations, ['https://test.invalid/', 'https://test.invalid/redirect']);
  } finally { await mf.dispose(); }
});

test('native D1 preserves offline and recovery notifications after stable polls skip device writes', async () => {
  const require = createRequire(import.meta.url);
  const dependencies = [require.resolve('wrangler/package.json')];
  const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(require.resolve('miniflare', { paths: dependencies })));
  const modules = ['index.js', 'helpers.js', 'i18n.js', 'update-lifecycle.js', 'api-runtime.js'].map(file => ({
    type: 'ESModule',
    path: fileURLToPath(new URL('../src/' + file, import.meta.url)),
    contents: readFileSync(new URL('../src/' + file, import.meta.url), 'utf8') +
      (file === 'index.js' ? '\nexport {drainNotificationOutbox};' : '')
  }));
  const worker = `import {syncTailscaleDevices, drainNotificationOutbox} from './index.js';
    let clock = Date.now();
    Date.now = () => clock;
    export default { async fetch(request, env) {
      clock = (await request.json()).now * 1000;
      await syncTailscaleDevices(env, true);
      await drainNotificationOutbox(env, 5);
      return Response.json({ok:true});
    } };`;
  const device = { id: 'native-test', name: 'test.example.ts.net', connectedToControl: true, tags: [] };
  const sent = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    compatibilityDate: '2026-09-01',
    modules: [{ type: 'ESModule', path: fileURLToPath(new URL('../src/native-status-test.js', import.meta.url)), contents: worker }, ...modules],
    d1Databases: { STATUS_DB: 'native-status-test' },
    bindings: { BOT_TOKEN: 'fake', ADMIN_USER_ID: '1', TAILSCALE_CLIENT_ID: 'native-test', TAILSCALE_CLIENT_SECRET: 'fake', OFFLINE_AFTER: '2' },
    outboundService: async request => {
      if (request.url.endsWith('/oauth/token')) return Response.json({ access_token: 'mock', expires_in: 3600 });
      if (request.url.includes('/devices?')) return Response.json({ devices: [device] });
      assert.ok(request.url.startsWith('https://api.telegram.org/botfake/sendMessage'));
      sent.push(await request.json());
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
  }));
  try {
    const db = await mf.getD1Database('STATUS_DB');
    for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()) {
      const statements = readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8')
        .split(';').map(sql => sql.trim()).filter(Boolean);
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const start = Math.floor(Date.now() / 1000) + 60;
    const poll = async seconds => {
      const result = await mf.dispatchFetch('https://worker.invalid/', {
        method: 'POST', body: JSON.stringify({ now: start + seconds })
      });
      assert.equal(result.status, 200, await result.text());
    };
    await poll(0);
    const original = await db.prepare('SELECT * FROM servers').first();
    for (let minute = 1; minute <= 5; minute++) {
      device.lastSeen = new Date((start + minute * 60) * 1000).toISOString();
      await poll(minute * 60);
      assert.deepEqual(await db.prepare('SELECT * FROM servers').first(), original);
    }
    device.connectedToControl = false;
    await poll(360);
    await poll(419);
    assert.equal((await db.prepare('SELECT consecutive_failures FROM servers').first()).consecutive_failures, 1);
    assert.equal(sent.length, 0);
    await poll(420);
    assert.equal((await db.prepare('SELECT status FROM servers').first()).status, 'down');
    assert.equal(sent.length, 1);
    const down = await db.prepare('SELECT * FROM servers').first();
    await poll(480);
    assert.deepEqual(await db.prepare('SELECT * FROM servers').first(), down);
    device.connectedToControl = true;
    await poll(481);
    await poll(541);
    assert.equal((await db.prepare('SELECT status FROM servers').first()).status, 'up');
    const events = await db.prepare('SELECT event FROM status_events ORDER BY id').all();
    const notifications = await db.prepare('SELECT event,sent_at,failed_at FROM notification_outbox ORDER BY id').all();
    assert.deepEqual(events.results.map(row => row.event), ['down', 'recovered']);
    assert.deepEqual(notifications.results.map(row => row.event), ['down', 'recovered']);
    assert.ok(notifications.results.every(row => row.sent_at > 0 && row.failed_at === 0));
    assert.equal(sent.length, 2);
    assert.match(sent[0].text, /設備離線/);
    assert.match(sent[1].text, /設備恢復/);
  } finally { await mf.dispose(); }
});
