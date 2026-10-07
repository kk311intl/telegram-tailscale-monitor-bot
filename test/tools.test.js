import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('webhook registration validates the HTTPS origin before asking for secrets', t => {
  const available = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
  assert.ifError(available.error);
  assert.equal(available.status, 0, available.stderr);
  const quote = text => "'" + text.replace(/'/g, "''") + "'";
  const path = fileURLToPath(new URL('../tools/Register-TelegramWebhook.ps1', import.meta.url));
  // Execute only the actual parameter block: no prompts, credentials or network calls.
  const script = `$ErrorActionPreference='Stop'; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path)},[ref]$null,[ref]$null); $validate=[scriptblock]::Create($ast.ParamBlock.Extent.Text + '; $WorkerUrl'); `;
  const urls = ['https://worker.example', 'https://worker.example/'];
  const invalid = ['http://worker.example', 'https://user:secret@worker.example', 'https://worker.example/webhook', 'https://worker.example?token=fake', 'https://worker.example#fragment'];
  const checks = urls.map(url => `if ((& $validate -WorkerUrl ${quote(url)}) -ne ${quote(url)}) { throw 'Valid origin rejected' }`).concat(invalid.map(url => `try { & $validate -WorkerUrl ${quote(url)}; throw 'Invalid origin accepted' } catch { if ($_.Exception.Message -notlike '*WorkerUrl must be an HTTPS root URL*') { throw } }`));
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script + checks.join('; ') + '; exit 0'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
