import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

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
