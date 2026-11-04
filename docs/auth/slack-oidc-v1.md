# Good/Motto 認証設計 v1 — Slack OpenID Connect（確定仕様）

決定日: 2026-11-04  
責任者: Issue #4（API/DB/AI担当）  
状態: **実装する認証方式を決定。コードは未実装。**  
前提: 利用者は全員、学校の同じSlackワークスペースに所属する。学校のSlack App利用承認が必要な場合は承認を得てから接続する。

## 1. 採用する方式

- フロント: React + TypeScript + Vite。WebとAPIは **同一オリジン**（同一スキーム・ホスト・ポート）のURLから配信する。例: \`https://good-motto.example.com\`（仮のURL）。
- バックエンド: Cloudflare Workers + Hono + D1。
- ログイン: **Sign in with Slack / OpenID Connect / Authorization Code Flow**。
- スコープ: **\`openid profile\`**。メールアドレスはログインに不要なので \`email\` は要求しない。
- Slackログイン用の一時的なトークンは認証の検証にのみ使用し、恒久的にDB保存しない。投稿用APIでSlackアクセストークンを送らない。
- セッション: サーバー発行のランダムな不透明セッショントークンを **HttpOnly Cookie** で返し、D1側にはハッシュのみ保存。
- 利用者の識別: **\`(slack_team_id, slack_user_id)\` の組**。サービス内では別途発行した \`person_id\`（UUID）で参照する。
- ワークスペース制限: 認証結果に含まれる \`https://slack.com/team_id\` をサーバー環境変数 \`ALLOWED_SLACK_TEAM_ID\` と厳密一致させる（\`team\` リダイレクトパラメータを信用しない）。
- Slack DM送信: ログインとは**別のBot権限**。同じSlack Appに対する別のインストール/認可フローで \`chat:write\` を付与し、\`SLACK_BOT_TOKEN\` をWorker Secretで管理する。利用者本人のログイントークンでDMを送らない。

## 2. Slack App設定

1. [Slack API Apps](https://api.slack.com/apps) で「Good Motto」Slack Appを作成し、学校ワークスペースの管理者の許可が必要なら取得する。
2. Basic Informationで \`SLACK_CLIENT_ID\` と \`SLACK_CLIENT_SECRET\` を取得する（シークレットはGitに置かない）。
3. OAuth & Permissionsでログイン用Redirect URLを **\`https://<本番ホスト>/api/v1/auth/slack/callback\`** に登録する。ローカル開発ではモック認証を使い、実OAuthは公開済みテスト用HTTPS URLで検証する。
4. Sign in with Slackの認証に \`openid profile\` を要求する。
5. 週次Bot用には \`chat:write\` を付与してワークスペースにインストールし、Bot Tokenを発行する。ログインスコープとBotスコープは**同じ認可リクエストに混ぜない**。
6. Slack側ワークスペースID（\`T...\`）を確認し、\`ALLOWED_SLACK_TEAM_ID\` に設定する。

参照:
- https://docs.slack.dev/authentication/sign-in-with-slack/
- https://docs.slack.dev/reference/methods/openid.connect.token/
- https://docs.slack.dev/reference/methods/openid.connect.userInfo/
- https://docs.slack.dev/reference/methods/chat.postMessage/

## 3. 実装するエンドポイント（同一オリジン）

| HTTP | パス | 用途 | 認証 |
|---|---|---|---|
| GET | \`/api/v1/auth/slack/login\` | OIDC認可開始、Slackへ302リダイレクト | 不要 |
| GET | \`/api/v1/auth/slack/callback\` | 認可コード交換、IDトークン検証、セッション発行 | OIDC state |
| GET | \`/api/v1/me\` | ログイン本人・同意状態の取得 | ユーザーCookie |
| PATCH | \`/api/v1/me/preferences\` | 本人による利用同意・DM受信設定 | ユーザーCookie |
| POST | \`/api/v1/auth/logout\` | セッション失効とCookie削除 | ユーザーCookie |
| GET | \`/api/v1/people?query=...\` | 送信対象の検索。**DM受信に同意した人物のみ** | ユーザーCookie |
| POST | \`/api/v1/posts/analyze\` | Geminiによる分類（本人確認済み投稿者） | ユーザーCookie＋利用同意 |
| POST | \`/api/v1/posts\` | 投稿の保存（本人が分類・対象IDを確定） | ユーザーCookie＋利用同意 |

既存の \`GET /api/v1/places\` はユーザーCookieが必要。M5Stackの \`GET /api/v1/places/{id}/counts\` は**別の読み取り専用デバイス資格情報**を使い、Slackセッションを要求しない。Slack週次バッチは内部Cronであり外部公開しない。

### GET /api/v1/me — Response (200)

\`\`\`json
{
  "person_id": "00000000-0000-4000-8000-000000000001",
  "display_name": "田中",
  "terms_accepted": true,
  "feedback_opt_in": false
}
\`\`\`

未ログインの場合はHTTP 401 + 共通エラーJSON。

### PATCH /api/v1/me/preferences

利用開始時に本人が投稿内容の扱いに明示同意する。別に、受信者としてフィードバック対象になるかを選ぶ。

Request:

\`\`\`json
{
  "terms_accepted": true,
  "feedback_opt_in": true
}
\`\`\`

Response: \`GET /api/v1/me\` と同じ形式。  
\`feedback_opt_in=false\` へいつでも変更できる。 \`terms_accepted=true\` は同意した時刻を記録する。規約撤回・アカウント削除は別途運用手順を実装する。

## 4. OIDCログインの内部処理（バックエンド担当）

1. \`/auth/slack/login\` で安全な乱数を使って \`state\` と \`nonce\` を作る。D1に有効期限10分の一時レコードを保持し、ブラウザに \`state\` にひもづく \`HttpOnly; Secure; SameSite=Lax\` の短命Cookieを設定して認可の開始元を結びつける。
2. Slack \`https://slack.com/openid/connect/authorize\` へ \`response_type=code\`, \`scope=openid profile\`, \`client_id\`, \`state\`, \`nonce\`, \`redirect_uri\`, \`team\` を渡してリダイレクトする。 \`team\` はユーザー体験のためのヒントであり、セキュリティ判定には使わない。
3. Slack callbackで \`state\` とCookieの結合・期限・再利用なしを検証し、レコードを**一度だけ消費**する。拒否・不一致・期限切れなら401/403で終了する。
4. 認可コードをサーバーから \`POST https://slack.com/api/openid.connect.token\` に送る（\`client_id\`, \`client_secret\`, \`code\`, \`redirect_uri\`, \`grant_type=authorization_code\`）。
5. IDトークンを**署名検証**する（推奨: \`jose\` + Slack公式JWKS \`https://slack.com/openid/connect/keys\`）。\`iss=https://slack.com\`, \`aud=SLACK_CLIENT_ID\`, \`exp\`、署名、\`nonce\`、\`sub\` を検証する。**単にJWTをdecodeするだけは禁止**。
6. 必要に応じて \`openid.connect.userInfo\` で表示名とSlack user/team IDを取得。IDトークンとuserInfoで識別子が一致しているかも確認。
7. **\`team_id === ALLOWED_SLACK_TEAM_ID\` を必須**とし、Slackの \`user_id\` とワークスペースIDでD1の \`people\` を取得、未登録なら新しいUUIDで作成（DM受信は初期値false）。
8. 暗号学的乱数（256bit以上）でセッション文字列を発行。SHA-256ハッシュだけD1の \`sessions\` に保存し、元のトークンをCookie \`__Host-gm_session\` に設定。Cookie設定: \`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800\`（7日）、Domain属性は**設定しない**。
9. アクセストークンなどの秘密値をログ・DB・画面に残さず、フロントの \`/\` にリダイレクトする。
10. 各APIリクエストではCookieのトークンをハッシュ化してD1に照会し、有効期限/ユーザー状態を検証する。失効・期限切れは401。ログアウト時はD1のセッションを削除しCookieを消す。

保護事項:
- Cookie認証を使う**全ての状態変更API**で信頼できる \`Origin\` の一致を検証する。HonoのCSRF middlewareに加え、\`application/json\` のAPIも対象となる検証を入れる。
- CORSを安易に \`*\` としない。WebとAPIは同一オリジンから提供。
- Slack IDトークン・OAuth認可コードをブラウザのlocalStorageに保存しない。
- 開発用モック認証は \`ENV=development\` の**ローカル環境のみ**。デプロイ環境では有効化できないようにする。
- セッションが残っていてもSlackワークスペースから削除された人は即時検知できない場合がある。PoCではセッション上限7日、運用前に退会者の無効化方法を決める。

## 5. D1スキーマ（設計上の必須カラム）

実際のSQL migrationはIssue #4で作成する。以下のカラムと一意制約を保持すること。

\`\`\`sql
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  terms_accepted_at INTEGER,
  feedback_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (feedback_opt_in IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE (slack_team_id, slack_user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- posts は既存API契約どおり。投稿者はクライアントから受け取らない。
-- posts.author_person_id は認証済みセッションからサーバーが決める。
-- posts.target_type='person' のとき posts.target_id は people.id として検証する。
\`\`\`

\`token_hash\` はランダムなセッショントークンをSHA-256した値。 \`oauth_states\` は一度使ったら削除し、期限切れレコードを定期削除する。

## 6. 人物を間違えずに特定する

- Geminiが \`「田中さん」\` を検出しても人物IDを確定しない（\`target_id=null\` にしてよい）。
- ユーザーが候補検索から選び、選択した \`people.id\` を \`POST /api/v1/posts\` に送る。
- \`GET /api/v1/people\` は **同じ許可ワークスペースに所属し、\`feedback_opt_in=true\` で、検索可能な対象**のみを返す。
- サーバー側で「有効な対象ID」「同意済み」「ログイン投稿者」の条件を検証する。フロントの表示だけに頼らない。
- DM送信先はその人物の \`slack_user_id\`。名前・メールアドレスの一致で宛先を決めない。
- 人へのGood/Mottoは、対象者が受信を撤回したら以後の週次DMに含めず、新規の人物対象投稿も受付しない。

## 7. Slack週次処理との境界

- Issue #4: 認証、\`people\`、セッション、人物候補検索、DM同意、\`posts.author_person_id\`、Slack ID連携まで。
- Issue #2: Slack Botインストール/権限、週次Cron、独立した投稿者数チェック、Gemini要約、\`chat.postMessage\` と重複防止。BotトークンはサーバーのSecretに保持する。
- 週次処理は \`feedback_opt_in=true\` の受信者だけを対象にする。受信対象・同意・少人数再識別リスクの検証が終わるまでは実DM送信禁止。
- 最初は架空のユーザー・投稿・Slack IDのモックで開発する。

## 8. 確認テスト（Issue #4 / #3）

- [ ] 許可された学校Slackワークスペースでログイン→ \`GET /api/v1/me\` が200
- [ ] 別のワークスペースのユーザーなら403
- [ ] state不一致、nonce不一致、改ざんJWT、期限切れJWTは拒否
- [ ] 未ログインの投稿は401、ログイン済でも利用同意なしは403
- [ ] 投稿者IDをリクエストで偽装してもサーバーは無視/拒否
- [ ] \`GET /api/v1/people\` には対象として同意済みの人だけ表示
- [ ] DM受信拒否後は本人が対象として検索されず、DMも送られない
- [ ] \`__Host-gm_session\` はHttpOnly/Secure/SameSite=Lax、期限切れ・ログアウト後は利用不可
- [ ] モック認証がデプロイ環境で使えない

## 9. 設定変数

\`\`\`text
# Worker Secret（Gitコミット禁止）
SLACK_CLIENT_SECRET=...
SLACK_BOT_TOKEN=...
GEMINI_API_KEY=...

# 環境変数（値は環境ごとに設定）
SLACK_CLIENT_ID=...
ALLOWED_SLACK_TEAM_ID=...
SLACK_REDIRECT_URI=https://<ホスト>/api/v1/auth/slack/callback
GEMINI_MODEL=...
\`\`\`

**未完了の外部依存**: 学校のSlack管理者によるSlack App承認/インストール、実際の学校ワークスペースID、公開URL（HTTPS）の確定。設計はこれらが未確定でもモックで着手可能。

## 参考（公式）

- Slack Sign in with Slack: https://docs.slack.dev/authentication/sign-in-with-slack/
- Slack OIDC discovery: https://slack.com/.well-known/openid-configuration
- Slack openid.connect.userInfo: https://docs.slack.dev/reference/methods/openid.connect.userInfo/
- Slack Bot DM: https://docs.slack.dev/reference/methods/chat.postMessage/
- Hono cookies: https://hono.dev/docs/helpers/cookie
- Hono CSRF: https://hono.dev/docs/middleware/builtin/csrf
