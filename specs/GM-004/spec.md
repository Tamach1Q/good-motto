# GM-004 — Slack OIDC認証

対応Issue: #4 のうちGM-004のみ（PRは `Refs #4`。`Closes` にしない）
PRの宛先: `feat/4-backend-api`（`main` へは全タスク完了後に別途PRを作る）
前提: GM-001〜GM-003はマージ済み。GM-005は別タスク。本タスクでは着手しない。

## なぜ作るか

今のAPIはモックログインでしか使えず、開発モード以外は全APIが503を返す。投稿者を偽装できない形で確認できなければ、学校の実データを扱えない。

GM-004の目的は、**学校の単一Slackワークスペースの本人だけがログインでき、そのセッションで全APIが動く状態を作ること**。モック認証は、これまでどおりローカルだけに閉じ込める。

実装の正は `docs/auth/slack-oidc-v1.md`。この仕様はそれを前提に、モードの切り替えと完了の判定基準を定める。

## 読むもの（この順で優先）

1. `docs/auth/slack-oidc-v1.md`（§3〜§6、§8、§9 はすべて満たす）
2. `docs/api/contract-v1.md`
3. `CONTRIBUTING.md`（特に §1 モック、§3 PR記載事項、§6 秘密情報）
4. `backend/README.md`

## 範囲に含めるもの

- `GET /auth/slack/login` と `GET /auth/slack/callback` の実装
- `sessions` と `oauth_states` のマイグレーション、D1セッション
- 下記のモード切り替え（開発モード以外でAPIが動くようになる）
- `backend/test/gemini.test.js` の改名（G節）

## 範囲に含めないもの

- 実際のSlackへの接続。Slack Appの作成、実在のワークスペースIDの使用はしない
- デプロイ、本番D1の作成、`--remote` の実行、本番Secretの設定
- Slack Botの権限、DM送信、週次ジョブ、Cron（GM-005とSlack担当）
- 退会者の即時無効化、規約撤回、アカウント削除の手順（認証設計 §3・§4 のとおり運用前に別途決める）
- ログイン失敗時のWeb画面。callbackのエラーは認証設計どおり401/403の共通エラーJSONで返す
- PR #7・#8のマージ、`frontend/`・M5Stack・`backend/src/jobs/`・`backend/src/slack/` の変更

## 受け入れ条件

### A. モード

| `ENV` | ホスト | 動作 |
| --- | --- | --- |
| `development` | ループバック | モックログイン。Slackへ接続しない |
| `development` | それ以外 | 全API 503 |
| `production` または `staging` | 問わない | 実OIDC。必須設定がそろっていれば全APIが動く |
| 未設定・それ以外 | 問わない | 全API 503 |

- [ ] 実OIDCの必須設定は `SLACK_CLIENT_ID`、`SLACK_CLIENT_SECRET`、`SLACK_REDIRECT_URI`、`ALLOWED_SLACK_TEAM_ID`、`ALLOWED_ORIGIN`、D1。**どれかが欠けたら全API 503**（テスト必須）
- [ ] `production` と `staging` では、`mock_user` を指定してもモックのセッションを発行しない。固定データも返さない（テスト必須）
- [ ] `production` と `staging` の `analyze` は、Gemini設定が両方あればGeminiを呼び、それ以外は503。固定応答を返さない。開発モードの動作はGM-003から変えない
- [ ] `GET /places/{id}/counts` はどのモードでもBearerキーで認証し、ユーザーセッションを要求しない
- [ ] 開発モードの既存の受け入れ条件（`mock_user`、シード未投入時の503など）を維持する

### B. ログイン開始 `GET /auth/slack/login`

- [ ] `https://slack.com/openid/connect/authorize` へ302する。パラメータは `response_type=code`、`scope=openid profile`、`client_id`、`state`、`nonce`、`redirect_uri`、`team`。`email` を要求しない
- [ ] `state` と `nonce` は暗号学的乱数で毎回生成する
- [ ] `oauth_states` に `state` のハッシュ、`nonce`、10分後の期限を保存する。`state` の生の値をD1に保存しない
- [ ] 開始元のブラウザに結びつける短命Cookieを発行する。属性は `HttpOnly; Secure; SameSite=Lax; Path=/`、`Domain` なし、10分

### C. コールバック `GET /auth/slack/callback`

検証の順番と結果は次のとおり。どれかに失敗したらセッションを発行しない。

| 状況 | 結果 |
| --- | --- |
| `state` がない・Cookieと不一致・未知・期限切れ・使用済み | 401 |
| Slackが `error` を返した（ユーザーの拒否を含む） | 401 |
| `code` がない、Slackのトークン交換が `ok:false` | 401 |
| Slackへの通信失敗、10秒以内に応答なし、5xx | 503 |
| IDトークンの署名、`iss`、`aud`、`exp`、`nonce`、`sub` の検証に失敗 | 401 |
| ワークスペースIDが `ALLOWED_SLACK_TEAM_ID` と不一致 | 403。`people` に行を作らない |
| 成功 | セッションを発行し、相対パスの `Location: /` へ302 |

