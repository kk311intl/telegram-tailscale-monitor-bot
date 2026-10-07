# Telegram Server Monitoring Bot · Tailscale API

[中文](#zh-tw) · [日本語](#ja) · [English](#en)

版本 / バージョン / Version：`v1.4.4` · [GPL-3.0-only](LICENSE)

Copyright (C) 2026 kk311intl.

<a id="zh-tw"></a>

## 中文

### AI 零寫碼部署提示詞

```text
請協助沒有寫程式經驗的我部署 Telegram 伺服器監控 Bot：https://github.com/kk311intl/telegram-tailscale-monitor-bot 。先讀 README、wrangler.jsonc.example 與內附工具，準備環境、Telegram Bot／管理者 User ID、僅 devices:core:read 的 Tailscale OAuth Client、Cloudflare D1 與 Worker 設定。
能代操作的步驟請執行；需我登入或操作後台時，指出具體位置並等我完成。先測試與 dry-run，再套用 migration、設定四項 Secret、部署 Worker、註冊 Webhook。只問必要資訊，秘密值只能用安全輸入或官方後台，不得貼進聊天、Git、日誌或命令列參數；GeoIP 預設關閉，說明資料去向並取得同意後才開啟。
若已有部署，保留原有設定、資源與資料，不重新建立資料庫或更換憑證。不要新增功能或改原始碼，除非實際錯誤阻擋部署。
用 /health、Telegram 私聊 /start 和 /status、設備詳情的同步資訊驗證；通知測試先取得同意，未驗證項目明確列出。不要把 Tailscale 連線狀態說成端口或服務健康，也不要只憑 deploy 成功就宣稱 Bot 已可用。
```

透過 Telegram 查看設備狀態、接收離線與恢復通知的 Bot，基於 Tailscale Devices API。部署在 Cloudflare Workers、D1 與 SQLite Durable Objects，無需自管常駐伺服器；可使用免費方案，限制與費用以 [Cloudflare 官方定價](https://developers.cloudflare.com/durable-objects/platform/pricing/) 為準。

**監測的是設備與 Tailscale 控制平面的連線，不是端口或應用服務健康。** Bot 介面與通知支援中文、日文、英文，語言由部署設定統一指定，不提供使用者切換。

### 首次部署

建議使用 Node.js 24 LTS、pnpm 11+ 與 PowerShell 7（Webhook 工具需要）。下載或 clone 工程後，在工程根目錄操作。已有部署請先看[升級](#zh-upgrade)，不要覆蓋設定或另建資料庫。

1. 在 Telegram 的官方 BotFather 建立 Bot，保存 Bot Token；確認自己的數字 User ID（不是 Bot ID 或群組 ID）。
2. 在 Tailscale Admin Console 的 Trust credentials 建立 **OAuth** 憑證，僅選 Devices → Core → Read（`devices:core:read`），保存 Client ID 與 Client Secret；它不是 Auth key。參考 [Tailscale 官方說明](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client)。
3. 準備 Cloudflare 帳戶，執行：

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

將回傳的 D1 `database_id` 填入本機 `wrangler.jsonc`；替換 `ADMIN_USER_ID`。Worker `name` 與 D1 `database_name` 可自行命名，須與建立的資源一致；保留範例的 `STATUS_DB`、`SCHEDULER` 綁定及 migration 設定。

| 設定 | 預設 | 用途 |
| --- | --- | --- |
| `ADMIN_USER_ID` | 必填 | 唯一管理者的 Telegram 數字 User ID |
| `BOT_LANGUAGE` | `zh` | `zh`／`ja`／`en`；整個 Bot 的語言 |
| `TIME_ZONE` | `UTC` | IANA 時區名稱；通知與詳情共用 |
| `BOT_TITLE` | 空 | 自訂總覽標題；空值跟隨語言 |
| `OFFLINE_AFTER` | `2` | 確認離線所需的連續有效觀察次數，範圍 2–10 |
| `HIDDEN_TAGS` | 空 | 逗號分隔的完整標籤，例如 `tag:lab,tag:test`；空值不隱藏 |
| `GEOIP_ENABLED` | `false` | `true` 才查國旗；先閱讀隱私說明 |
| `TAILSCALE_TAILNET` | `-` | OAuth 所屬 Tailnet，通常不用另設 |

用密碼管理器產生隨機 `WEBHOOK_SECRET`，建議 32 字元（上限 256），僅用英文字母、數字、`_`、`-`（[Telegram 規則](https://core.telegram.org/bots/api#setwebhook)）。以下四項必須存為 Worker **Secret**，不要寫進 `vars`、設定檔或命令列參數：`BOT_TOKEN`、`WEBHOOK_SECRET`、`TAILSCALE_CLIENT_ID`、`TAILSCALE_CLIENT_SECRET`。

以下 `secret put` 會逐項提示輸入；也可在 Cloudflare 後台設為 Secret。使用不錄製的終端。最後一行先把範例網址換成 deploy 回傳的 Worker HTTPS 根網址（不帶路徑、帳密、查詢或片段）：

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

Webhook 工具會隱藏輸入 Bot Token 與**同一個** `WEBHOOK_SECRET`，並設定 Telegram Webhook、`/start` 命令與選單。秘密值應保存在官方 Secret 設定或自己的密碼管理器，不要貼入聊天。

### 使用與驗證

僅設定的管理者可在 Telegram 私聊使用：`/start` 查看最近有效快照、`/status` 更新總覽、`/list` 查看設備、`/device ID` 查看詳情。總覽和設備列表每頁 10 台，可按鈕翻頁；IP 不顯示，列表按 IP 排序，不將離線設備置頂。

每分鐘同步一次；預設連續 2 次有效離線觀察、相隔至少 60 秒才確認離線，恢復則在取得有效在線結果後通知。API 錯誤不算設備離線。離線通知顯示「最後在線」，恢復通知顯示「恢復時間」；時間來自設定時區，不是 Telegram 訊息送達時間。

另有同步中斷至少 5 分鐘／恢復、可見設備加入／移除及金鑰到期前 7 天內的提醒。首次建立清單不發新增通知；金鑰提醒依 API 是否提供到期時間。

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

將上述範例網址替換為自己的 Worker 網址。`/health` 只證明 Worker 可回應：還須私聊 `/start`、執行 `/status`，確認設備資料合理，再確認設備詳情的「API 最近同步」隨排程更新。通知測試只用自己可控制的測試設備，不應中斷正式服務。

排程、API 或 Telegram 故障／限流都可能延遲通知，特殊重試情況也可能重複；Bot 無法在 Worker 自身完全停止運作時即時告警。

<a id="zh-upgrade"></a>

### 升級

保留原有 `wrangler.jsonc`、Worker／D1 資源 ID、Secrets 與資料；不要重跑 `Copy-Item` 或 `d1 create`。對照最新[設定範例](wrangler.jsonc.example)，只補必要設定；舊設定若缺少 `durable_objects` 與 `migrations`，補上對應設定，保留 `SCHEDULER`、`scheduler-v1` 及既有 migration 歷史。

備份資料後，依序執行安裝、`pnpm check`、dry-run、D1 migrations、deploy，皆使用既有設定。未變更的 Secret 不需重新輸入；Worker 網址或 `BOT_LANGUAGE` 改變時，再執行 [Webhook 工具](tools/Register-TelegramWebhook.ps1)。

### 隱私與限制

D1 保存設備名稱、標籤、Tailscale IP、公開端點 IP、狀態與時間等監控資料。**畫面隱藏 IP 不代表匿名化；`HIDDEN_TAGS` 不會刪除先前保存的資料**，也不會縮小 OAuth 的 API 讀取權限。

GeoIP 預設關閉。啟用後，公開端點 IP 可能送至 [Country.is](https://country.is/) 推斷國旗。API 端點清單不能確認目前活躍介面，VPN／代理或多個端點都可能影響結果；國旗不保證代表設備的實際所在地。

本機 `wrangler.jsonc`、`.dev.vars`／`.env`、個人設定、憑證、資料庫匯出、備份與日誌不應提交或公開。提交前仍須自行檢查 Git 追蹤內容，不能只依賴 `.gitignore`；求助時先遮蔽 Token、User ID、設備名稱、IP 與資源 ID。

<a id="ja"></a>

## 日本語

### AI ノーコードデプロイ用プロンプト

```text
プログラミング経験のない私が Telegram サーバー監視 Bot をデプロイするのを手伝ってください：https://github.com/kk311intl/telegram-tailscale-monitor-bot 。README、wrangler.jsonc.example、付属ツールを読み、環境、Telegram Bot と管理者 User ID、devices:core:read のみの Tailscale OAuth Client、Cloudflare D1 と Worker 設定を準備してください。
操作できる手順は実行し、ログインや管理画面の操作が必要なら具体的な場所を示して私の完了を待ってください。テストと dry-run の後に migration、4 つの Secret、Worker deploy、Webhook 登録を進めてください。質問は必要なものだけにし、秘密値は安全な入力か公式管理画面で扱い、チャット・Git・ログ・コマンド引数に残さないでください。GeoIP は既定で無効とし、データの送信先を説明して同意を得た場合だけ有効にしてください。
既存環境では設定・リソース・データを保持し、データベースの再作成や資格情報の変更はしないでください。実際のバグがデプロイを妨げない限り、機能追加やソース改修は不要です。
/health、Telegram の個人チャットで /start と /status、端末詳細の同期情報を確認してください。通知テストには先に同意を得て、未確認の項目を明記してください。Tailscale の接続状態をポートやサービスの稼働確認と呼ばず、deploy の成功だけで Bot が使えると判断しないでください。
```

Telegram で端末の状態を確認し、オフライン・復旧通知を受け取る Bot です。Tailscale Devices API を利用し、Cloudflare Workers、D1、SQLite Durable Objects にデプロイするため、常時稼働する自前サーバーは不要です。無料プランでも利用できますが、制限と料金は [Cloudflare 公式料金表](https://developers.cloudflare.com/durable-objects/platform/pricing/) を確認してください。

**監視対象は Tailscale コントロールプレーンとの接続であり、ポートやアプリケーションの稼働状況ではありません。** 画面と通知は中国語・日本語・英語に対応し、言語はデプロイ設定で統一します。ユーザーごとの切り替えはありません。

### 初回デプロイ

Node.js 24 LTS、pnpm 11+、PowerShell 7（Webhook ツールに必要）を推奨します。プロジェクトをダウンロードまたは clone し、その直下で操作してください。既存環境は[更新](#ja-upgrade)を先に確認し、設定の上書きや別のデータベース作成はしないでください。

1. Telegram の公式 BotFather で Bot を作成し、Bot Token を保存します。自分の数字の User ID を確認してください（Bot ID やグループ ID ではありません）。
2. Tailscale Admin Console の Trust credentials で **OAuth** 資格情報を作成し、Devices → Core → Read（`devices:core:read`）だけを選びます。Client ID と Client Secret を保存してください。Auth key とは異なります。[Tailscale 公式手順](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client)を参照してください。
3. Cloudflare アカウントを用意し、次を実行します。

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

返された D1 の `database_id` をローカルの `wrangler.jsonc` に入力し、`ADMIN_USER_ID` を置き換えます。Worker の `name` と D1 の `database_name` は作成したリソースと一致させてください。例の `STATUS_DB`、`SCHEDULER` のバインディングと migration 設定は保持します。

| 設定 | 既定値 | 用途 |
| --- | --- | --- |
| `ADMIN_USER_ID` | 必須 | 唯一の管理者の Telegram ユーザー ID（数字） |
| `BOT_LANGUAGE` | `zh` | `zh`／`ja`／`en`。Bot 全体の言語 |
| `TIME_ZONE` | `UTC` | 通知と詳細に使う IANA タイムゾーン名 |
| `BOT_TITLE` | 空 | 概要のタイトル。空なら言語に合わせる |
| `OFFLINE_AFTER` | `2` | オフライン判定に必要な連続した有効な観測数（2～10） |
| `HIDDEN_TAGS` | 空 | 完全なタグ名をカンマ区切りで指定。例：`tag:lab,tag:test`。空なら非表示なし |
| `GEOIP_ENABLED` | `false` | `true` の場合のみ国旗を検索。先にプライバシーの説明を確認 |
| `TAILSCALE_TAILNET` | `-` | OAuth の対象 Tailnet。通常は追加設定不要 |

パスワードマネージャーでランダムな `WEBHOOK_SECRET` を生成します。32 文字を推奨（上限 256）し、英数字・`_`・`-` のみ使用します（[Telegram の規則](https://core.telegram.org/bots/api#setwebhook)）。`BOT_TOKEN`、`WEBHOOK_SECRET`、`TAILSCALE_CLIENT_ID`、`TAILSCALE_CLIENT_SECRET` は Worker の **Secret** として保存し、`vars`、設定ファイル、コマンド引数に書かないでください。

各 `secret put` で入力を求められます。Cloudflare 管理画面で Secret として設定することもできます。記録・録画しないターミナルを使ってください。最後の行の例の URL を deploy で得た Worker の HTTPS ルート URL に置き換えます（パス・認証情報・クエリ・フラグメントなし）。

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

Webhook ツールでは Bot Token と**同じ** `WEBHOOK_SECRET` を非表示で入力し、Webhook、`/start` コマンド、Telegram メニューを登録します。秘密値は公式の Secret 設定や自分のパスワードマネージャーに保存し、チャットには貼らないでください。

### 使い方と確認

設定した管理者だけが個人チャットで操作できます。`/start` は最新の有効なスナップショット、`/status` は同期と概要、`/list` は端末一覧、`/device ID` は詳細を表示します。概要と一覧は 1 ページ 10 台で、ボタンで切り替えられます。IP は非表示ですが IP 順に並び、オフライン端末は先頭に移動しません。

毎分同期し、既定では 60 秒以上離れた有効なオフライン観測が 2 回続くと判定します。復旧は有効なオンライン結果を得た後に通知します。API エラーは端末のオフラインとは扱いません。オフライン通知は最終オンライン時刻、復旧通知は復旧時刻を表示し、設定したタイムゾーンを使います。Telegram への配信時刻とは異なります。

同期が 5 分以上途絶えた場合と復旧時、表示対象の端末の追加・削除、キーの有効期限前 7 日以内にも通知します。初回の一覧作成では追加通知は送りません。キー通知は API が期限を返す場合のみです。

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

例の URL を自分の Worker URL に置き換えてください。`/health` は Worker の応答だけを確認します。個人チャットで `/start` と `/status` を実行し、端末情報が正しいことと、端末詳細の同期情報がスケジュール実行で更新されることも確認してください。通知テストは管理できるテスト端末で行い、本番サービスを中断しないでください。

スケジュール・API・Telegram の障害やレート制限で通知が遅れ、再試行の状況によっては重複する場合があります。Worker 自体が完全に停止したときの即時警報にはなりません。

<a id="ja-upgrade"></a>

### 更新

既存の `wrangler.jsonc`、Worker／D1 のリソース ID、Secrets、データを保持し、`Copy-Item` と `d1 create` は再実行しないでください。最新の[設定例](wrangler.jsonc.example)と比較し、必要な設定だけを追加します。古い設定に `durable_objects` と `migrations` がない場合は補い、`SCHEDULER`、`scheduler-v1`、既存の migration 履歴を保持してください。

データをバックアップしてから、既存設定でインストール、`pnpm check`、dry-run、D1 migrations、deploy を順に実行します。変更していない Secret の再入力は不要です。Worker URL または `BOT_LANGUAGE` を変えた場合は [Webhook ツール](tools/Register-TelegramWebhook.ps1)を再実行します。

### プライバシーと制限

D1 には端末名、タグ、Tailscale IP、公開エンドポイント IP、状態、時刻などの監視データが保存されます。**IP の非表示は匿名化ではなく、`HIDDEN_TAGS` は保存済みデータを削除しません**。OAuth の API 読み取り権限も制限しません。

GeoIP は既定で無効です。有効にすると公開エンドポイント IP を [Country.is](https://country.is/) に送信して国旗を推定する場合があります。API の一覧では現在有効なインターフェースを判別できず、VPN・プロキシ・複数のエンドポイントの影響もあるため、実際の所在地は保証できません。

ローカルの `wrangler.jsonc`、`.dev.vars`／`.env`、個人設定、資格情報、DB エクスポート、バックアップ、ログはコミット・公開しないでください。`.gitignore` だけに頼らず Git の追跡対象も確認し、相談時には Token、User ID、端末名、IP、リソース ID を伏せてください。

<a id="en"></a>

## English

### AI no-code deployment prompt

```text
Help me, a non-coder, deploy this Telegram server-monitoring bot: https://github.com/kk311intl/telegram-tailscale-monitor-bot . Read the README, wrangler.jsonc.example, and included tools. Prepare the environment, Telegram bot and admin User ID, a Tailscale OAuth client with only devices:core:read, and Cloudflare D1 and Worker settings.
Perform steps you can access. For sign-in or dashboard steps, give exact instructions and wait for me. Run tests and a dry-run before migrations, the four secrets, deployment, and webhook registration. Ask only for essentials. Collect secrets through secure prompts or official dashboards, never chat, Git, logs, or command arguments. Keep GeoIP off unless I consent after learning where IP data is sent.
For an existing deployment, preserve its settings, resources, and data; do not recreate the database or replace credentials. Do not add features or change source unless a real bug blocks deployment.
Verify /health, Telegram /start and /status in a private chat, and fresh sync data in device details. Obtain consent before notification tests and list anything unverified. Do not describe Tailscale connectivity as port or application health, or claim the bot works merely because deploy succeeded.
```

A Telegram bot for viewing device status and receiving offline/recovery alerts, based on the Tailscale Devices API. It runs on Cloudflare Workers, D1, and SQLite Durable Objects without an always-on server to maintain. The free plan is supported; consult [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) for current limits and charges.

**It monitors connectivity to the Tailscale control plane, not ports or application health.** The UI and alerts support Chinese, Japanese, and English. Language is set for the whole deployment, not switched per user.

### First deployment

Use Node.js 24 LTS (recommended), pnpm 11+, and PowerShell 7 (required by the webhook tool). Download or clone the project and work from its root directory. For an existing deployment, read [Upgrading](#en-upgrade) first; do not overwrite its configuration or create another database.

1. Create a bot through Telegram's official BotFather and save its Bot Token. Find your numeric User ID, not the bot or group ID.
2. In the Tailscale Admin Console, create an **OAuth** credential under Trust credentials. Select only Devices → Core → Read (`devices:core:read`) and save the Client ID and Client Secret. This is not an auth key; see the [official Tailscale guide](https://tailscale.com/docs/features/oauth-clients#setting-up-an-oauth-client).
3. Prepare a Cloudflare account and run:

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

Put the returned D1 `database_id` in your local `wrangler.jsonc` and replace `ADMIN_USER_ID`. You may choose Worker `name` and D1 `database_name`, matching the resources you create. Keep the example's `STATUS_DB` and `SCHEDULER` bindings and migration settings.

| Setting | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USER_ID` | Required | Numeric Telegram User ID of the sole administrator |
| `BOT_LANGUAGE` | `zh` | `zh`, `ja`, or `en`; deployment-wide language |
| `TIME_ZONE` | `UTC` | IANA time zone for alerts and device details |
| `BOT_TITLE` | Empty | Dashboard title; an empty value follows the language |
| `OFFLINE_AFTER` | `2` | Consecutive valid observations required to confirm offline, from 2 to 10 |
| `HIDDEN_TAGS` | Empty | Exact comma-separated tags, e.g. `tag:lab,tag:test`; empty hides none |
| `GEOIP_ENABLED` | `false` | Only `true` enables flags; read the privacy section first |
| `TAILSCALE_TAILNET` | `-` | OAuth client's Tailnet; usually no setting is needed |

Generate a random `WEBHOOK_SECRET` in a password manager: 32 characters recommended, maximum 256, using only letters, digits, `_`, and `-` ([Telegram rules](https://core.telegram.org/bots/api#setwebhook)). Store `BOT_TOKEN`, `WEBHOOK_SECRET`, `TAILSCALE_CLIENT_ID`, and `TAILSCALE_CLIENT_SECRET` as Worker **secrets**, never in `vars`, config files, or command arguments.

Each `secret put` prompts for its value; you can instead configure it as a Secret in Cloudflare's dashboard. Use a terminal that is not being recorded. Replace the example URL on the last line with the HTTPS root URL returned by deploy, without a path, credentials, query, or fragment:

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

The webhook tool securely prompts for the Bot Token and the **same** `WEBHOOK_SECRET`, then registers the webhook, `/start`, and the Telegram menu. Keep secret values in official secret storage or your password manager, not in chat.

### Usage and verification

Only the configured administrator can use the bot in a private chat: `/start` shows the latest valid snapshot, `/status` refreshes the overview, `/list` lists devices, and `/device ID` shows details. The overview and list show ten devices per page with navigation buttons. IPs are hidden, but sorting follows IP order; offline devices are not moved to the top.

Sync runs every minute. By default, two valid offline observations at least 60 seconds apart confirm offline status; recovery is reported after a valid online result. API failures do not count as device outages. Offline alerts show the last online time; recovery alerts show the recovery time, using the configured time zone, not the Telegram delivery time.

Additional alerts cover sync interrupted for at least five minutes and its recovery, visible devices added/removed, and keys expiring within seven days. The initial inventory sends no new-device alerts. Key warnings depend on the API supplying an expiry time.

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

Replace the example URL with your Worker URL. `/health` only proves the Worker responds: also use `/start` and `/status` in a private chat, check the device data, and confirm that device details show fresh sync data across scheduled runs. Test notifications only with a device you control; do not interrupt production services.

Schedule, API, or Telegram failures and rate limits can delay alerts; retries can occasionally duplicate them. The bot cannot alert immediately when the Worker itself stops running entirely.

<a id="en-upgrade"></a>

### Upgrading

Keep the existing `wrangler.jsonc`, Worker/D1 resource IDs, secrets, and data; do not rerun `Copy-Item` or `d1 create`. Compare the latest [configuration example](wrangler.jsonc.example) and add only required settings. If an older config lacks `durable_objects` and `migrations`, add them, retaining `SCHEDULER`, `scheduler-v1`, and existing migration history.

Back up data, then run installation, `pnpm check`, dry-run, D1 migrations, and deploy using the existing configuration. Unchanged secrets need no re-entry. Rerun the [webhook tool](tools/Register-TelegramWebhook.ps1) if the Worker URL or `BOT_LANGUAGE` changes.

### Privacy and limitations

D1 stores monitoring data including device names, tags, Tailscale IPs, public endpoint IPs, status, and timestamps. **Hiding IPs does not anonymize data; `HIDDEN_TAGS` does not delete previously stored records** or restrict the OAuth client's API read access.

GeoIP is off by default. When enabled, public endpoint IPs may be sent to [Country.is](https://country.is/) to infer flags. The API endpoint list cannot identify the active interface; VPNs, proxies, and multiple endpoints can affect results. Flags do not guarantee a device's physical location.

Do not commit or publish local `wrangler.jsonc`, `.dev.vars`/`.env`, personal settings, credentials, database exports, backups, or logs. Check Git's tracked files rather than relying solely on `.gitignore`. Redact tokens, User IDs, device names, IPs, and resource IDs when requesting help.
