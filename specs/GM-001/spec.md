# GM-001 — Hono API基盤・モック

対応Issue: #4 のうちGM-001のみ（PRは `Refs #4`。`Closes` にしない）
PRの宛先: `feat/4-backend-api`（`main` へは全タスク完了後に別途PRを作る）
全体計画: GM-002〜GM-005は別タスク。本タスクでは着手しない。

## なぜ作るか

Web（PR #8）とSlack（PR #7）はモックで動くところまで進み、どちらも #4 を待っている。Webは `VITE_API_MODE=live` にすると `http://127.0.0.1:8787` の `/api/v1` を呼ぶが、受け手がまだ存在しない。

GM-001の目的は「本物の機能」ではなく、**他担当が契約どおりのHTTPに対して結合確認できる状態を、D1・Gemini・Slackなしで作ること**。

## 読むもの（この順で優先）

1. `docs/api/contract-v1.md`（通信の唯一の正）
2. `docs/auth/slack-oidc-v1.md`
3. `CONTRIBUTING.md`（特に §1 モック、§3 PR記載事項、§6 秘密情報）

## 範囲に含めるもの

`backend/` に Cloudflare Workers + Hono のAPIを作り、次の **10エンドポイント** をモックで提供する。

| Method | Path | 認証 | 正常時 |
| --- | --- | --- | --- |
| GET | `/api/v1/auth/slack/login` | 不要 | 302（下記モックログイン） |
| GET | `/api/v1/auth/slack/callback` | 不要 | 302 `/` |
| GET | `/api/v1/me` | Cookie | 200 |
| PATCH | `/api/v1/me/preferences` | Cookie＋Origin | 200（`/me` と同型） |
| POST | `/api/v1/auth/logout` | Cookie＋Origin | 204 |
| POST | `/api/v1/posts/analyze` | Cookie＋利用同意＋Origin | 200 |
| POST | `/api/v1/posts` | Cookie＋利用同意＋Origin | 201 |
| GET | `/api/v1/places` | Cookie | 200 |
| GET | `/api/v1/people?query=` | Cookie | 200 |
| GET | `/api/v1/places/{id}/counts` | デバイス資格情報 | 200 |

Issue #4本文のPhase 1は「5エンドポイント」だが、Web（PR #8）は最初に `/me` を呼び、401でログインへ、未同意で設定画面へ分岐する。認証系のモックがないと投稿画面まで到達できないため、GM-001に含める（Productの判断）。

## 範囲に含めないもの

- D1、マイグレーション、投稿の永続化、SQL集計（GM-002）
- Gemini連携、`summarize` モジュール（GM-003）。OpenAI APIは使わない
- 実Slack OIDC、D1セッション（GM-004）
- PR #7 の週次ジョブの組み込み、Cron（GM-005）。`wrangler` の `crons` も設定しない
- デプロイ。GM-001のベースURLはローカルの `http://127.0.0.1:8787`（WebのVite proxyの中継先）のみ。Cloudflareへのデプロイを実行しない
- PR #7・#8のマージ
- `people[]` への `username` / `avatar_url` など同姓同名対策の項目追加（契約変更が必要。別途相談）
- 429のレート制限、自分自身を対象にした投稿の扱い

## 受け入れ条件

### A. モードは安全側に倒れる

- [ ] モックは `ENV=development` のときだけ動く。値は `.dev.vars` など**コミットされない場所**で与え、コミットする `wrangler` 設定に `development` を書かない
- [ ] `ENV` が未設定またはそれ以外なら、10エンドポイントすべてが `503` + 共通エラーJSONを返す。固定データもセッションCookieも返さない（テスト必須）

### B. モックログイン

- [ ] `GET /auth/slack/login` は架空ユーザーのセッションを発行し、**相対パス**の `Location: /` へ302する（Vite proxy経由でも画面に戻るため）
- [ ] 架空ユーザーは2種類。同意済み（既定）と未同意（`?mock_user=` などローカル専用の指定で選択）
- [ ] Cookie名は `__Host-gm_session`、属性は `HttpOnly; Secure; SameSite=Lax; Path=/`、`Domain` なし。ローカルのhttpでブラウザが受け付けない場合に限り、**モックモードだけ**属性を変えてよい。その場合は変更内容をREADMEに書き、モック以外の経路に影響しないことをテストする
- [ ] ログイン応答のCookieを付けた `/me` が200になることを自動テストで確認する。Vite（`VITE_API_MODE=live`）経由の確認手順はREADMEに書く。実ブラウザとPR #8の結合確認はGM-005で行う
- [ ] 同一の `wrangler dev` プロセス内では、`PATCH /me/preferences` の結果が `/me` に反映され、ログアウト後のCookieは401になる（再起動でのリセットは可）

### C. 認証・同意の分岐

- [ ] Cookieなし・無効Cookieは全Cookie必須APIで401
- [ ] 未同意ユーザーの `analyze` と `posts` は403
- [ ] Cookie認証の変更系（PATCH / POST）は、許可されたOrigin以外なら403。`application/json` のリクエストも対象。許可Originは環境設定で与え、ローカルでは Vite の `http://localhost:5173` を許可する。**Vite proxyは `changeOrigin` で `Host` を書き換えるので、`Origin` と `Host` の単純比較にしない**
- [ ] CORSを `*` にしない

