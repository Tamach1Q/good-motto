# Slack Bot（Good Motto）

週次ブリーフ（Issue #2）を本人へDMで届けるための Slack Bot の作成手順です。バッチ本体の使い方は [weekly-digest.md](weekly-digest.md) を参照してください。

投稿用のWeb画面はフロント担当（Issue #3、`frontend/`）が実装します。このディレクトリには画面やHTTP APIは含みません。Slack用の公開HTTPエンドポイントは不要で、Cronで動く内部処理だけです。

## Bot の作り方

1. https://api.slack.com/apps を学校Slackのアカウントで開き、**Create New App → From a manifest** を選びます。
2. **学校のワークスペース**を選択します。別のワークスペースを選ばないよう確認してください。
3. JSONタブに、このフォルダの `app-manifest.json` の内容を貼り付け、作成します。
4. **OAuth & Permissions** でBot Token Scopesが `chat:write` と `im:write` の2つになっていることを確認します。
5. **Install to Workspace** からインストールします。学校の設定で承認申請になる場合は管理者の承認後に進みます。
6. **Bot User OAuth Token**（`xoxb-` で始まる値）をコピーし、`cp .env.example .env` で作った `.env` の `SLACK_BOT_TOKEN=` に設定します。ワークスペースID（`T...`）は `ALLOWED_SLACK_TEAM_ID=` に設定します。トークンをGitHubやチャットへ貼らないでください。

DMは通常のBot Tokenで `conversations.open` → `chat.postMessage` を呼んで送ります（`backend/src/slack/client.js`）。Incoming Webhook、Socket Mode、イベントのRequest URLは使いません。権限を変更したらワークスペースへ再インストールしてください。

ログイン用（Sign in with Slack / OIDC）の設定は [認証設計](../auth/slack-oidc-v1.md) を参照してください。Bot のスコープはログイン用の認可リクエストに混ぜません。

本番（Cloudflare Workers）では `SLACK_BOT_TOKEN` を `wrangler secret put` で登録し、Gitにはコミットしません。

## 公式リファレンス

- https://docs.slack.dev/reference/methods/conversations.open/
- https://docs.slack.dev/reference/methods/chat.postMessage/
- https://api.slack.com/apps
