# GM-004: Slack OIDC・D1セッションとローカル開発

Cloudflare Workers + Honoで、[API契約 v1](../docs/api/contract-v1.md)の10エンドポイントを提供します。ベースURLは **`http://127.0.0.1:8787`**、APIのプレフィックスは `/api/v1` です。人物・同意・投稿・送信履歴・セッションをD1に保存します。ローカル開発は架空データのモックログイン、production/stagingは単一Slackワークスペース限定のOIDCログインです。**実際のSlackとの接続は未検証です。** 分析は下記のモードとGemini設定で切り替えます。

## 起動とテスト

Node.js 24（最低22）とnpmを使用します。リポジトリ直下で実行してください。

```sh
npm run ci
npm run db:migrate --prefix backend
npm run db:seed --prefix backend
cp backend/.dev.vars.example backend/.dev.vars
# backend/.dev.vars の M5_DEVICE_KEY を自分のローカル用ランダム値に変更
# 例: openssl rand -hex 32 で生成する。生成値はコミットしない
npm run dev --prefix backend
```

`npm run ci` は `npm ci --prefix backend` で依存をインストールし、`npm test --prefix backend` でテストします。テストはMiniflare/workerdの実D1エンジンを使います（SQLのモックではありません）。テスト自体には外部通信、Cloudflareへのログイン、実Secret、`.dev.vars` は不要です。初回の依存取得にはnpmレジストリへの接続が必要です。テストだけの再実行は次のとおりです。

```sh
npm test --prefix backend
# ローカルD1へmigration/seedを適用し、WranglerのHTTPと再起動を確認（8787番を空ける）
npm run test:smoke --prefix backend
```

| ローカル設定（`backend/.dev.vars`） | 用途 |
| --- | --- |
| `ENV=development` | 完全一致のときだけモックを許可 |
| `ALLOWED_ORIGIN=http://localhost:5173` | 変更系APIで許可する単一のOrigin（ワイルドカード不可） |
| `M5_DEVICE_KEY=<自分で生成したローカル用キー>` | 件数取得だけに使う共通Bearerキー。既定値なし |

`.dev.vars` はGit管理対象外です。コミットするWrangler設定には `ENV` を入れていません。Wranglerはローカル接続で起動し、このタスクではデプロイしません。

## 認証モードとOIDC設定

| `ENV` | URLのホスト | 動作 |
| --- | --- | --- |
| `development` | `localhost` / `127.0.0.1` / `::1` | モックログイン。Slackへの通信なし |
| `development` | その他 | 全API 503 |
| `production` / `staging` | 任意 | 必須設定がすべてあれば実OIDCとD1でAPIを提供 |
| 未設定・その他 | 任意 | 全API 503 |

実OIDCでは次がすべて必須です。一つでも未設定・空なら、ログイン・端末countsを含む全APIが共通エラーJSONの503になります。D1未マイグレーション/故障時も503です。

| 設定 | 用途 |
| --- | --- |
| `SLACK_CLIENT_ID` | Slack AppのクライアントID |
| `SLACK_CLIENT_SECRET` | Worker Secret。ブラウザへ渡さず、Gitに保存しない |
| `SLACK_REDIRECT_URI` | 登録した公開HTTPS URLの `/api/v1/auth/slack/callback` |
| `ALLOWED_SLACK_TEAM_ID` | 許可する学校の単一ワークスペースID |
| `ALLOWED_ORIGIN` | Webの同一オリジンURL。変更系APIで完全一致を検証（`*`不可） |
| `DB` | 全マイグレーションを適用したD1バインディング |

`M5_DEVICE_KEY` はcounts専用の読み取りBearerキーです。countsはユーザーセッションを要求しません。`GEMINI_API_KEY` と `GEMINI_MODEL` は分析用で、実OIDCモードでは両方ないとanalyzeだけが503になります。`mock_user` はproduction/stagingでは無視し、固定の人物・分析結果やモックセッションを返しません。開発用シードはデプロイ環境に投入しないでください。

ログイン開始で毎回256bitのstate/nonceを生成し、stateのSHA-256・nonce・10分期限をD1へ保存します。`__Host-gm_oauth_state` Cookie（HttpOnly/Secure/SameSite=Lax/Path=/、Domainなし、10分）で開始ブラウザと結びつけます。callbackはCookie・stateを検証し、単一の `DELETE ... RETURNING` でstateを一度だけ消費してからコードを交換します。再利用・拒否・code欠落は401です。

