#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateScript({
        $uri = $null
        [Uri]::TryCreate($_, [UriKind]::Absolute, [ref]$uri) -and
        $uri.Scheme -eq 'https' -and $uri.Host -and -not $uri.UserInfo -and
        -not $uri.Query -and -not $uri.Fragment -and $uri.AbsolutePath -eq '/'
    }, ErrorMessage = 'WorkerUrl must be an HTTPS root URL without credentials, path, query or fragment.')]
    [string]$WorkerUrl,
    [Security.SecureString]$SecureWebhookSecret,
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$WorkerUrl = ([Uri]$WorkerUrl).GetLeftPart([UriPartial]::Authority)
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $projectRoot 'wrangler.jsonc' }
$botLanguage = if (Test-Path -LiteralPath $configPath) { (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).vars.BOT_LANGUAGE } else { 'zh' }
$startDescription = switch ($botLanguage) {
    'ja' { 'サーバーの状態を確認' }
    'en' { 'View server status' }
    default { '開啟伺服器狀態監控' }
}
$botTokenSecure = Read-Host '輸入 Telegram Bot Token（不會顯示或保存）' -AsSecureString
$webhookSecretSecure = if ($null -ne $SecureWebhookSecret) { $SecureWebhookSecret } else { Read-Host '輸入已設定於 Worker 的 WEBHOOK_SECRET（不會顯示或保存）' -AsSecureString }
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
        throw "Telegram $Method 呼叫失敗；為避免洩漏 Bot Token，已隱藏原始請求網址。"
    }
    if (-not $response.ok) { throw "Telegram 拒絕 $Method。" }
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
        commands = @(@{ command = 'start'; description = $startDescription })
        scope = @{ type = 'all_private_chats' }
    }
    Invoke-TelegramBotApi -Method 'setMyCommands' -Body $commandsBody | Out-Null
    $menuBody = @{ menu_button = @{ type = 'commands' } }
    Invoke-TelegramBotApi -Method 'setChatMenuButton' -Body $menuBody | Out-Null
    Write-Host 'Webhook 註冊完成。'
} finally {
    $botToken = $null
    $webhookSecret = $null
    $botCredential = $null
    $secretCredential = $null
}
