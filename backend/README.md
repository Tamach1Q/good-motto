# GM-002: ローカルD1と投稿データ

Cloudflare Workers + Honoで、[API契約 v1](../docs/api/contract-v1.md)の10エンドポイントを提供します。ベースURLは **`http://127.0.0.1:8787`**、APIのプレフィックスは `/api/v1` です。架空データでHTTP結合を確認するための開発環境です。人物・同意・投稿・送信履歴はローカルD1に保存します。ログインと分析はモックです。

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
```

| ローカル設定（`backend/.dev.vars`） | 用途 |
| --- | --- |
| `ENV=development` | 完全一致のときだけモックを許可 |
| `ALLOWED_ORIGIN=http://localhost:5173` | 変更系APIで許可する単一のOrigin（ワイルドカード不可） |
| `M5_DEVICE_KEY=<自分で生成したローカル用キー>` | 件数取得だけに使う共通Bearerキー。既定値なし |

`.dev.vars` はGit管理対象外です。コミットするWrangler設定には `ENV` を入れていません。`ENV` 未設定・それ以外の値では全APIが503（共通エラーJSON）になり、Cookieもデータも返しません。開発設定でもURLのホストが `localhost` / `127.0.0.1` / `::1` 以外なら503です。Wranglerはローカル接続で起動し、Cloudflareへのデプロイは本タスクでは行いません。

## 架空ユーザーとセッション

| ログインURL | 架空人物 | 初期状態 |
| --- | --- | --- |
| `/api/v1/auth/slack/login` または `?mock_user=accepted` | 架空アオ（UUID末尾001） | 利用同意済み、受信同意なし |
| `/api/v1/auth/slack/login?mock_user=pending` | 架空ミドリ（UUID末尾002） | 利用未同意、受信同意なし |

検索・人物宛て投稿用に、利用・受信同意済みの「架空ソラ」（UUID末尾003）も用意しています。人物名・データはすべて架空です。

ログインはセッションを発行して `Location: /` に302します。callbackも `/` に302しますが、実OIDCの交換やセッション発行はしません。セッションはランダム256bit、期限7日、プロセス内メモリのみです。人物の設定はD1から毎回読み、同じユーザーの別セッションにも反映します。ユーザーを切り替えても設定は初期化しません。再起動・コード再読込でセッションは消えますが、人物・同意・投稿は残ります。再ログインして確認してください。ログアウトはセッション失効とCookie削除を行い204を返します。

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

Cookieなし/無効は401、未同意の投稿・許可外/欠落Originは403、不正入力は400、未存在の対象は404です。未定義パスは404、予期しない例外は500、モック無効時・D1未設定/未マイグレーション/失敗時は503で、すべて `{"error":{"code":"...","message":"..."}}` を返します。CORSは公開せず、ブラウザからは同一OriginのVite proxyを使います。変更系JSON APIもOrigin検証対象です。Viteの `changeOrigin` によるHostの変更は判定に使いません。

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

- `analyze` は有効な本文すべてに `{"sentiment":"motto","target_type":"place","target_id":"kitchen","target_label":"共用キッチン"}` を返します。人物分類は生成しません。
- `posts` はtrim後の本文、セッション本人のID、サーバーのUTC時刻をD1に保存し、保存行と同じ `post_id` と `status:created` を201で返します。投稿者/日時の持ち込み（`author_person_id`, `author_id`, `person_id`, `user_id`, `created_at`）は400で拒否します。
- 本文は両投稿APIでtrim後のUnicodeコードポイント数1〜500を検証します。絵文字1コードポイントは1文字です。バイト数上限は設けず、投稿本文をログへ出しません。
- 同意済みの `terms_accepted:false` は400（利用同意の撤回は別途運用手順）。未同意のまま受信同意だけtrueにすると403です。
- 件数は `target_type=place` の指定場所だけをSQLで集計します。今日（JST）を含む7暦日で、6日前の00:00 JST以上、集計時刻以下です。`updated_at` は集計時刻のUTC ISO 8601（末尾Z）です。投稿なしの既知の場所は0/0、不明な場所は404です。
- Gemini・実Slack OIDC・D1セッション・週次ジョブの組み込み・Cron・デプロイ・429制御は含めません。GM-003〜GM-005は別タスクです。