`jose`でSlack公式JWKSによるRS256署名、issuer、audience、exp、nonce、subとユーザーIDを検証し、署名済み `https://slack.com/team_id` だけで許可チームを判定します。`team`引数はヒントです。表示名はIDトークンの `name` を使い、ない場合はuserInfoのsub/user/teamの一致も検証します。検証失敗は401、別チームは人物を作らず403です。Slackとの通信失敗・5xx・本文受信を含め10秒のタイムアウトは503、userInfoの拒否や名前/識別子の欠落は401です。秘密値やSlack応答の詳細は共通エラーに含めません。

人物は `(slack_team_id, slack_user_id)` の単一UPSERTで作成・更新します。新規はUUID・利用未同意・受信拒否、既存は表示名だけを更新し、ID・同意時刻・受信設定を維持します。emailスコープを要求せず、メール・Slackアクセストークン・IDトークンを保存しません。

実接続の前に、**学校のSlack管理者の承認、Slack App、学校のワークスペースID、公開HTTPS URL、本番D1**を別途準備する必要があります。実Slack App作成、実ワークスペースIDの利用、本番Secret設定、`--remote`、デプロイは未実施です。Slack退会者の即時無効化、規約撤回、アカウント削除の運用も利用開始前に別途決めてください。セッションだけでは退会を即時検知できません。

## 架空ユーザーとセッション

| ログインURL | 架空人物 | 初期状態 |
| --- | --- | --- |
| `/api/v1/auth/slack/login` または `?mock_user=accepted` | 架空アオ（UUID末尾001） | 利用同意済み、受信同意なし |
| `/api/v1/auth/slack/login?mock_user=pending` | 架空ミドリ（UUID末尾002） | 利用未同意、受信同意なし |

検索・人物宛て投稿用に、利用・受信同意済みの「架空ソラ」（UUID末尾003）も用意しています。人物名・データはすべて架空です。

ローカルモックはloginでセッションを発行して `Location: /` に302します。開発モードのcallbackは従来どおり `/` に302し、交換やセッション発行をしません。OIDCも成功後は同じ相対パス `/` に302します。

全モード共通でセッションはランダム256bit・期限7日、D1の `sessions` にSHA-256ハッシュだけを保存します。再起動・コード再読込後も同じCookieが有効です。メモリ保持だったGM-003から永続化したため、再起動による失効はしません。期限切れ・未知・人物が削除されたセッションは401、実OIDCモードで人物のチームと現在の許可チームが違えば403です。人物設定は毎回D1から読むため、別セッションにも即時反映します。ログアウトはD1の行とCookieを削除して204を返し、古いCookieは401になります。ログイン開始時に期限切れの `sessions` と `oauth_states` を削除し、Cronには依存しません。

Cookieは `__Host-gm_session`、`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`、Domainなしです。ローカル用に属性を緩和する実装はありません。HTTPのループバックでSecure Cookieを受け付けるかはブラウザ依存のため、下記の実ブラウザ確認はGM-005で行います。拒否された場合はブラウザ・Cookie拒否理由を記録し、そのタスクで対処を検討してください。自動テストではログイン応答のCookieを使って `/me` の200を確認しています。

## curl例

まずログイン応答の `Set-Cookie` を取得します。`-L` は付けず、302と相対Locationを確認してください。

```sh
curl -i 'http://127.0.0.1:8787/api/v1/auth/slack/login'
# 未同意ユーザーの確認
curl -i 'http://127.0.0.1:8787/api/v1/auth/slack/login?mock_user=pending'
```

以降の `<セッショントークン>` は、対象のログイン応答にある `__Host-gm_session=` から最初の `;` までの値に置き換えます。Secure CookieをHTTPで自動送信しないcurlでも確認できるよう、Cookieヘッダーを明示しています。

```sh
curl -i -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  http://127.0.0.1:8787/api/v1/me

curl -i -X PATCH -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"terms_accepted":true,"feedback_opt_in":true}' \
  http://127.0.0.1:8787/api/v1/me/preferences

curl -i -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"text":"架空の共用キッチンを片付けてくれて助かった"}' \
  http://127.0.0.1:8787/api/v1/posts/analyze

curl -i -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"text":"架空の共用キッチンを片付けてくれて助かった","sentiment":"good","target_type":"place","target_id":"kitchen"}' \
  http://127.0.0.1:8787/api/v1/posts

curl -i -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  http://127.0.0.1:8787/api/v1/places
curl -i -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  'http://127.0.0.1:8787/api/v1/people?query=%E6%9E%B6%E7%A9%BA'

curl -i -H 'Authorization: Bearer <.dev.varsのM5_DEVICE_KEY>' \
  http://127.0.0.1:8787/api/v1/places/kitchen/counts
curl -i -H 'Authorization: Bearer <.dev.varsのM5_DEVICE_KEY>' \
  http://127.0.0.1:8787/api/v1/places/laundry/counts

curl -i -X POST -H 'Cookie: __Host-gm_session=<セッショントークン>' \
  -H 'Origin: http://localhost:5173' \
  http://127.0.0.1:8787/api/v1/auth/logout
# 同じCookieで再度 /me を呼ぶと401
```

