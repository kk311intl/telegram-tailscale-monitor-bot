import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const quote = text => "'" + text.replace(/'/g, "''") + "'";
const publicScript = fileURLToPath(new URL('../tools/Register-TelegramWebhook.ps1', import.meta.url));

function runPowerShell(t, script) {
  const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; " + script + '; exit 0'], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') { t.skip('PowerShell 7 is not installed'); return; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

test('webhook registration validates the HTTPS origin before asking for secrets', t => {
  // Execute the actual validation prefix, stopping before secret prompts or network calls.
  const prefix = readFileSync(publicScript, 'utf8').split('$botTokenSecure =')[0]
    .replace('$projectRoot = Split-Path -Parent $PSScriptRoot', "$projectRoot = 'mock-project'");
  const script = `$validate=[scriptblock]::Create(${quote(prefix)} + '; $WorkerUrl'); function Test-Path { return $false }; `;
  const urls = ['https://worker.example', 'https://worker.example/'];
  const invalid = ['http://worker.example', 'https://user:secret@worker.example', 'https://worker.example/webhook', 'https://worker.example?token=fake', 'https://worker.example#fragment'];
  const checks = urls.map(url => `if ((& $validate -WorkerUrl ${quote(url)}) -ne ${quote(new URL(url).origin)}) { throw 'Valid origin rejected' }`).concat(invalid.map(url => `try { & $validate -WorkerUrl ${quote(url)}; throw 'Invalid origin accepted' } catch { if ($_.Exception.Message -notlike '*WorkerUrl*') { throw } }`));
  runPowerShell(t, script + checks.join('; '));
});

test('shared registration preserves prompts, language and payloads without reading real secrets or calling Telegram', t => {
  const privateScript = fileURLToPath(new URL('../personal/tools/Register-TelegramWebhook.ps1', import.meta.url));
  const script = `
    function Test-Path { param($LiteralPath) return $true }
    function Get-Content {
      param($LiteralPath, [switch]$Raw)
      if ($LiteralPath -like '*.dpapi') { return 'mock-encrypted-secret' }
      if ($LiteralPath -like '*wrangler.jsonc') { return (@{vars=@{BOT_LANGUAGE=$global:fixtureLanguage}} | ConvertTo-Json -Compress) }
      throw 'Unexpected file read'
    }
    function ConvertTo-SecureString {
      param($String)
      if ($String -ne 'mock-encrypted-secret') { throw 'Unexpected encrypted input' }
      return (Microsoft.PowerShell.Security\\ConvertTo-SecureString 'mock-webhook' -AsPlainText -Force)
    }
    function Read-Host {
      param($Prompt, [switch]$AsSecureString)
      $global:fixturePrompts++
      $global:fixturePromptTexts += $Prompt
      $value = if ($Prompt -like '*Bot Token*') { 'mock-bot' } else { 'mock-webhook' }
      return (Microsoft.PowerShell.Security\\ConvertTo-SecureString $value -AsPlainText -Force)
    }
    function Invoke-RestMethod {
      param($Method, $Uri, $ContentType, $Body)
      if ($global:fixtureFailure) { throw ('Transport error: ' + $Uri) }
      $global:fixtureCalls += @{method=$Uri.Split('/')[-1]; body=($Body | ConvertFrom-Json)}
      return @{ok=$true}
    }
    function Write-Host { param($Object) $global:fixtureOutput = $Object }
    function Check-Registration($path, $lang, $private) {
      $global:fixtureLanguage=$lang; $global:fixturePrompts=0; $global:fixtureCalls=@(); $global:fixturePromptTexts=@()
      & $path -WorkerUrl 'https://worker.example/'
      $expectedPrompts = if ($private) { 1 } else { 2 }
      if ($global:fixturePrompts -ne $expectedPrompts -or $global:fixtureCalls.Count -ne 3) { throw 'Registration flow changed' }
      $webhook=$global:fixtureCalls[0]; $commands=$global:fixtureCalls[1]; $menu=$global:fixtureCalls[2]
      if ($webhook.method -ne 'setWebhook' -or $webhook.body.url -ne 'https://worker.example/webhook' -or $webhook.body.secret_token -ne 'mock-webhook' -or $webhook.body.drop_pending_updates -or $webhook.body.max_connections -ne 10) { throw 'Webhook payload changed' }
      if (($webhook.body.allowed_updates -join ',') -ne 'message,callback_query' -or $commands.method -ne 'setMyCommands' -or $commands.body.scope.type -ne 'all_private_chats' -or $menu.method -ne 'setChatMenuButton' -or $menu.body.menu_button.type -ne 'commands') { throw 'Menu payload changed' }
      $expected = switch ($lang) { 'ja' { 'サーバーの状態を確認' } 'en' { 'View server status' } default { '開啟伺服器狀態監控' } }
      if ($commands.body.commands[0].description -ne $expected) { throw 'Command language changed' }
      $expectedPrompt = switch ($lang) { 'ja' { '非表示' } 'en' { 'hidden, not saved' } default { '不會顯示或保存' } }
      foreach ($prompt in $global:fixturePromptTexts) { if ($prompt -notlike ('*' + $expectedPrompt + '*')) { throw 'Secret prompt language mismatch' } }
      $expectedOutput = switch ($lang) { 'ja' { 'Webhook を登録しました。' } 'en' { 'Webhook registered.' } default { 'Webhook 註冊完成。' } }
      if ($global:fixtureOutput -ne $expectedOutput) { throw 'Registration output language mismatch' }
    }
    foreach ($lang in @('zh','ja','en')) {
      Check-Registration ${quote(publicScript)} $lang $false
      $global:fixturePrompts=0; $global:fixtureCalls=@()
      try { & ${quote(publicScript)} -WorkerUrl 'https://user:mock-bot@worker.example'; throw 'Invalid origin accepted' }
      catch {
        $expectedError = switch ($lang) { 'ja' { 'HTTPS のルート URL' } 'en' { 'HTTPS root URL' } default { 'HTTPS 根網址' } }
        if ($_.Exception.Message -notlike ('*' + $expectedError + '*') -or $_.Exception.Message -like '*mock-bot*') { throw 'Origin error language or sanitization mismatch' }
      }
      if ($global:fixturePrompts -ne 0 -or $global:fixtureCalls.Count -ne 0) { throw 'Invalid origin reached secret input or network' }
    }
    ${existsSync(privateScript) ? `Check-Registration ${quote(privateScript)} 'ja' $true` : ''}
    $global:fixtureFailure=$true
    try { & ${quote(publicScript)} -WorkerUrl 'https://worker.example'; throw 'Expected transport failure' }
    catch { if ($_.Exception.Message -like '*mock-bot*' -or $_.Exception.Message -notlike '*Telegram setWebhook*') { throw 'Error sanitization changed' } }
  `;
  runPowerShell(t, script);
});