### D. `PATCH /me/preferences`

- [ ] `terms_accepted` と `feedback_opt_in` はどちらも真偽値で必須。欠落・型違いは400
- [ ] `feedback_opt_in` は初期false、いつでもfalseに戻せる
- [ ] 同意済みユーザーの `terms_accepted:false` は400。撤回は「別途運用手順」（認証設計 §3）なので、受け取ったふりをしない
- [ ] 未同意ユーザーの `feedback_opt_in:true`（`terms_accepted:false` のまま）は403

### E. 投稿系

- [ ] `analyze` は有効な入力に対して契約の例を固定で返す: `{"sentiment":"motto","target_type":"place","target_id":"kitchen","target_label":"共用キッチン"}`
- [ ] `target_type=person` を返す場合、`target_id` は常に `null`（AIの推測で人物IDを確定しない）
- [ ] `posts` は `{"post_id":"<文字列>","status":"created"}` を201で返す。保存はしない（READMEに明記）
- [ ] `text` は `analyze` と `posts` で同じ検証: 文字列必須、trim後のUnicodeコードポイント数が1〜500なら受け付け、それ以外は400。バイト数の上限は設けない。境界値（500・501）と絵文字（1文字として数える）をテストする
- [ ] `posts` の `sentiment` は `good|motto`、`target_type` は `person|place` のみ。`unknown` や `target_id:null` は400
- [ ] 存在しない `target_id` は404。`target_type=person` で未同意の相手は403
- [ ] リクエストに `author_person_id` などの投稿者IDが含まれても採用しない（テスト必須）
- [ ] 投稿本文をログに出さない

### F. 参照系

- [ ] `places` は `kitchen`（共用キッチン）と `laundry`（洗濯室）を返す
- [ ] `people` は同意済みの架空人物だけを返す。`feedback_opt_in=false` の架空人物を少なくとも1人用意し、検索に出ないことをテストする。`query` の欠落・空は400
- [ ] `people[].id` は `people.id` と同じUUID形式（認証設計 §5・§6）。返すキーは `id` と `name` のみ

### G. M5Stack用 `GET /api/v1/places/{id}/counts`

- [ ] 資格情報は `Authorization: Bearer <鍵>`。全端末で共通の読み取り専用鍵1つを `M5_DEVICE_KEY` で与える。なし・不一致は401。ユーザーCookieだけでは通さない。鍵は `.dev.vars` で与え、既定値をコミットしない
- [ ] この鍵で他のAPIを呼べない
- [ ] `kitchen` は契約の例（`good_count:8, motto_count:12, period_days:7`）を返す
- [ ] `laundry` は合計5件未満の固定値を返す（端末のグレー表示を確認できるように）
- [ ] 不明な場所は404
- [ ] 返すキーは `place_id, period_days, good_count, motto_count, updated_at` の5つだけ（完全一致でテスト）。割合・色・本文・人物情報を含めない

### H. 共通

- [ ] 400 / 401 / 403 / 404 / 500 / 503 はすべて `{"error":{"code","message"}}`。`code` は `INVALID_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `INTERNAL_ERROR` / `SERVICE_UNAVAILABLE`
- [ ] 不正なJSONは400。未定義パスも共通エラーJSONの404
- [ ] 架空の人物名・架空の投稿だけを使う（CONTRIBUTING §1）。実在の氏名やSlack IDを入れない
- [ ] 秘密情報をコミットしない。`.env.example` 相当には名前と架空値のみ

### I. 他担当との共存

- [ ] PR #7 は `backend/src/jobs/`、`backend/src/slack/`、`backend/test/*.test.js`、ルートの `.gitignore` と `.env.example` を追加し、テストを `node --test backend/test/*.test.js` で実行する。これらのパスを使う場合は衝突を避け、PR #7 のマージ後もこのコマンドが動く配置にする
- [ ] `frontend/` と M5Stack のファイルを変更しない
- [ ] `backend/README.md` に、起動・テスト手順、ベースURL、架空ユーザーの切替、curl例、モックと実装済みの範囲の区別を書く

### J. 検証

- [ ] 上記の条件を自動テストで確認する。テストはCloudflareへのログイン、外部通信、秘密情報を必要としない
- [ ] 新しいチェックアウトで、リポジトリ直下の `npm run ci` だけで依存のインストールとテストが完了する。ルートの `package.json` はこのスクリプトのためだけに置き、依存を持たせない
- [ ] GitHub Actions に `test` という名前のジョブを置き、同じコマンドを実行する。`main` 以外を宛先にしたPRでも動くようにする
- [ ] PR本文に CONTRIBUTING §3 の6項目と、実行したテストコマンド・結果を書く

## API契約について

このタスクで必要な追記（投稿上限、M5Stackの資格情報、エラー `code` 一覧、ログアウトの204、`people[].id` のUUID、`target_type=unknown` の拒否）は、`docs/api/contract-v1.md` に反映済み。実装者は契約を変更しない。契約とこの仕様が食い違う場合は実装を進めず、PRに食い違いを書く。