Cookieなし/無効は401、未同意の投稿・許可外/欠落Originは403、不正入力は400、未存在の対象は404です。未定義パスは404、予期しない例外は500、無効なモード・必須設定欠落・D1未設定/未マイグレーション/失敗時は503で、すべて `{"error":{"code":"...","message":"..."}}` を返します。CORSは公開せず、ブラウザからは同一OriginのVite proxyを使います。変更系JSON APIもOrigin検証対象です。Viteの `changeOrigin` によるHostの変更は判定に使いません。

## Web（PR #8）のVite経由確認手順（GM-005で実施）

このPRでは `frontend/` を追加・変更せず、PR #8もマージしません。Webが利用できる結合環境で次を実施してください。

1. 上記手順でAPIを起動し、`ALLOWED_ORIGIN=http://localhost:5173` にする。
2. Webを `VITE_API_MODE=live npm run dev --prefix frontend -- --host localhost --port 5173 --strictPort` で起動する。`/api` のproxy先は `http://127.0.0.1:8787`、`changeOrigin: true`。Webのログイン先は同一Originの `/api/v1/auth/slack/login` を使う。
3. `http://localhost:5173` を開き、未ログインの `/api/v1/me` が401になることを確認する。
4. `http://localhost:5173/api/v1/auth/slack/login` からログインする。302でViteの `/` に戻り、`/me` が200、投稿画面へ進むことを確認する。Cookieの属性とブラウザの拒否理由も確認する。
5. ログアウトし、`http://localhost:5173/api/v1/auth/slack/login?mock_user=pending` で未同意ユーザーへ切り替える。設定画面への分岐、利用同意後の投稿、受信設定の変更と撤回を確認する。
6. 分析の固定結果、投稿201、候補「架空ソラ」、ログアウト後401を確認する。実サービスのユーザー・本文は入力しない。

この手順は未実施です。実ブラウザ、PR #8との結合、実機確認はGM-005の範囲です。

## 実装済みの検証とモックの範囲

実装したのはHTTPルーティング、モード制限、Cookieの発行・失効、Origin検証、利用/受信同意の制御、入力検証、候補の絞り込み、端末キーの分離、共通エラー応答です。

- Gemini設定が両方未指定のローカル開発時だけ、`analyze` は有効な本文すべてに `{"sentiment":"motto","target_type":"place","target_id":"kitchen","target_label":"共用キッチン"}` を返します。人物分類は生成しません。
- `posts` はtrim後の本文、セッション本人のID、サーバーのUTC時刻をD1に保存し、保存行と同じ `post_id` と `status:created` を201で返します。投稿者/日時の持ち込み（`author_person_id`, `author_id`, `person_id`, `user_id`, `created_at`）は400で拒否します。
- 本文は両投稿APIでtrim後のUnicodeコードポイント数1〜500を検証します。絵文字1コードポイントは1文字です。バイト数上限は設けず、投稿本文をログへ出しません。
- 同意済みの `terms_accepted:false` は400（利用同意の撤回は別途運用手順）。未同意のまま受信同意だけtrueにすると403です。
- 件数は `target_type=place` の指定場所だけをSQLで集計します。今日（JST）を含む7暦日で、6日前の00:00 JST以上、集計時刻以下です。`updated_at` は集計時刻のUTC ISO 8601（末尾Z）です。投稿なしの既知の場所は0/0、不明な場所は404です。
- Gemini分類・内部要約モジュールを実装しています。週次ジョブの組み込み・Cron・Slack送信・Web結合（GM-005）、デプロイ、自前のレート制限は含めません。Geminiの429はそのまま共通エラーの429へ対応させます。

