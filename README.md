# Telegram 伺服器監控 Bot（基於 Tailscale API）

[中文](#zh-tw) · [日本語](#ja) · [English](#en)

版本 / バージョン / Version：`v1.4.1`


<a id="zh-tw"></a>
## 中文

**免自管伺服器：** 部署在 Cloudflare Workers 與 D1，Webhook 和排程同步由 Worker 處理；無需自架或維護常駐主機。仍需設定 Cloudflare、Telegram 和 Tailscale 憑證。

### AI 零寫碼部署提示詞

```text
請把這個 GitHub repository 當作可直接部署的專案，協助沒有寫程式經驗的我完成 Telegram 伺服器監控 Bot 部署；目標是讓 Bot 真正可用，不是修改或解說程式碼。先閱讀 README、wrangler.jsonc.example 和工具腳本，再逐步協助我：確認 Node.js、pnpm、Cloudflare、Telegram、Tailscale 帳戶；建立 Telegram Bot 並取得管理者數字 User ID；建立權限僅為 devices:core:read 的 Tailscale OAuth Client；登入 Cloudflare、建立 D1、從範例產生不受 Git 追蹤的 wrangler.jsonc，填入 D1 ID 與部署設定；設定 BOT_LANGUAGE、TIME_ZONE、BOT_TITLE、HIDDEN_TAGS、GEOIP_ENABLED（開啟 GeoIP 會把公開端點 IP 傳給 Country.is）；先執行 pnpm check 與 Wrangler dry-run，再執行資料庫 migration，安全地輸入四項 Wrangler secrets：BOT_TOKEN、WEBHOOK_SECRET、TAILSCALE_CLIENT_ID、TAILSCALE_CLIENT_SECRET；正式 deploy，最後用內附腳本註冊 Telegram webhook。你能代操作的步驟就直接執行；需要我登入、建立憑證或點選後台時，給我具體畫面位置與下一步，等我完成再繼續。只詢問必要的缺失資訊，秘密值應透過安全輸入或後台設定，絕不貼到聊天、Git、日誌或公開檔案。不要把 Tailscale 控制平面連線誤稱為端口或服務健康。以 Worker /health、Telegram 私聊 /start、D1 最新同步與通知狀態實際驗證；任何一步未驗證，就明確說明尚未完成，不要宣稱部署成功。除非部署確實被程式錯誤阻擋，否則不要改原始碼。
```

這是透過 Telegram 查看狀態與接收通知的伺服器監控 Bot。它以 Cloudflare Worker、D1 和 Tailscale Devices API 監看 Tailnet 設備是否連接控制平面；**不檢查端口或應用服務健康**。

README、AI 提示詞與 Bot 介面／通知皆支援中文、日文、英文；在 Worker 部署設定以 `BOT_LANGUAGE` 指定，預設 `zh`。

授權：本專案採用 [GNU GPL v3.0（僅此版本）](LICENSE)。Copyright (C) 2026 kk311intl。

### 需求與設定

`BOT_TITLE` 留空時，總覽標題跟隨 `BOT_LANGUAGE` 顯示；時區預設為 UTC，亦可自行設定 IANA 時區。

需要 Node.js 22.13+、pnpm 11+、Cloudflare Workers/D1、Telegram Bot，以及只授予 `devices:core:read` 的 Tailscale OAuth Client。註冊 Webhook 的腳本需要 PowerShell 7。OAuth Client Secret 不是 Tailscale Auth key。

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

在不提交的 `wrangler.jsonc` 填入 D1 `database_id`，並將 `ADMIN_USER_ID` 改為自己的 Telegram 數字 User ID。Worker 名稱、資料庫名稱可自行修改。`OFFLINE_AFTER` 預設為 `2`（範圍 2–10）；`BOT_LANGUAGE` 可設 `zh`、`ja` 或 `en`，預設 `zh`；`TIME_ZONE` 預設為 `UTC`，可填 IANA 時區名稱；`TAILSCALE_TAILNET` 預設為 `-`，通常不用設定。`BOT_TITLE` 設定總覽標題；`HIDDEN_TAGS` 以逗號分隔要隱藏的完整 Tailscale 標籤（例如 `tag:personal,tag:lab`，留空即不隱藏）；`GEOIP_ENABLED` 預設 `false`，設為 `true` 才查國旗。

日後更改 `BOT_LANGUAGE` 時，重新執行 Webhook 註冊腳本以同步 Telegram `/start` 命令說明。

在 Tailscale Admin Console 建立 OAuth Client，權限只選 Devices → Core → Read。準備 Telegram Bot Token，另用密碼管理器產生隨機 Webhook Secret；不要把它們寫入設定檔或命令列參數。

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

最後一步會隱藏輸入 Bot Token 與同一個 Webhook Secret，向 Telegram 註冊 `/webhook`、`/start` 命令及選單。用實際 Worker 網址取代範例；正式網址變更後需重新註冊 Webhook。正式 Secret 應保存在 Cloudflare，不要提交 `.dev.vars`、`wrangler.jsonc`、資料庫匯出或日誌。

### 使用與驗證

Telegram 私聊 `/start` 顯示最近的有效快照；`/status` 同步並顯示總覽，`/list` 顯示設備，`/device ID` 顯示詳情。總覽和設備列表每頁顯示 10 台，可用按鈕翻頁。只有 `ADMIN_USER_ID` 可操作。Worker 每分鐘同步；連續兩次有效離線觀察、且至少相隔 60 秒，才確認離線。短暫 API 故障不會把設備判成離線；符合 `HIDDEN_TAGS` 的設備會隱藏。

此外，Bot 會在有效設備快照中斷至少 5 分鐘及恢復時通知，並通知可見設備首次加入或從 API 清單消失。若 API 提供設備金鑰到期時間，會在到期前 7 天內提醒一次；金鑰更新後可再次提醒。首次建立設備清單不發新增通知。這些通知依賴 Worker 排程、D1 與 Telegram，不能在 Worker 本身停止運作時即時告警。

同步完成後優先發送離線／恢復通知，再處理輔助提醒與清理；時間格式器會重用以降低排程 CPU 開銷。排程中斷、API 故障或 Telegram 限流仍可能延遲通知。遇到延遲時，對照 D1 `notification_outbox` 的 `created_at`／`sent_at` 與 Worker 日誌；「最後在線」不是通知建立時間。

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` 只證明 Worker 可回應；還需在 Bot 查看最新同步。D1 會保存設備名稱、標籤、Tailscale IP、公開端點 IP、狀態與時間；只有啟用 `GEOIP_ENABLED` 時，公開端點 IP 才可能傳給 Country.is 推斷國旗。Bot 畫面不顯示 IP，但這不是匿名監控工具。通知與詳細頁使用 `TIME_ZONE`（預設 `UTC`）格式化時間，UTC 位移依日期顯示；無效時區回退至預設值。離線通知只顯示「最後在線」，恢復通知只顯示「恢復時間」；不顯示離線確認時間或恢復前的最後上線時間。

<a id="ja"></a>
## 日本語

**自前サーバー不要：** Cloudflare Workers と D1 にデプロイし、Webhook と定期同期を Worker が処理します。常時稼働するサーバーの構築・保守は不要です。Cloudflare、Telegram、Tailscale の認証情報は別途必要です。

### AI ノーコードデプロイ用プロンプト

```text
この GitHub repository をそのままデプロイできるプロジェクトとして扱い、プログラミング経験のない私が Telegram サーバー監視 Bot を実際に使える状態にするまで手伝ってください。コードの解説や改修が目的ではありません。まず README、wrangler.jsonc.example、付属スクリプトを読み、次の順に進めてください。Node.js・pnpm・Cloudflare・Telegram・Tailscale の利用準備を確認し、Telegram Bot と管理者の数字の User ID を取得し、devices:core:read だけを許可した Tailscale OAuth Client を作成し、Cloudflare にログインして D1 を作成します。Git 対象外の wrangler.jsonc を例から作り、D1 ID と BOT_LANGUAGE、TIME_ZONE、BOT_TITLE、HIDDEN_TAGS、GEOIP_ENABLED を設定してください（GeoIP を有効にすると公開エンドポイント IP が Country.is に送られます）。最初に pnpm check と Wrangler dry-run を実行し、次に migration を適用します。BOT_TOKEN、WEBHOOK_SECRET、TAILSCALE_CLIENT_ID、TAILSCALE_CLIENT_SECRET の 4 つを Wrangler secrets に安全に入力し、本番 deploy を実行してから付属スクリプトで Telegram webhook を登録します。操作できる手順は実行し、ログイン・資格情報作成・管理画面操作が必要なときは正確な画面と次の操作を示して私の完了を待ってください。必要な不足情報だけを質問し、秘密値をチャット、Git、ログ、公開ファイルに載せないでください。Tailscale のコントロールプレーン接続をポートやサービスの稼働確認と混同しないでください。Worker の /health、Telegram の個人チャットで /start、D1 の最新同期と通知状態を実際に確認し、未確認の項目があればデプロイ成功と断言しないでください。デプロイを妨げる実際のバグがない限りソースコードは変更しないでください。
```

Telegram で状態を確認し、通知を受け取るサーバー監視 Bot です。Cloudflare Worker、D1、Tailscale Devices API を使って Tailnet の端末がコントロールプレーンに接続しているかを監視します。**ポートやアプリケーションの稼働確認ではありません。**

README、AI プロンプト、Bot の画面と通知は中国語・日本語・英語に対応します。Worker の `BOT_LANGUAGE` で指定し、既定値は `zh` です。

ライセンス：本プロジェクトは [GNU GPL v3.0（このバージョンのみ）](LICENSE) です。Copyright (C) 2026 kk311intl。

### 要件と設定

`BOT_TITLE` が空なら、概要の見出しは `BOT_LANGUAGE` に合わせて表示されます。タイムゾーンは既定で UTC であり、IANA 名で変更できます。

Node.js 22.13+、pnpm 11+、Cloudflare Workers/D1、Telegram Bot、`devices:core:read` のみを許可した Tailscale OAuth クライアントが必要です。Webhook 登録スクリプトには PowerShell 7 を使います。OAuth Client Secret は Tailscale の Auth key ではありません。

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

返された D1 の `database_id` を Git 対象外の `wrangler.jsonc` に入力し、`ADMIN_USER_ID` を自分の Telegram ユーザー ID（数字）に変更します。Worker 名とデータベース名は変更できます。`OFFLINE_AFTER` は既定で `2`（2～10）、`BOT_LANGUAGE` は `zh`・`ja`・`en` から選択（既定 `zh`）、`TIME_ZONE` は既定で `UTC`（IANA タイムゾーン名）、`TAILSCALE_TAILNET` は既定で `-` なので通常は追加設定不要です。`BOT_TITLE` は概要タイトル、`HIDDEN_TAGS` は非表示にする完全な Tailscale タグ名のカンマ区切り（例：`tag:personal,tag:lab`、空なら非表示なし）、`GEOIP_ENABLED` は既定で `false`（`true` の場合のみ国旗を検索）です。

後で `BOT_LANGUAGE` を変更した場合、Webhook 登録スクリプトを再実行して Telegram の `/start` コマンド説明も更新してください。

Tailscale Admin Console で Devices → Core → Read の OAuth クライアントを作成します。Telegram Bot Token を用意し、パスワードマネージャーでランダムな Webhook Secret を生成してください。設定ファイルやコマンド引数に秘密値を書かないでください。

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

最後の手順では Bot Token と同じ Webhook Secret を非表示で入力し、`/webhook`、`/start`、Telegram メニューを登録します。URL を実際の Worker URL に置き換えてください。URL を変えた場合は再登録が必要です。運用用の Secret は Cloudflare に保存し、`.dev.vars`、`wrangler.jsonc`、データベースのエクスポートやログをコミットしないでください。

### 使い方と確認

Telegram の個人チャットで `/start` は有効な最新スナップショット、`/status` は同期と概要、`/list` は端末一覧、`/device ID` は詳細を表示します。概要と端末一覧は 1 ページ 10 台で、ボタンからページを切り替えられます。操作できるのは `ADMIN_USER_ID` のみです。Worker は毎分同期し、60 秒以上離れた有効なオフライン観測が 2 回続くとオフラインと判定します。一時的な API 障害ではオフラインにせず、`HIDDEN_TAGS` に指定した端末を非表示にします。

有効な端末スナップショットが 5 分以上途絶えた場合と復旧時、表示対象の端末が API の一覧に追加・削除された場合にも通知します。API にキーの有効期限がある端末は、期限前 7 日以内に一度通知し、キー更新後は再通知できます。初回の端末一覧作成では追加通知を送りません。これらの通知は Worker のスケジュール、D1、Telegram に依存するため、Worker 自体が停止した場合の即時警報にはなりません。

同期後はオフライン／復旧通知を優先し、補助通知とクリーンアップを後で処理します。日時フォーマッターを再利用して定期処理の CPU 使用量を減らします。スケジュールの中断、API 障害、Telegram のレート制限で通知が遅れる場合は、D1 の `notification_outbox` の `created_at`／`sent_at` と Worker ログを確認してください。最終オンライン時刻は通知の作成時刻ではありません。

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` は Worker の応答だけを確認します。Bot 側でも最新の同期を確認してください。D1 には端末名、タグ、Tailscale IP、公開エンドポイント IP、状態と時刻が保存され、`GEOIP_ENABLED` を有効にした場合のみ、国旗の判定に公開エンドポイント IP を Country.is へ送ることがあります。Bot の画面では IP を隠しますが、匿名監視ツールではありません。通知と詳細画面の時刻は `TIME_ZONE`（既定 `UTC`）で表示し、UTC オフセットは日付に合わせて変わります。無効なタイムゾーンは既定値に戻します。オフライン通知には最終オンライン時刻のみ、復旧通知には復旧時刻のみを表示します。オフライン確認時刻と復旧前の最終接続時刻は表示しません。

<a id="en"></a>
## English

**No server to maintain:** Deploy on Cloudflare Workers and D1. The Worker handles Telegram webhooks and scheduled sync, so no always-on server is needed. Cloudflare, Telegram, and Tailscale credentials are still required.

### AI no-code deployment prompt

```text
Treat this GitHub repository as a ready-to-deploy project. Help me, a non-coder, get this Telegram server-monitoring bot actually running; this is a deployment task, not a request for code explanation or feature development. Read the README, wrangler.jsonc.example, and included scripts first. Then guide or perform each step: check Node.js, pnpm, Cloudflare, Telegram, and Tailscale access; create a Telegram bot and find my numeric admin User ID; create a Tailscale OAuth client limited to devices:core:read; log in to Cloudflare and create D1; copy the example to an ignored wrangler.jsonc and fill in the D1 ID and deployment settings BOT_LANGUAGE, TIME_ZONE, BOT_TITLE, HIDDEN_TAGS, and GEOIP_ENABLED (enabling GeoIP sends public endpoint IPs to Country.is); run pnpm check and a Wrangler dry-run before applying the D1 migration; securely enter the four Wrangler secrets BOT_TOKEN, WEBHOOK_SECRET, TAILSCALE_CLIENT_ID, and TAILSCALE_CLIENT_SECRET; run the production deploy and the included Telegram webhook-registration script. Perform steps you can access directly. For account sign-in, credential creation, or dashboard-only steps, tell me exactly where to click and what to do, then wait for me. Ask only for missing essentials; collect secrets through secure prompts or dashboards, never chat, Git, logs, or public files. Do not call Tailscale control-plane connectivity a port or application-health check. Verify the Worker /health endpoint, Telegram /start in a private chat, and recent D1 sync and notification state. Clearly identify anything unverified; do not claim deployment succeeded until checks pass. Do not change source code unless an actual bug blocks deployment.
```

A Telegram bot for viewing server status and receiving alerts. It uses a Cloudflare Worker, D1, and the Tailscale Devices API to watch whether Tailnet devices are connected to the control plane. **It does not check ports or application health.**

The README, AI prompts, bot UI, and alerts support Chinese, Japanese, and English. Set `BOT_LANGUAGE` in the Worker configuration; the default is `zh`.

License: This project is licensed under [GNU GPL v3.0 only](LICENSE). Copyright (C) 2026 kk311intl.

### Requirements and setup

When `BOT_TITLE` is empty, the dashboard title follows `BOT_LANGUAGE`. The default time zone is UTC; set another IANA zone if needed.

You need Node.js 22.13+, pnpm 11+, Cloudflare Workers/D1, a Telegram bot, and a Tailscale OAuth client with only `devices:core:read`. The webhook registration script requires PowerShell 7. An OAuth client secret is not a Tailscale auth key.

```powershell
pnpm install --frozen-lockfile
Copy-Item wrangler.jsonc.example wrangler.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create tailscale-server-monitor
```

Put the returned D1 `database_id` in the ignored `wrangler.jsonc` and replace `ADMIN_USER_ID` with your numeric Telegram user ID. You may change the Worker and database names. `OFFLINE_AFTER` defaults to `2` (range 2–10); `BOT_LANGUAGE` accepts `zh`, `ja`, or `en` (default `zh`); `TIME_ZONE` defaults to `UTC` and accepts an IANA time zone; `TAILSCALE_TAILNET` defaults to `-` and usually needs no setting. `BOT_TITLE` sets the dashboard heading. `HIDDEN_TAGS` lists exact Tailscale tag names to hide, separated by commas (for example, `tag:personal,tag:lab`); leave it empty to hide none. `GEOIP_ENABLED` defaults to `false`; set it to `true` for country flags.

If you change `BOT_LANGUAGE` later, rerun the webhook registration script to update Telegram's `/start` command description.

Create a Tailscale OAuth client under Devices → Core → Read. Obtain a Telegram Bot Token and generate a random webhook secret in a password manager. Do not put these values in config files or command arguments.

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

The last step securely prompts for the Bot Token and the same webhook secret, then registers `/webhook`, `/start`, and the Telegram menu. Replace the example with your actual Worker URL; register the webhook again if the URL changes. Keep production secrets in Cloudflare. Never commit `.dev.vars`, `wrangler.jsonc`, database exports, or logs.

### Usage and verification

In a private Telegram chat, `/start` shows the latest valid snapshot, `/status` syncs and shows the overview, `/list` shows devices, and `/device ID` shows details. The overview and device list show ten devices per page, with buttons to change pages. Only `ADMIN_USER_ID` can operate the bot. The Worker syncs each minute; it confirms offline status after two valid offline observations at least 60 seconds apart. Temporary API failures do not mark devices offline, and devices matching `HIDDEN_TAGS` are hidden.

The bot also alerts when valid device snapshots stop for at least five minutes and when sync recovers, or when a visible device appears in or disappears from the API list. If the API supplies a device key expiry, it alerts once within seven days of expiry and can alert again after a key change. The initial inventory does not generate new-device alerts. These alerts depend on the Worker schedule, D1, and Telegram; they cannot provide an immediate warning if the Worker itself stops running.

After syncing, offline/recovery notifications run before auxiliary alerts and cleanup. Date formatters are reused to reduce scheduled CPU usage. Interrupted schedules, API outages, or Telegram rate limits can still delay delivery. Compare `created_at`/`sent_at` in D1's `notification_outbox` with Worker logs when investigating delays; the last-online timestamp is not the notification creation time.

```powershell
Invoke-RestMethod https://YOUR_WORKER.workers.dev/health
```

`/health` only confirms that the Worker responds; check the latest sync in the bot as well. D1 stores device names, tags, Tailscale IPs, public endpoint IPs, status, and timestamps; only when `GEOIP_ENABLED` is enabled may public endpoint IPs be sent to Country.is for flag lookup. IPs are hidden in the bot UI, but this is not an anonymous monitoring tool. Notifications and device details use `TIME_ZONE` (default `UTC`), with the UTC offset calculated for each date; invalid time zones fall back to the default. Offline alerts show only the last online time; recovery alerts show only the recovery time. The offline confirmation time and prior last-online time are not displayed.
