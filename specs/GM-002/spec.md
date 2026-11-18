# GM-002 — D1と投稿データ

対応Issue: #4 のうちGM-002のみ（PRは `Refs #4`。`Closes` にしない）
PRの宛先: `feat/4-backend-api`（`main` へは全タスク完了後に別途PRを作る）
前提: GM-001（`backend/` のHono APIモック）はマージ済み。GM-003〜GM-005は別タスク。本タスクでは着手しない。

## なぜ作るか

GM-001では投稿が保存されず、件数は固定値なので、M5Stackは実際の傾向を表示できず、週次Slack処理には読むデータがない。

GM-002の目的は、**投稿がD1に残り、場所の件数が投稿から計算され、週次処理が必要なデータを読める状態を、ローカルのD1で作ること**。

## 読むもの（この順で優先）

1. `docs/api/contract-v1.md`（通信の唯一の正）
2. `docs/auth/slack-oidc-v1.md`（特に §5 スキーマ、§6 人物の特定）
3. `CONTRIBUTING.md`（特に §1 モック、§3 PR記載事項、§6 秘密情報）
4. `backend/README.md`

## 範囲に含めるもの

- D1マイグレーション: `people`、`places`、`posts`、`slack_digest_deliveries`
- `GET /me`、`PATCH /me/preferences`、`GET /people`、`GET /places`、`POST /posts`、`GET /places/{id}/counts` をD1に接続する
- Slack週次処理（PR #7）が使うデータ取得の `repo` 実装

## 範囲に含めないもの

- `POST /posts/analyze` のGemini接続、`summarize` モジュール（GM-003）。`analyze` は固定応答のまま
- 実Slack OIDC、`sessions`、`oauth_states`（GM-004）。ログインはモックのまま
- 週次ジョブの組み込み、Cron（GM-005）。`wrangler` の `crons` を設定しない
- 実在の投稿データ、本番D1の作成、`--remote` の実行、デプロイ
- PR #7・#8のマージ、`frontend/`・M5Stack・`backend/src/jobs/`・`backend/src/slack/` の変更
- 投稿の再送防止（冪等性）、429、投稿やアカウントの削除手順、自分自身を対象にした投稿の特別扱い
- `people[]` への項目追加

## 受け入れ条件

### A. マイグレーション

- [ ] `people` は認証設計 §5 のカラムと一意制約 `(slack_team_id, slack_user_id)` のとおり
- [ ] `posts` は `id`、`author_person_id`（`people.id` への参照）、`target_type`（`person|place`）、`target_id`（NOT NULL）、`sentiment`（`good|motto`）、`text`、`created_at` を持つ。列挙値はDBでも制約する
- [ ] `places` の初期データは `kitchen`（共用キッチン）と `laundry`（洗濯室）で、マイグレーションに含める
- [ ] `slack_digest_deliveries` は `person_id`、`week_key`、`status`（`sending|sent|failed|unknown`）、`attempts`、`slack_ts`、`slack_channel`、`error`、`updated_at` を持ち、主キーは `(person_id, week_key)`
- [ ] 件数集計と週次の期間抽出に使うインデックスを用意する
- [ ] 架空の人物と投稿は**開発用シードだけ**に置く。マイグレーションだけを適用したDBでは `people` と `posts` が空であることをテストする
- [ ] ローカルへの適用とシード投入のコマンドを `backend/package.json` に用意する。`--remote` を付けたコマンドを用意しない
- [ ] D1のバインディング名は `DB`。`database_id` は実在しないプレースホルダーとし、本番値が必要なことをREADMEに書く

### B. モードと障害時

- [ ] GM-001のモード制限を維持する。開発モード以外は全APIが503で、Cookieもデータも返さない
- [ ] 固定の件数とメモリ上の人物データをリクエストの処理から取り除く
- [ ] D1が未設定、未マイグレーション、または失敗した場合は、共通エラーJSONの503を返す。固定値で成功したふりをしない（テスト必須）
- [ ] エラーのログに投稿本文を出さない

### C. 人物と同意

- [ ] `/me`、`PATCH /me/preferences`、`/people` はD1の `people` を読み書きする。応答の形はGM-001から変えない
- [ ] 同意の結果は `wrangler dev` を再起動しても残る。`terms_accepted` は `terms_accepted_at` に時刻として記録する
- [ ] モックのセッションは、トークンから `person_id` を引く部分だけメモリに残してよい（D1セッションはGM-004）
- [ ] `/people` は、ログイン本人と同じ `slack_team_id` で `feedback_opt_in=1` の人物だけを返す。`name` は `display_name` で、キーは `id` と `name` のみ
- [ ] 検索語の `%` と `_` は文字どおりに扱う。SQLは必ずパラメータ化する（テスト必須）

### D. `POST /api/v1/posts`