API実装は `src/index.mjs` と `src/api/`・`src/auth/`、テストは `test/api.test.mjs`、`test/repository.test.mjs`、`test/gemini.test.mjs`、`test/oidc.test.mjs` に配置しています。Slack通信は全件fetchのモック、署名鍵はテスト実行時に生成し、並行callback/人物作成は実D1で検証します。Miniflare等の依存が必要なテストはすべて `.test.mjs` とし、GM-003のGeminiテストも拡張子を変更しました。PR #7の `src/jobs/`、`src/slack/` や既存テストとファイル名を分け、ルートの `.gitignore` / `.env.example` は使いません。`npm test --prefix backend` は `test/*.test.*` を実行するため、PR #7マージ後はそのテストも対象になります。既存の `node --test backend/test/*.test.js` も維持できる構成です。


## D1のマイグレーションと開発シード

上記の `db:migrate` と `db:seed` は必ずローカルD1に適用します。Cloudflareログインは不要です。バインディングは `DB`、`wrangler.jsonc` の `database_id` は存在しない全ゼロのプレースホルダーです。本番接続には別途、本番D1の作成と実際のID・Secretsの設定が必要です。このタスクでは作成・接続・デプロイしません。

- `migrations/0001_post_data.sql`: `people`、`places`、`posts`、`slack_digest_deliveries` と索引。初期データはkitchen/laundryだけです。マイグレーションだけでは人物と投稿は空です。
- `migrations/0002_auth.sql`: `sessions`、`oauth_states` と期限の索引。すでにGM-003を使っている場合も `db:migrate` を再実行してください。
- `seeds/development.sql`: 架空アオ・ミドリ・ソラと存在しないSlack IDだけの開発専用データ。初期投稿はありません。再投入しても既存の同意・投稿を上書きしません。シード未投入時のモックログインは503です。
- 通常の保存先は `backend/.wrangler/state/`（Git管理外）。同じチェックアウトで `wrangler dev` を停止・再起動してもセッションを含むデータは残ります。テストは独立した一時D1を使い、この保存先に触れません。
- `people.created_at` / `terms_accepted_at` / 送信履歴の `updated_at` はUnixミリ秒のINTEGERです。初回利用同意の時刻は再同意で上書きしません。`posts.created_at` は常に `Date.toISOString()` 形式（UTC、ミリ秒あり）のTEXTです。期間比較も同じ形式を使います。
- 人物検索は同一Slack team内で利用・受信同意済みの人物だけを返し、`%`、`_`、`\` も文字として検索します。公開キーは `id` と `name` だけです。

永続化のHTTP確認は、ログイン→上のPATCH/投稿curl→件数GETの順に行い、Goodが1増えたことを確認します。開発サーバーを停止し、同じ `npm run dev --prefix backend` で再起動して件数GETを繰り返してください。再ログインせず同じCookieで `/me` が200になること、ログアウト後に同じCookieで401になることも確認してください。セッショントークンと端末キーはログやPRへ貼らないでください。

## 週次処理向けの内部repo

`src/data/repository.mjs` の `createRepository(env.DB)` は、PR #7 の `runWeeklyDigest` に渡す `repo` を返します。`jobs/`・`slack/` のコードは取り込まず、HTTP公開・送信・Cron設定もしません。

```js
import { createRepository } from './data/repository.mjs';
const repo = createRepository(env.DB);
// runWeeklyDigest({ repo, ... }) への組み込みはGM-005
```

`listPersonPosts({ from, to })` はDateを受け取り、人物宛ての `[from, to)` をISO日時の行で返します。`getRecipient`、`listDisplayNames`、`getDelivery` もD1から取得します。`claimDelivery` は単一UPSERTで未送信/failedだけをsendingにし、再取得ではattemptsを増やします。sending/sent/unknownは再取得できません。`finishDelivery` はsent/failed/unknownとSlack ts/channel/errorを保存します。

時刻境界を再現するテストでは `createApp({ now: () => new Date(...) })` または `createRepository(db, { now })` を使います。HTTPで時刻や投稿者を指定する機能はありません。


## Geminiのモードと外部送信

`POST /api/v1/posts/analyze` のモードは次のとおりです。モデルIDの既定値はありません。

| `ENV` | `GEMINI_API_KEY` / `GEMINI_MODEL` | 動作 |
| --- | --- | --- |
| `development` | 両方未指定または空 | 従来の固定応答 |
| `development` | 両方指定 | Gemini REST `generateContent` へ接続 |
| `development` | 片方だけ指定 | 503 `SERVICE_UNAVAILABLE` |
| `production` / `staging` | 両方指定 | OIDC設定もあればGeminiへ接続 |
| `production` / `staging` | 両方未指定または片方だけ | analyzeは503。固定応答を返さない |
| その他・未設定 | 任意 | 全API 503 |

Geminiの設定はサーバーの `backend/.dev.vars` に置きます。`GEMINI_API_KEY` は秘密値、`GEMINI_MODEL` は利用可能なJSON出力対応モデルのIDです。ブラウザ用環境変数へ渡さず、Gitにコミットしないでください。developmentではローカルホスト制限も引き続き適用します。

認証・利用同意・Origin・本文検証の後で、trim済み本文とD1の場所の `id` / `name` だけを送ります。人物マスタ・投稿者・Slack ID・セッションは送りません。ただし、入力本文に含まれる名前などは本文の一部として外部送信されます。`analyze` は本文をD1に保存しません。人物IDは必ずnull、既知の場所の名称はD1から取得して返します。本文・応答・キーはログに出しません。

Geminiの429は429 `RATE_LIMITED`、その他のエラー・安全性ブロック・不正JSON・判定不能・15秒のタイムアウトは503です。本文の読み取りもタイムアウトに含めます。自動リトライ・固定応答への切替・キャッシュはありません。Webは503時に本文を残して入力画面へ戻す想定で、実Webとの確認はGM-005で行います。

Gemini無料枠では送信内容がサービス改善に使われる場合があります。利用条件と送信に対する同意を確認してください。**実在の人物や不満を動作確認に使わないでください。架空の人物・架空の投稿だけを使ってください。**

### 実キーで後日確認する手順（本タスクでは未実施）

1. 先に `npm run ci` と、Gemini設定を両方空にした固定応答モードで上記curlのログイン→分析→投稿を確認します。
2. Geminiの[公式料金・データ利用条件](https://ai.google.dev/gemini-api/docs/pricing)を確認し、利用できるJSON出力対応モデルを選びます。
3. Git管理外の `backend/.dev.vars` に自分の `GEMINI_API_KEY` と `GEMINI_MODEL` を設定して、ローカルの `npm run dev --prefix backend` を再起動します。キーやセッションはログ・画面共有・PRへ貼らないでください。
4. 上記curlで再ログインし、架空の場所・架空の人物・対象不明の本文を分析します。人物IDがnull、場所名がD1の値、分類と対象候補が提案として妥当であることを確認します。
5. 下記の内部モジュールに架空の投稿配列を渡し、受信者向けの自然な日本語、非攻撃性、引用や人物名がないこと、数字・日時・曜日・部屋番号・引用符がないこと、各400文字以内、特定可能性に対する `needs_review` を人が確認します。これはモックテストでは評価できません。
6. 終了後はGemini設定を両方空に戻して再起動します。本番設定・デプロイは別タスクです。

### 週次処理向け内部要約モジュール

```js
import { createGemini } from './ai/gemini.mjs';
const { summarize } = createGemini({
  apiKey: env.GEMINI_API_KEY,
  model: env.GEMINI_MODEL,
  fetch, // テストでは必ずモックを注入
});
// summarize({ good: string[], motto: string[] })
//   => Promise<{ good: string, motto: string, needs_review: boolean }>
```

`summarize` はHTTP公開しません。PR #7の `runWeeklyDigest` に渡す組み込みはGM-005です。入力の `good` / `motto` の本文配列だけを送り、他のキーは送りません。出力の型を検証し、入力が空の側は必ず空文字列にします。両方空なら通信せず `{ good: '', motto: '', needs_review: false }` を返し、設定も不要です。

30秒のタイムアウト（本文受信を含む）、429などのAPIエラー、安全性ブロック、不正JSON、型違いは詳細を含まない `GeminiError` を投げます。呼び出し側はこれを `summarize_failed` として扱えます。再試行・固定文章への切替・文字数の切り詰めはしません。400文字を超えた結果の保留・再実行・送信判定はPR #7の責務です。本文だけでも再識別リスクがあるため、実キーでの文章品質確認と週次側の匿名性検査が必要です。

Gemini通信のテストは全件モックです。`node --test backend/test/gemini.test.mjs` をリポジトリ直下から実行すると、モード・最小化・出力検証・失敗・仮想時計による期限・保存とログへの漏洩防止を確認できます。PR #7の `node --test backend/test/*.test.js` とも共存します。RESTの形式は[Google公式のgenerateContent例](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)を参照しています。実際のGeminiとの疎通・文章品質は未検証です。
