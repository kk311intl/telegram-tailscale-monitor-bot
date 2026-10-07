#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$WorkerUrl,
    [Security.SecureString]$SecureWebhookSecret,
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $projectRoot 'wrangler.jsonc' }
$botLanguage = if (Test-Path -LiteralPath $configPath) { (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).vars.BOT_LANGUAGE } else { 'zh' }
$ui = switch ($botLanguage) {
    'ja' { @{
        start = 'サーバーの状態を確認'
        botToken = 'Telegram Bot Token（非表示・保存しません）'
        webhookSecret = 'Worker に設定済みの WEBHOOK_SECRET（非表示・保存しません）'
        invalidOrigin = 'WorkerUrl には HTTPS のルート URL を指定してください。認証情報・パス・クエリ・フラグメントは使用できません。'
        requestFailed = 'Telegram {0} の呼び出しに失敗しました。Token を保護するためリクエスト URL は表示しません。'
        rejected = 'Telegram が {0} を拒否しました。'
        registered = 'Webhook を登録しました。'
    } }
    'en' { @{
        start = 'View server status'
        botToken = 'Telegram Bot Token (hidden, not saved)'
        webhookSecret = 'WEBHOOK_SECRET already set on the Worker (hidden, not saved)'
        invalidOrigin = 'WorkerUrl must be an HTTPS root URL without credentials, path, query or fragment.'
        requestFailed = 'Telegram {0} failed. The request URL is hidden to protect the token.'
        rejected = 'Telegram rejected {0}.'
        registered = 'Webhook registered.'
    } }
    default { @{
        start = '開啟伺服器狀態監控'
        botToken = '輸入 Telegram Bot Token（不會顯示或保存）'
        webhookSecret = '輸入已設定於 Worker 的 WEBHOOK_SECRET（不會顯示或保存）'
        invalidOrigin = 'WorkerUrl 必須是 HTTPS 根網址，不可含帳密、路徑、查詢或片段。'
        requestFailed = 'Telegram {0} 呼叫失敗；為保護 Token，已隱藏請求網址。'
        rejected = 'Telegram 拒絕 {0}。'
        registered = 'Webhook 註冊完成。'
    } }
}
$uri = $null
if (-not [Uri]::TryCreate($WorkerUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or
    $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
    throw $ui.invalidOrigin
}
$WorkerUrl = $uri.GetLeftPart([UriPartial]::Authority)
$botTokenSecure = Read-Host $ui.botToken -AsSecureString
$webhookSecretSecure = if ($null -ne $SecureWebhookSecret) { $SecureWebhookSecret } else { Read-Host $ui.webhookSecret -AsSecureString }
$botCredential = [PSCredential]::new('telegram', $botTokenSecure)
$secretCredential = [PSCredential]::new('webhook', $webhookSecretSecure)
function Invoke-TelegramBotApi {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][hashtable]$Body
    )
    try {
        $response = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/$Method" -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 4)
    } catch {
        throw ($ui.requestFailed -f $Method)
    }
    if (-not $response.ok) { throw ($ui.rejected -f $Method) }
    return $response
}
try {
    $botToken = $botCredential.GetNetworkCredential().Password
    $webhookSecret = $secretCredential.GetNetworkCredential().Password
    $body = @{
        url = "$($WorkerUrl.TrimEnd('/'))/webhook"
        secret_token = $webhookSecret
        allowed_updates = @('message', 'callback_query')
        drop_pending_updates = $false
        max_connections = 10
    }
    Invoke-TelegramBotApi -Method 'setWebhook' -Body $body | Out-Null
    $commandsBody = @{
        commands = @(@{ command = 'start'; description = $ui.start })
        scope = @{ type = 'all_private_chats' }
    }
    Invoke-TelegramBotApi -Method 'setMyCommands' -Body $commandsBody | Out-Null
    $menuBody = @{ menu_button = @{ type = 'commands' } }
    Invoke-TelegramBotApi -Method 'setChatMenuButton' -Body $menuBody | Out-Null
    Write-Host $ui.registered
} finally {
    $botToken = $null
    $webhookSecret = $null
    $botCredential = $null
    $secretCredential = $null
}