API実装は `src/index.mjs` と `src/api/`、テストは `test/api.test.mjs` と `test/repository.test.mjs` に配置しています。PR #7の `src/jobs/`、`src/slack/`、`test/*.test.js` と名前を分け、ルートの `.gitignore` / `.env.example` は使いません。`npm test --prefix backend` は `test/*.test.*` を実行するため、PR #7マージ後はそのテストも対象になります。既存の `node --test backend/test/*.test.js` も維持できる構成です。


## D1のマイグレーションと開発シード

上記の `db:migrate` と `db:seed` は必ずローカルD1に適用します。Cloudflareログインは不要です。バインディングは `DB`、`wrangler.jsonc` の `database_id` は存在しない全ゼロのプレースホルダーです。本番接続には別途、本番D1の作成と実際のID・Secretsの設定が必要です。このタスクでは作成・接続・デプロイしません。

- `migrations/0001_post_data.sql`: `people`、`places`、`posts`、`slack_digest_deliveries` と索引。初期データはkitchen/laundryだけです。マイグレーションだけでは人物と投稿は空です。
- `seeds/development.sql`: 架空アオ・ミドリ・ソラと存在しないSlack IDだけの開発専用データ。初期投稿はありません。再投入しても既存の同意・投稿を上書きしません。シード未投入時のモックログインは503です。
- 通常の保存先は `backend/.wrangler/state/`（Git管理外）。同じチェックアウトで `wrangler dev` を停止・再起動してもデータは残ります。テストは独立した一時D1を使い、この保存先に触れません。
- `people.created_at` / `terms_accepted_at` / 送信履歴の `updated_at` はUnixミリ秒のINTEGERです。初回利用同意の時刻は再同意で上書きしません。`posts.created_at` は常に `Date.toISOString()` 形式（UTC、ミリ秒あり）のTEXTです。期間比較も同じ形式を使います。
- 人物検索は同一Slack team内で利用・受信同意済みの人物だけを返し、`%`、`_`、`\` も文字として検索します。公開キーは `id` と `name` だけです。

永続化のHTTP確認は、ログイン→上のPATCH/投稿curl→件数GETの順に行い、Goodが1増えたことを確認します。開発サーバーを停止し、同じ `npm run dev --prefix backend` で再起動して件数GETを繰り返してください。再ログイン後の `/me` でも設定の保持を確認できます。セッショントークンと端末キーはログやPRへ貼らないでください。

## 週次処理向けの内部repo

`src/data/repository.mjs` の `createRepository(env.DB)` は、PR #7 の `runWeeklyDigest` に渡す `repo` を返します。`jobs/`・`slack/` のコードは取り込まず、HTTP公開・送信・Cron設定もしません。

```js
import { createRepository } from './data/repository.mjs';
const repo = createRepository(env.DB);
// runWeeklyDigest({ repo, ... }) への組み込みはGM-005
```

`listPersonPosts({ from, to })` はDateを受け取り、人物宛ての `[from, to)` をISO日時の行で返します。`getRecipient`、`listDisplayNames`、`getDelivery` もD1から取得します。`claimDelivery` は単一UPSERTで未送信/failedだけをsendingにし、再取得ではattemptsを増やします。sending/sent/unknownは再取得できません。`finishDelivery` はsent/failed/unknownとSlack ts/channel/errorを保存します。

時刻境界を再現するテストでは `createApp({ now: () => new Date(...) })` または `createRepository(db, { now })` を使います。HTTPで時刻や投稿者を指定する機能はありません。