- [ ] `oauth_states` の行は**原子的に一度だけ消費する**。同じ `state` の2回目は401（同時実行もテスト）
- [ ] トークン交換はサーバーから `https://slack.com/api/openid.connect.token` へ送り、`client_secret` をブラウザへ渡さない
- [ ] IDトークンはSlackのJWKS（`https://slack.com/openid/connect/keys`）で署名を検証する。`alg:none`、HS256、別の鍵で署名したトークンを拒否する。**デコードだけは禁止**（テスト必須）
- [ ] ワークスペースは `https://slack.com/team_id` の値だけで判定する。`team` リダイレクトパラメータを信用しない（テスト必須）
- [ ] 表示名はIDトークンの `name` を使う。なければ `openid.connect.userInfo` で取得し、そのときは `sub`、ユーザーID、チームIDがIDトークンと一致することを確認する。不一致や取得不能は401
- [ ] Slackのアクセストークンを保存せず、ログ、応答、画面に出さない

### D. 人物

- [ ] `(slack_team_id, slack_user_id)` で `people` を取得し、なければ新しいUUIDで作る。作成は原子的に行い、同時ログインでも1行だけ（テスト必須）
- [ ] 新規は `feedback_opt_in=0`、`terms_accepted_at=NULL`
- [ ] 既存の人物はログインのたびに `display_name` を更新する。同意の値は変えない。`id` は変わらない
- [ ] メールアドレスを取得しない、保存しない

### E. セッション

- [ ] モードによらず、同じD1セッションの仕組みを使う。モックログインはSlackとのやり取りだけを置き換える
- [ ] トークンは256ビット以上の暗号学的乱数。`sessions` にはSHA-256ハッシュだけを保存し、生の値がD1にないことをテストする
- [ ] Cookieは `__Host-gm_session; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`、`Domain` なし（`production` モードで文字列を確認する）
- [ ] 期限切れ、存在しない、人物が消えたセッションは401
- [ ] 実OIDCモードでは、セッションの人物の `slack_team_id` が現在の `ALLOWED_SLACK_TEAM_ID` と違えば403（設定変更後の古いセッションへの対策）
- [ ] ログアウトでD1の行を削除してCookieを消す。以後そのCookieは401
- [ ] 期限切れの `oauth_states` と `sessions` は、ログイン開始時に削除する（Cronに依存しない）
- [ ] D1セッションへの変更で「再起動後は旧セッションが401」は成り立たなくなる。該当するテストと `backend/README.md` を更新し、PRに理由を書く

### F. 認可（`production` モードでも確認する）

認証設計 §8 の確認項目を、モックのSlackに対する自動テストで満たす。

- [ ] 許可ワークスペースでログインし、`/me` が200
- [ ] 別のワークスペースは403
- [ ] `state` 不一致、`nonce` 不一致、改ざんJWT、期限切れJWTを拒否
- [ ] 未ログインの投稿は401、ログイン済みでも利用同意なしは403
- [ ] 投稿者IDの偽装が無視または拒否され、保存される `author_person_id` はセッション本人
- [ ] `/people` は同じワークスペースの同意済みの人だけ
- [ ] 受信拒否後は検索に出ず、人物宛ての新規投稿は403
- [ ] 変更系APIはOrigin不一致で403（`production` モードでも）
- [ ] モック認証がデプロイ環境で使えない

### G. テストファイルの改名（GM-003の積み残し）

- [ ] `backend/test/gemini.test.js` を `backend/test/gemini.test.mjs` に改名する。今のままでは、PR #7 の手順（`node --test backend/test/*.test.js`、依存のインストールなし）がMiniflareの読み込みで失敗する
- [ ] `backend/test/` に、依存が必要な `.test.js` を追加しない。追加するテストは `.test.mjs` にする
- [ ] `backend/package.json` の `npm test` では引き続き全テストが実行される

### H. 共通

- [ ] GM-001〜GM-003の受け入れ条件を維持する。既存テストを弱めない（変更する場合はPRに理由を書く）
- [ ] 架空の人物名、存在しないワークスペースID・Slack IDだけを使う。テスト用の鍵はテスト内で生成し、コミットしない
- [ ] `SLACK_CLIENT_SECRET`、IDトークン、認可コード、アクセストークン、セッショントークンをログに出さない。投稿本文も同様（テスト必須）
- [ ] `backend/README.md` に、モードの表、必須の環境変数、実接続の前に必要なもの（学校のSlack管理者の承認、Slack App、ワークスペースID、公開HTTPS URL、本番D1）と、**実Slackでは未検証であること**を書く

### I. 検証

- [ ] Slackへの通信はすべてモックする。テストは実Secret、外部通信（依存の取得を除く）、Cloudflareへのログインを必要としない
- [ ] 新しいチェックアウトで、リポジトリ直下の `npm run ci` だけで依存のインストールとテストが完了する。GitHub Actionsの `test` ジョブも成功する
- [ ] ローカルの `wrangler dev` を開発モードで起動し、ログイン→`/me`→投稿→ログアウト→401と、再起動後もセッションが有効なことをHTTPで確認し、結果をPRに書く
- [ ] PR本文に CONTRIBUTING §3 の6項目と、実行したテストコマンド・結果を書く。**実際のSlackでは未検証であること**を「何をしていないか」に明記する

## API契約について

このタスクで契約の変更は不要。エンドポイント名、HTTPメソッド、JSON形式を変えない。実装者は契約を変更しない。契約または認証設計とこの仕様が食い違う場合は実装を進めず、PRに食い違いを書く。