- [ ] 検証を通った投稿を保存し、応答の `post_id` は保存した行の `id` と一致する
- [ ] `author_person_id` はセッションから、`created_at` はサーバー時刻から決める。投稿者や日時をリクエストに含めた場合の扱いはGM-001から変えない
- [ ] `text` は**trim後の値**を保存する
- [ ] 検証に失敗した投稿は1行も保存しない
- [ ] `target_type=place` は `places.id`、`target_type=person` は `people.id` として検証する。種類と合わないIDや存在しないIDは404
- [ ] `target_type=person` の相手の同意は投稿時点のD1の値で判定し、未同意または撤回済みなら403（テスト必須）

### E. `GET /api/v1/places/{id}/counts`

- [ ] `target_type=place` で指定の `place_id` の投稿だけを、`good_count` と `motto_count` に分けてSQLで集計する。人物宛ての投稿は、`target_id` が同じ文字列でも数えない
- [ ] 期間は**今日（JST）を含む7暦日**。下限はJSTの6日前の00:00:00で、これを含む。上限は集計時点。契約の「直近7日間（日本時間基準）」に従う解釈である
- [ ] 境界をテストする: 6日前00:00:00 JSTの投稿は含み、7日前23:59:59 JSTの投稿は含まない。UTCの日付が変わる時間帯でも正しい。時刻を外から与えてテストできるようにする
- [ ] 投稿がない既知の場所は両方0で200。不明な場所は404
- [ ] Good/Mottoの混在、複数の場所、人物宛ての混在をテストする
- [ ] `updated_at` は**集計した時刻**で、UTCのISO 8601（末尾 `Z`）。最新の投稿時刻ではない
- [ ] 返すキーは5つだけ（完全一致でテスト）。Bearerキーの要件はGM-001から変えない

### F. 週次処理向けの `repo`

PR #7 の `runWeeklyDigest` にそのまま渡せる `repo` を `backend/src/` の `jobs/` 以外の場所に実装する。HTTPには公開しない。PR #7はまだマージされていないので、参照はブランチ `origin/feature/slack-weekly-digest` の `docs/slack/weekly-digest.md` で確認できるが、コードは取り込まない。

| 関数 | 仕様 |
| --- | --- |
| `listPersonPosts({ from, to })` | `from`・`to` は `Date`。`target_type='person'` かつ `from <= created_at < to` の投稿を `[{ id, author_person_id, target_type, target_id, sentiment, text, created_at }]` で返す。`created_at` はISO 8601文字列 |
| `getRecipient(personId)` | `{ id, slack_team_id, slack_user_id, display_name, feedback_opt_in }` または `null`。`feedback_opt_in` は0か1 |
| `listDisplayNames()` | 全人物の `display_name` の配列 |
| `getDelivery(personId, weekKey)` | `{ status, ... }` または `null` |
| `claimDelivery(personId, weekKey)` | 未送信または `failed` なら `sending` に更新して `true`、それ以外は `false`。**1つのSQL文で原子的に行う**。再取得時は `attempts` を増やす |
| `finishDelivery(personId, weekKey, { status, ts?, channel?, error? })` | `status` は `sent|failed|unknown`。`ts` は `slack_ts`、`channel` は `slack_channel` に保存する |

- [ ] 各関数を実際のD1エンジンでテストする。`from` の含有と `to` の除外、同じ週への2回目の `claimDelivery` が `false`、`failed` の再取得が `true`、`sent` と `unknown` の再取得が `false` を確認する
- [ ] 即時送信のAPIを追加しない。Slackへの送信コードを追加しない

### G. 共通

- [ ] 架空の人物名・架空の投稿・存在しないSlack IDだけを使う（CONTRIBUTING §1）
- [ ] 秘密情報をコミットしない
- [ ] GM-001の受け入れ条件を維持する。既存テストを弱めない（D1接続に伴う書き換えは可。PRに理由を書く）
- [ ] `backend/README.md` に、マイグレーションとシードの手順、再起動後にデータが残ること、モックのまま残っている範囲（ログイン、`analyze`）を書く

### H. 検証

- [ ] SQLはSQLのモックではなく、ローカルのD1エンジンでテストする
- [ ] テストはCloudflareへのログイン、外部通信（依存の取得を除く）、秘密情報を必要としない
- [ ] 新しいチェックアウトで、リポジトリ直下の `npm run ci` だけで依存のインストールとテストが完了する。GitHub Actionsの `test` ジョブも成功する
- [ ] PR #7 のテスト実行方法（`node --test backend/test/*.test.js`）を壊さない配置にする
- [ ] ローカルの `wrangler dev` を実際に起動し、投稿→件数の増加→再起動後も残ることをHTTPで確認し、結果をPRに書く
- [ ] PR本文に CONTRIBUTING §3 の6項目と、実行したテストコマンド・結果を書く

## API契約について

このタスクで契約の変更は不要。エンドポイント名、HTTPメソッド、JSON形式を変えない。実装者は契約を変更しない。契約とこの仕様が食い違う場合は実装を進めず、PRに食い違いを書く。
