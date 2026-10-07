# Telegram Server Monitor Bot

[中文](#zh-tw) · [日本語](#ja) · [English](#en)

`v1.4.4` · [GPL-3.0-only](LICENSE)

<a id="zh-tw"></a>

## 中文

<details>
<summary>用 AI 部署：展開並複製提示詞</summary>

```text
請協助我部署這個 Telegram 伺服器監控 Bot，我沒有寫程式經驗：
https://github.com/kk311intl/telegram-tailscale-monitor-bot
先讀 README、設定範例與內附工具，依文件完成測試、試跑、D1 資料庫遷移、
四項 Secret、Worker 部署及 Webhook 註冊。Tailscale OAuth 僅授予 devices:core:read。
能操作的步驟請執行；需要登入或操作後台時，給我具體步驟並等我完成。
秘密值使用安全輸入或官方後台，不放進聊天、Git、日誌或命令列參數。
已有部署就沿用資源、設定與資料；除非錯誤阻擋部署，不改程式。重建資源先取得同意。
GeoIP 預設關閉，說明 IP 資料去向並取得同意後才開啟。
檢查 /health、Telegram 私聊 /start 和 /status，以及排程是否持續更新資料。
通知測試先取得同意；列出未驗證項目，不把 Tailscale 連線當成服務健康。
```

</details>

一個透過 Telegram 查看設備狀態、接收通知的伺服器監控 Bot。使用 Tailscale Devices API，部署於 Cloudflare Workers、D1 與 SQLite Durable Objects，不需要自管常駐伺服器。

**監測的是設備與 Tailscale 控制平面的連線，不檢查端口或應用服務健康。** 介面與通知支援中文、日文、英文，由部署設定統一指定。

### 首次部署

準備 Node.js 24 LTS（建議）、pnpm 11+、PowerShell 7，以及 Cloudflare、Telegram、Tailscale 帳戶。下載工程後在根目錄操作；已有部署請看[升級](#zh-upgrade)。

1. 在官方 Telegram BotFather 建立 Bot，保存 Bot Token。確認自己的數字 User ID，不是 Bot ID 或群組 ID。
2. 在 Tailscale Admin Console → Trust credentials 建立 OAuth 憑證，只選 Devices → Core → Read（`devices:core:read`）。保存 Client ID 與 Client Secret，它們不是 Auth key。[官方步驟](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client)
3. 建立本機設定並登入 Cloudflare：

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

將建立資料庫時回傳的 `database_id` 填入 `wrangler.jsonc`，並替換 `ADMIN_USER_ID`。Worker `name` 與 D1 `database_name` 可自行命名；保留範例中的 `STATUS_DB`、`SCHEDULER` 綁定與遷移設定。

| 設定 | 預設 | 用途 |
| --- | --- | --- |
| `ADMIN_USER_ID` | 必填 | 唯一管理者的 Telegram 數字 User ID |
| `BOT_LANGUAGE` | `zh` | `zh`／`ja`／`en`，整個 Bot 的語言 |
| `TIME_ZONE` | `UTC` | 通知與詳情使用的 IANA 時區 |
| `BOT_TITLE` | 空 | 自訂總覽標題；留空使用所選語言的標題 |
| `OFFLINE_AFTER` | `2` | 確認離線所需的連續有效觀察次數，範圍 2–10 |
| `HIDDEN_TAGS` | 空 | 要隱藏的完整標籤，以逗號分隔，如 `tag:lab,tag:test` |
| `GEOIP_ENABLED` | `false` | `true` 才查國旗；資料去向見隱私說明 |
| `TAILSCALE_TAILNET` | `-` | OAuth 所屬 Tailnet，通常不需另設 |

用密碼管理器產生隨機 `WEBHOOK_SECRET`，建議 32 字元、上限 256，只用英文字母、數字、`_`、`-`（[Telegram 規則](https://core.telegram.org/bots/api#setwebhook)）。四項憑證存為 Worker **Secret**，不放入 `vars` 或設定檔。

執行下列命令，各 `secret put` 會提示輸入，也可改用 Cloudflare 後台設定 Secret。最後一行的網址須換成部署回傳的 Worker HTTPS 根網址，不帶路徑、帳密、查詢或片段。

```powershell
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler secret put BOT_TOKEN --config wrangler.jsonc
pnpm exec wrangler secret put WEBHOOK_SECRET --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_ID --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_SECRET --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
pwsh -File ./tools/Register-TelegramWebhook.ps1 -WorkerUrl https://YOUR_WORKER.workers.dev
```

Webhook 工具會隱藏輸入 Bot Token 與同一個 `WEBHOOK_SECRET`，並註冊 Webhook、`/start` 與選單；提示語言跟隨 `BOT_LANGUAGE`。

### 使用與驗證

僅管理者可在私聊操作：`/start` 查看最近設備資料、`/status` 更新總覽、`/list` 查看列表、`/device ID` 查看詳情。總覽與列表每頁 10 台；IP 不顯示，但按 IP 排序，離線設備不置頂。

每分鐘更新一次。預設連續兩次有效離線觀察、相隔至少 60 秒才確認離線；取得有效在線結果後通知恢復。API 錯誤不算設備離線。通知分別顯示「最後在線」或「恢復時間」，不是 Telegram 送達時間。

另會提醒資料更新中斷至少 5 分鐘及恢復、可見設備加入／離開清單，以及金鑰到期前 7 天內的狀態。初次建立清單不發新增通知；金鑰提醒需 API 提供到期時間。

先將範例網址替換為自己的 Worker 網址：

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` 只確認 Worker 可回應。還須私聊 `/start`、`/status`，檢查設備資料，並確認詳情的「資料更新」隨排程更新。通知測試只用自己可控制的測試設備，不中斷正式服務。

<a id="zh-upgrade"></a>

### 升級

備份資料，保留原有設定、資源 ID、Secrets 與遷移歷史，不重跑 `Copy-Item` 或 `d1 create`。對照[設定範例](wrangler.jsonc.example)補缺少的設定；舊設定若沒有 `durable_objects` 與 `migrations`，補上對應區塊，保留 `SCHEDULER` 與 `scheduler-v1`。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
```

未變更的 Secret 不需重輸。Worker 網址或語言改變時，再執行 [Webhook 工具](tools/Register-TelegramWebhook.ps1)。

### 隱私與限制

D1 保存設備名稱、標籤、Tailscale IP、公開端點 IP、狀態與時間等資料。隱藏 IP 不代表匿名化；`HIDDEN_TAGS` 不刪除已保存資料，也不限制 OAuth 的 API 讀取權限。

GeoIP 預設關閉。啟用後，公開端點 IP 可能送至 [Country.is](https://country.is/) 推斷國旗。API 無法確認目前活躍介面，VPN、代理或多個端點都可能影響結果；國旗不保證是設備實際所在地。

設定、憑證、資料庫匯出、備份與日誌不應提交或公開。提交前檢查 Git 追蹤內容，求助時遮蔽秘密值與私人識別資料；輸入秘密時避免終端錄製或螢幕分享。

排程、API 或 Telegram 故障／限流可能延遲通知，重試也可能造成重複；Worker 完全停止時無法即時告警。可使用 Cloudflare 免費方案，配額與費用見[官方定價](https://developers.cloudflare.com/durable-objects/platform/pricing/)。

<a id="ja"></a>

## 日本語

<details>
<summary>AI でデプロイ：プロンプトを開いてコピー</summary>

```text
プログラミング経験のない私が、この Telegram サーバー監視 Bot をデプロイするのを手伝ってください。
https://github.com/kk311intl/telegram-tailscale-monitor-bot
README、設定例、付属ツールを読み、テスト、ドライラン、D1 マイグレーション、
4 つの Secret、Worker デプロイ、Webhook 登録を進めてください。
Tailscale OAuth の権限は devices:core:read のみにしてください。
操作できる手順は実行し、ログインや管理画面の操作が必要なら手順を示して私の完了を待ってください。
秘密値は安全な入力か公式管理画面で扱い、チャット・Git・ログ・コマンド引数に残さないでください。
既存のリソース・設定・データを保持し、実際のエラーがなければコード改修は不要です。
リソースを再作成する場合は先に同意を得てください。
GeoIP は送信先を説明して同意を得た場合だけ有効にしてください。
/health、個人チャットの /start と /status、定期的なデータ更新を確認してください。
通知テストには先に同意を得て、未確認の項目を明記してください。接続状態をサービスの稼働確認と呼ばないでください。
```

</details>

Telegram で端末の状態を確認し、通知を受け取るサーバー監視 Bot です。Tailscale Devices API を使い、Cloudflare Workers、D1、SQLite Durable Objects で動作するため、常時稼働する自前サーバーは不要です。

**Tailscale コントロールプレーンとの接続を監視するもので、ポートやアプリケーションの稼働確認ではありません。** 画面と通知は中国語・日本語・英語に対応し、言語はデプロイ設定で統一します。

### 初回デプロイ

Node.js 24 LTS（推奨）、pnpm 11+、PowerShell 7、Cloudflare・Telegram・Tailscale のアカウントを用意します。プロジェクトをダウンロードして、その直下で操作してください。既存環境は[更新](#ja-upgrade)を参照してください。

1. Telegram の公式 BotFather で Bot を作り、Bot Token を保存します。自分の数字の User ID を確認してください。Bot ID やグループ ID ではありません。
2. Tailscale Admin Console → Trust credentials で OAuth 資格情報を作成し、Devices → Core → Read（`devices:core:read`）だけを選びます。Client ID と Client Secret を保存します。Auth key とは異なります。[公式手順](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client)
3. ローカル設定を作り、Cloudflare にログインします。

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

データベース作成時の `database_id` を `wrangler.jsonc` に入力し、`ADMIN_USER_ID` を置き換えます。Worker の `name` と D1 の `database_name` は変更できます。例の `STATUS_DB`、`SCHEDULER` のバインディングとマイグレーション設定は保持してください。

| 設定 | 既定値 | 用途 |
| --- | --- | --- |
| `ADMIN_USER_ID` | 必須 | 唯一の管理者の Telegram ユーザー ID（数字） |
| `BOT_LANGUAGE` | `zh` | `zh`／`ja`／`en`。Bot 全体の言語 |
| `TIME_ZONE` | `UTC` | 通知と詳細に使う IANA タイムゾーン |
| `BOT_TITLE` | 空 | 概要タイトル。空なら選択した言語に合わせる |
| `OFFLINE_AFTER` | `2` | オフライン判定に必要な連続した有効な観測数（2～10） |
| `HIDDEN_TAGS` | 空 | 非表示にする完全なタグ名をカンマ区切りで指定。例：`tag:lab,tag:test` |
| `GEOIP_ENABLED` | `false` | `true` の場合のみ国旗を検索。送信先はプライバシーの説明を参照 |
| `TAILSCALE_TAILNET` | `-` | OAuth の対象 Tailnet。通常は追加設定不要 |

パスワードマネージャーでランダムな `WEBHOOK_SECRET` を生成します。32 文字を推奨、上限 256 文字で、英数字・`_`・`-` のみ使います（[Telegram の規則](https://core.telegram.org/bots/api#setwebhook)）。4 つの資格情報は Worker の **Secret** として保存し、`vars` や設定ファイルには書きません。

次を実行すると各 `secret put` で入力を求められます。Cloudflare 管理画面で Secret として設定しても構いません。最後の URL はデプロイ結果の HTTPS ルート URL に置き換えてください。パス・認証情報・クエリ・フラグメントは付けません。

```powershell
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler secret put BOT_TOKEN --config wrangler.jsonc
pnpm exec wrangler secret put WEBHOOK_SECRET --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_ID --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_SECRET --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
pwsh -File ./tools/Register-TelegramWebhook.ps1 -WorkerUrl https://YOUR_WORKER.workers.dev
```

Webhook ツールで Bot Token と同じ `WEBHOOK_SECRET` を非表示で入力し、Webhook、`/start`、メニューを登録します。ツールの表示言語も `BOT_LANGUAGE` に従います。

### 使い方と確認

管理者だけが個人チャットで操作できます。`/start` は最近の端末データ、`/status` は概要を更新、`/list` は一覧、`/device ID` は詳細を表示します。概要と一覧は 1 ページ 10 台です。IP は非表示ですが IP 順に並び、オフライン端末は先頭に移動しません。

毎分更新します。既定では 60 秒以上離れた有効なオフライン観測が 2 回続くと判定し、有効なオンライン結果を得た後に復旧を通知します。API エラーは端末のオフラインとは扱いません。通知には最終オンライン時刻または復旧時刻を表示します。Telegram への配信時刻ではありません。

更新が 5 分以上途絶えた場合と復旧時、表示対象の端末が一覧に追加されたとき・一覧から消えたとき、キーの期限前 7 日以内にも通知します。初回の一覧作成では追加通知は送りません。キー通知には API の期限情報が必要です。

例の URL を自分の Worker URL に置き換えます。

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` は Worker の応答だけを確認します。個人チャットで `/start` と `/status` を実行し、端末データと、詳細の「データ更新」が定期的に更新されることも確認してください。通知テストは管理できるテスト端末で行い、本番サービスを中断しないでください。

<a id="ja-upgrade"></a>

### 更新

データをバックアップし、設定、リソース ID、Secrets、マイグレーション履歴を保持します。`Copy-Item` と `d1 create` は再実行しません。[設定例](wrangler.jsonc.example)と比較し、不足する設定だけを追加します。古い設定に `durable_objects` と `migrations` がない場合は対応するブロックを補い、`SCHEDULER` と `scheduler-v1` を保持してください。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
```

変更していない Secret の再入力は不要です。Worker URL または言語を変えた場合は [Webhook ツール](tools/Register-TelegramWebhook.ps1)を再実行します。

### プライバシーと制限

D1 には端末名、タグ、Tailscale IP、公開エンドポイント IP、状態、時刻などが保存されます。IP の非表示は匿名化ではありません。`HIDDEN_TAGS` は保存済みデータを削除せず、OAuth の API 読み取り権限も制限しません。

GeoIP は既定で無効です。有効にすると公開エンドポイント IP を [Country.is](https://country.is/) に送信して国旗を推定する場合があります。API では現在有効なインターフェースを判別できず、VPN・プロキシ・複数のエンドポイントも影響するため、実際の所在地は保証できません。

設定、資格情報、DB エクスポート、バックアップ、ログはコミット・公開しないでください。Git の追跡対象を確認し、相談時は秘密値や個人情報を伏せてください。秘密値の入力中はターミナルの記録や画面共有を避けてください。

スケジュール・API・Telegram の障害やレート制限で通知が遅れ、再試行で重複する場合があります。Worker の完全停止時には即時警報を出せません。Cloudflare 無料プランでも利用でき、利用枠と料金は[公式料金表](https://developers.cloudflare.com/durable-objects/platform/pricing/)を確認してください。

<a id="en"></a>

## English

<details>
<summary>Deploy with AI: open and copy the prompt</summary>

```text
Help me deploy this Telegram server-monitoring bot without writing code:
https://github.com/kk311intl/telegram-tailscale-monitor-bot
Read the README, example config, and tools. Follow the tests, dry-run, D1 migrations,
four secrets, Worker deployment, and webhook registration. Limit Tailscale OAuth to devices:core:read.
Perform accessible steps. For sign-in or dashboard actions, give instructions and wait for me.
Use secure prompts or official dashboards for secrets, not chat, Git, logs, or command arguments.
Preserve existing resources, settings, and data. Only change code or recreate resources if needed
to resolve a deployment blocker, with my approval before recreating anything.
Keep GeoIP off unless I consent after learning where IP data is sent.
Check /health, private Telegram /start and /status, and continuing scheduled data updates.
Ask before testing notifications and report anything unverified. Connectivity is not service health.
```

</details>

A Telegram bot for checking device status and receiving server alerts. It uses the Tailscale Devices API and runs on Cloudflare Workers, D1, and SQLite Durable Objects, with no always-on server to maintain.

**It monitors connectivity to the Tailscale control plane, not ports or application health.** The UI and alerts support Chinese, Japanese, and English, set for the whole deployment.

### First deployment

Prepare Node.js 24 LTS (recommended), pnpm 11+, PowerShell 7, and Cloudflare, Telegram, and Tailscale accounts. Download the project and work from its root directory. For an existing deployment, see [Upgrading](#en-upgrade).

1. Create a bot through Telegram's official BotFather and save its Bot Token. Find your numeric User ID, not the bot or group ID.
2. In Tailscale Admin Console → Trust credentials, create an OAuth credential with only Devices → Core → Read (`devices:core:read`). Save its Client ID and Client Secret; these are not an auth key. [Official guide](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client)
3. Create local configuration and log in to Cloudflare:

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

Put the new database's `database_id` in `wrangler.jsonc` and replace `ADMIN_USER_ID`. You may choose Worker `name` and D1 `database_name`. Keep the example's `STATUS_DB` and `SCHEDULER` bindings and migration settings.

| Setting | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USER_ID` | Required | Numeric Telegram User ID of the sole administrator |
| `BOT_LANGUAGE` | `zh` | `zh`, `ja`, or `en`; deployment-wide language |
| `TIME_ZONE` | `UTC` | IANA time zone for alerts and device details |
| `BOT_TITLE` | Empty | Dashboard title; empty uses the selected language |
| `OFFLINE_AFTER` | `2` | Consecutive valid observations to confirm offline, from 2 to 10 |
| `HIDDEN_TAGS` | Empty | Exact comma-separated tags to hide, e.g. `tag:lab,tag:test` |
| `GEOIP_ENABLED` | `false` | Only `true` enables flags; see privacy for data sharing |
| `TAILSCALE_TAILNET` | `-` | OAuth client's Tailnet; usually no setting is needed |

Generate a random `WEBHOOK_SECRET` in a password manager: 32 characters recommended, maximum 256, using only letters, digits, `_`, and `-` ([Telegram rules](https://core.telegram.org/bots/api#setwebhook)). Store the four credentials as Worker **secrets**, not in `vars` or config files.

Run the following; each `secret put` prompts for its value, or you may set it as a Secret in Cloudflare's dashboard. Replace the last URL with the deployed Worker's HTTPS root URL, without a path, credentials, query, or fragment.

```powershell
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler secret put BOT_TOKEN --config wrangler.jsonc
pnpm exec wrangler secret put WEBHOOK_SECRET --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_ID --config wrangler.jsonc
pnpm exec wrangler secret put TAILSCALE_CLIENT_SECRET --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
pwsh -File ./tools/Register-TelegramWebhook.ps1 -WorkerUrl https://YOUR_WORKER.workers.dev
```

The webhook tool securely prompts for the Bot Token and the same `WEBHOOK_SECRET`, then registers the webhook, `/start`, and menu. Its prompts follow `BOT_LANGUAGE`.

### Usage and verification

Only the administrator can use the bot in a private chat. `/start` shows recent device data, `/status` refreshes the overview, `/list` lists devices, and `/device ID` shows details. Overview and list pages hold ten devices. IPs are hidden but determine sorting; offline devices are not moved to the top.

Data updates every minute. By default, two valid offline observations at least 60 seconds apart confirm an outage; a valid online result triggers recovery. API failures do not count as device outages. Alerts show the last online or recovery time, not the Telegram delivery time.

Other alerts cover updates interrupted for at least five minutes and resumed, visible devices joining/leaving the list, and keys expiring within seven days. The initial inventory sends no new-device alerts. Key warnings require an API-supplied expiry time.

Replace the example URL with your Worker URL:

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` only checks the Worker responds. Also use private `/start` and `/status`, inspect the device data, and confirm that “Data updated” in details stays fresh across scheduled runs. Test alerts only with a device you control; do not interrupt production services.

<a id="en-upgrade"></a>

### Upgrading

Back up data and keep existing settings, resource IDs, secrets, and migration history. Do not rerun `Copy-Item` or `d1 create`. Compare the [config example](wrangler.jsonc.example) and add missing settings only. If an older config lacks `durable_objects` and `migrations`, add those blocks, retaining `SCHEDULER` and `scheduler-v1`.

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler d1 migrations apply STATUS_DB --remote --config wrangler.jsonc
pnpm exec wrangler deploy --config wrangler.jsonc
```

Unchanged secrets need no re-entry. Rerun the [webhook tool](tools/Register-TelegramWebhook.ps1) if the Worker URL or language changes.

### Privacy and limitations

D1 stores device names, tags, Tailscale IPs, public endpoint IPs, status, timestamps, and related monitoring data. Hiding IPs does not anonymize data. `HIDDEN_TAGS` does not delete stored records or restrict OAuth API read access.

GeoIP is off by default. If enabled, public endpoint IPs may be sent to [Country.is](https://country.is/) to infer flags. The API cannot identify the active interface; VPNs, proxies, and multiple endpoints can affect results. Flags do not guarantee physical location.

Do not commit or publish settings, credentials, database exports, backups, or logs. Check Git's tracked files and redact secrets and private identifiers when seeking help. Avoid terminal recording or screen sharing while entering secrets.

Schedule, API, or Telegram failures and rate limits can delay alerts; retries can duplicate them. A stopped Worker cannot alert immediately. The Cloudflare free plan is supported; consult [official pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for limits and charges.

Copyright (C) 2026 kk311intl.
