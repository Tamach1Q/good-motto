# Good/Motto — Cloudflare Staging接続手順

対象: `develop` に統合されたWeb、Backend、D1、Slack週次バッチ（Cron）、M5Stack件数API。

## 現状と安全上の前提

- Staging Worker名: `good-motto-staging`、予定URL: `https://good-motto-staging.tamach1q.workers.dev`。
- すべてのAPIとWebの静的アセットを同一Originで配信。APIは `/api/*` をWorkerが処理する。
- Slack週次処理は `backend/src/index.mjs` の `scheduled` に接続済み。Cronは毎週月曜09:00 JST。
- `DIGEST_MODE=dry-run` がStagingの既定値。**実DMは送らない**。Bot Tokenが登録されていれば週次処理開始時に `auth.test` だけ実行し、ワークスペース一致をログに記録する。
- `backend/wrangler.jsonc` のStaging D1 `database_id` は**未設定の全ゼロプレースホルダー**。実IDへの置換が必要。開発用シード（架空の人物）はリモートDBへ投入しない。
- Secret/Cloudflareアカウント認証はソースに含めない。GitHub Actionsは外部サービスへ通信せず、ユニット・結合テストとDry Runバンドルのみ。

## 一度だけ必要なリソースと設定

Cloudflareの適切なアカウントにログインした環境で実行。Stagingと本番のDBやSecretsを共有しない。

```sh
cd backend
npx wrangler login
npx wrangler d1 create good-motto-staging
```

出力された実際のD1 UUIDを `backend/wrangler.jsonc` の `env.staging.d1_databases[0].database_id` に設定する。
`database_name` は `good-motto-staging`、バインディングは `DB` とする。

Staging用のWorker Secretsは次のキーを用意する。値をGitHubのPRやチャットに貼らない。

| Secret名 | 目的 |
| --- | --- |
| `SLACK_CLIENT_ID` | Slack OIDC Client ID |
| `SLACK_CLIENT_SECRET` | Slack OIDC Client Secret |
| `SLACK_REDIRECT_URI` | `https://good-motto-staging.tamach1q.workers.dev/api/v1/auth/slack/callback` |
| `ALLOWED_SLACK_TEAM_ID` | 学校の許可ワークスペースID |
| `GEMINI_API_KEY` | Gemini APIキー |
| `GEMINI_MODEL` | 使用するGeminiモデル名 |
| `M5_DEVICE_KEY` | M5Stack件数API専用のランダムBearerキー |
| `SLACK_BOT_TOKEN` | 同じ学校Slack AppのBot Token。dry-runでも`auth.test`に使う |

設定コマンドは `backend/` にて、各Secret名について以下のように実行する。値は対話形式で入力する。

```sh
npx wrangler secret put SLACK_CLIENT_ID --env staging
npx wrangler secret put SLACK_CLIENT_SECRET --env staging
npx wrangler secret put SLACK_REDIRECT_URI --env staging
npx wrangler secret put ALLOWED_SLACK_TEAM_ID --env staging
npx wrangler secret put GEMINI_API_KEY --env staging
npx wrangler secret put GEMINI_MODEL --env staging
npx wrangler secret put M5_DEVICE_KEY --env staging
npx wrangler secret put SLACK_BOT_TOKEN --env staging
```

Slack App側で上記Redirect URLをSign in with Slackのリダイレクト先に登録する。権限はOIDC `openid profile`、Bot側は `chat:write`・`im:write`。ワークスペース管理者の許可とインストール状態を確認する。

## Stagingへの公開

リポジトリルートからフロントエンドをliveモードでビルドする。

```sh
npm ci --prefix frontend
npm ci --prefix backend
VITE_API_MODE=live VITE_POST_MAX_CHARACTERS=500 npm run build --prefix frontend
cd backend
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler deploy --env staging
```

`workers_dev` を有効化したStaging環境だけに公開する。デフォルト環境へのdeployは行わない。

## 起動後の確認（秘密情報を表示しない）

1. `/` でReact UIが配信される。
2. ログイン前の `/api/v1/me` は401。同意前の投稿APIが拒否される。
3. `/api/v1/auth/slack/login` はSlackのOpenID認証へ302、CallbackでCookieセッションが発行される。利用同意を保存し、再ログイン・ログアウトまで確認する。
4. `GET /api/v1/places/kitchen/counts` は未認証なら401。専用Bearerキー付きで所定のJSON（7日間・非負の件数）が返る。
5. Gemini分析とD1投稿を、実データを使わず同意したテスターと架空の文章で確認する。個人への投稿は少人数での再識別リスクに注意する。
6. `npx wrangler tail --env staging` でCronの `slack auth.test ok is_bot=true team_match=true` を確認する。ここまでの `DIGEST_MODE` は `dry-run` のまま。認証失敗時はBot Token・権限・ワークスペースの一致を確認する。
7. **実DM送信は別承認**。送信テストを行う場合のみ、同意済みのテスターの `people.id` を `DIGEST_ONLY_PERSON_IDS` に設定し `DIGEST_MODE=live-test` を使う。配信される条件（独立投稿者3名以上、匿名性ガード）を満たす架空データで確認した後、必ず `dry-run` に戻す。実人物の秘密情報を使わない。

GitHub側には `SLACK_BOT_TOKEN` や `GEMINI_API_KEY` を置かない。実DMを試さずにBot疎通だけを調べたい場合は `dry-run` + `auth.test` で十分。

## いま残る作業

- Cloudflareアカウントへのアクセスと実D1 UUIDの取得
- Worker Secrets登録、Slack AppのOIDCリダイレクト登録
- リモートD1マイグレーション、Stagingデプロイ
- Stagingでの実HTTP・OIDC・Bot `auth.test`・Gemini動作確認
- 実DMを行う場合の明示同意・対象ID・再識別リスクの事前評価

これらが未実施の段階では「Staging公開済み」「Bot接続済み」と判断しない。
