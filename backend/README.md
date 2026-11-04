# GM-001: ローカルAPIモック

Cloudflare Workers + Honoで、[API契約 v1](../docs/api/contract-v1.md)の10エンドポイントを提供します。ベースURLは **`http://127.0.0.1:8787`**、APIのプレフィックスは `/api/v1` です。架空データでHTTP結合を確認するためのモックです。

## 起動とテスト

Node.js 24（最低22）とnpmを使用します。リポジトリ直下で実行してください。

```sh
npm run ci
cp backend/.dev.vars.example backend/.dev.vars
# backend/.dev.vars の M5_DEVICE_KEY を自分のローカル用ランダム値に変更
# 例: openssl rand -hex 32 で生成する。生成値はコミットしない
npm run dev --prefix backend
```

`npm run ci` は `npm ci --prefix backend` で依存をインストールし、`npm test --prefix backend` でテストします。テスト自体には外部通信、Cloudflareへのログイン、実Secret、`.dev.vars` は不要です。初回の依存取得にはnpmレジストリへの接続が必要です。テストだけの再実行は次のとおりです。

```sh
npm test --prefix backend
```

| ローカル設定（`backend/.dev.vars`） | 用途 |
| --- | --- |
| `ENV=development` | 完全一致のときだけモックを許可 |
| `ALLOWED_ORIGIN=http://localhost:5173` | 変更系APIで許可する単一のOrigin（ワイルドカード不可） |
| `M5_DEVICE_KEY=<自分で生成したローカル用キー>` | 件数取得だけに使う共通Bearerキー。既定値なし |

`.dev.vars` はGit管理対象外です。コミットするWrangler設定には `ENV` を入れていません。`ENV` 未設定・それ以外の値では全APIが503（共通エラーJSON）になり、Cookieも固定データも返しません。開発設定でもURLのホストが `localhost` / `127.0.0.1` / `::1` 以外なら503です。Wranglerはローカル接続で起動し、Cloudflareへのデプロイは本タスクでは行いません。

## 架空ユーザーとセッション

| ログインURL | 架空人物 | 初期状態 |
| --- | --- | --- |
| `/api/v1/auth/slack/login` または `?mock_user=accepted` | 架空アオ（UUID末尾001） | 利用同意済み、受信同意なし |
| `/api/v1/auth/slack/login?mock_user=pending` | 架空ミドリ（UUID末尾002） | 利用未同意、受信同意なし |

検索・人物宛て投稿用に、利用・受信同意済みの「架空ソラ」（UUID末尾003）も用意しています。人物名・データはすべて架空です。

ログインはセッションを発行して `Location: /` に302します。callbackも `/` に302しますが、実OIDCの交換やセッション発行はしません。セッションはランダム256bit、期限7日、プロセス内メモリのみです。設定は人物単位で保持し、同じユーザーの別セッションにも反映します。ユーザーを切り替えても設定は初期化しません。再起動・コード再読込で設定とセッションは消えます。ログアウトはセッション失効とCookie削除を行い204を返します。

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

Cookieなし/無効は401、未同意の投稿・許可外/欠落Originは403、不正入力は400、未存在の対象は404です。未定義パスは404、予期しない例外は500、モック無効時は503で、すべて `{"error":{"code":"...","message":"..."}}` を返します。CORSは公開せず、ブラウザからは同一OriginのVite proxyを使います。変更系JSON APIもOrigin検証対象です。Viteの `changeOrigin` によるHostの変更は判定に使いません。

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
- `posts` はランダムな `post_id` と `status:created` を201で返すだけで、**投稿本文・投稿者・投稿日時を保存しません**。件数も変化しません。投稿者/日時の持ち込み（`author_person_id`, `author_id`, `person_id`, `user_id`, `created_at`）は400で拒否します。
- 本文は両投稿APIでtrim後のUnicodeコードポイント数1〜500を検証します。絵文字1コードポイントは1文字です。バイト数上限は設けず、投稿本文をログへ出しません。
- 同意済みの `terms_accepted:false` は400（利用同意の撤回は別途運用手順）。未同意のまま受信同意だけtrueにすると403です。
- 件数は固定です。kitchenは8/12、laundryは1/2、更新時刻も固定値です。端末の黄色/グレー表示の確認用で、集計処理はありません。
- D1・永続化・SQL・Gemini・実Slack OIDC・週次ジョブ・Cron・デプロイ・429制御は含めません。GM-002〜GM-005は未着手です。

API実装は `src/index.mjs` と `src/api/`、テストは `test/api.test.mjs` に配置しています。PR #7の `src/jobs/`、`src/slack/`、`test/*.test.js` と名前を分け、ルートの `.gitignore` / `.env.example` は使いません。`npm test --prefix backend` は `test/*.test.*` を実行するため、PR #7マージ後はそのテストも対象になります。既存の `node --test backend/test/*.test.js` も維持できる構成です。
