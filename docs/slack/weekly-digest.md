# Slack 週次ブリーフ（Issue #2）

人物宛ての Good/Motto を週1回まとめ、受信に同意した本人にだけ Slack DM で送ります。公開HTTPエンドポイントは作らず、Cron で動く内部処理です。項目名は [Slack OIDC 認証設計 v1](../auth/slack-oidc-v1.md) §5 の D1 スキーマ（`people.id` / `feedback_opt_in` / `slack_team_id` / `slack_user_id` / `posts.author_person_id`）に合わせています。

## 現状

| 項目 | 状態 |
|---|---|
| 週次抽出（前週の月曜0:00〜日曜24:00 JST、`target_type='person'` のみ） | ✅ `targetWeek()` |
| `slack_team_id` が `ALLOWED_SLACK_TEAM_ID` と一致しない人には送らない | ✅ |
| `feedback_opt_in` が true でない人／Slack ID がない人には送らない（実行時に毎回 DB から取得） | ✅ |
| 独立した投稿者が3人未満なら保留（自分への投稿は数えない） | ✅ 暫定ガード |
| 要約に原文（連続12文字）・他人の表示名が含まれたら保留 | ✅ 暫定ガード |
| 要約に数字・日時・引用など具体情報がある、または要約側が `needs_review: true` を返したら保留（手動確認） | ✅ 暫定ガード |
| 同じ人物・同じ週の二重送信防止（送信前に「送信中」を確保） | ✅ |
| 送信失敗 `failed` は再実行で再試行／結果不明 `unknown` は自動再送しない | ✅ |
| 送信成功後に記録だけ失敗した場合も再送しない（`unknown` ＝ 要手動照合） | ✅ |
| Cron 入口 `createScheduledWeeklyDigest()` を #4 の D1 repo・Gemini 要約・Bot Token に接続 | ✅ 結合テスト済み（実D1 + `repository.mjs` + `gemini.mjs`、外部通信は偽物） |
| Bot Token の疎通（`auth.test`）とワークスペース一致を実行時に確認。live では不一致なら送信しない | ✅ |
| 実行モード `dry-run`（既定）／`live-test`（指定した people.id だけ）／`live` | ✅ |
| Worker（`backend/src/index.mjs`）への組み込みと `crons` 設定 | ⏳ #4 側の作業（下記の手順） |
| Cloudflare Staging での Bot 認証確認 | ⏳ 未実施（下記の手順） |
| 実 Gemini での要約品質、実データでの再識別リスク評価 | ⏳ 未検証 |

**匿名性について**：上の「暫定ガード」は再識別リスクを下げるための最低限の防御で、匿名性を保証するものではありません。少人数の集団では、一意の出来事から投稿者が推測される可能性があります。しきい値や手動確認の運用は利用開始前にチームで合意してください。

## Worker への組み込み（#4 担当の作業）

`backend/src/jobs/scheduled.js` は #4 のモジュールを直接 import しません。引数で受け取ります。PR #7 と PR #14 がどちらの順でマージされても、壊れないようにするためです。

```js
// backend/src/index.mjs
import { createRepository } from './data/repository.mjs';
import { createGemini } from './ai/gemini.mjs';
import { createScheduledWeeklyDigest } from './jobs/scheduled.js';

const app = createApp();
export default {
  fetch: app.fetch,
  scheduled: createScheduledWeeklyDigest({ createRepository, createGemini }),
};
```

```jsonc
// backend/wrangler.jsonc
"triggers": { "crons": ["0 0 * * 1"] }   // 毎週月曜 00:00 UTC = 09:00 JST
```

### 設定（値はGitに書かない）

| 名前 | 種類 | 内容 |
|---|---|---|
| `DB` | D1 バインディング | 必須 |
| `ALLOWED_SLACK_TEAM_ID` | var | 必須。学校ワークスペースID（OIDCと共通） |
| `GEMINI_API_KEY` | Secret | 必須 |
| `GEMINI_MODEL` | var | 必須 |
| `SLACK_BOT_TOKEN` | Secret | `live-test` / `live` では必須。`dry-run` でも設定されていれば `auth.test` で疎通確認する |
| `DIGEST_MODE` | var | `dry-run`（既定）／`live-test`／`live` |
| `DIGEST_ONLY_PERSON_IDS` | var | `live-test` で送ってよい `people.id`（カンマ区切り）。明示同意したテスト受信者だけを書く |

設定が足りない場合は、DB・Gemini・Slack のどれにも触れずに `skipped: missing_config (…)` をログに出して終了します。ログに出すのは件数の集計（`{"counts":{"sent":1,…}}`）と `auth.test` の結果（`is_bot` / `team_match`）だけです。本文・氏名・トークンは出しません。

## 段階的に有効化する手順（Staging）

1. **Bot Token の登録**：担当者が `wrangler secret put SLACK_BOT_TOKEN --env staging` で直接入力します。Issue・PR・チャット・ログには書きません。
2. **dry-run で疎通確認**：`DIGEST_MODE` は未設定（＝dry-run）のままにします。Cron を待たずに確認したい場合は、staging の `crons` を一時的に `*/5 * * * *` などにして `wrangler tail --env staging` でログを見ます。確認できたら `0 0 * * 1` に戻します。
   - 期待するログ：`slack auth.test ok is_bot=true team_match=true` と、`mode=dry-run {"counts":{…}}`
   - 公開・無認証の診断用エンドポイントは作りません。
3. **live-test**：明示的に同意したテスト受信者1人の `people.id` を `DIGEST_ONLY_PERSON_IDS` に入れ、`DIGEST_MODE=live-test` にして1回だけ実行します。DMが届いたことと、再実行で `skipped:already_sent` になることを確認したら、`DIGEST_MODE` を dry-run に戻します。
4. **live**：匿名性のしきい値、保留分の手動確認の担当者、`unknown` の照合手順をチームで決めてから切り替えます。

ローカルで Cron を試す場合は `wrangler dev --test-scheduled` で起動し、`curl "http://127.0.0.1:8787/__scheduled?cron=0+0+*+*+1"` を実行します。

## 手元での確認

Node.js 22以上。追加パッケージは不要です。

```sh
node --test backend/test/*.test.js                                  # 週次バッチ単体・Cron入口のテスト（依存なし）
node backend/scripts/weekly-digest.mjs --now=2026-11-02T00:00:00Z   # 架空データで本文を確認（送信しない）
```

`backend/test/weeklyScheduled.integration.test.mjs` は #4 の `repository.mjs`・`gemini.mjs` とテスト補助（Miniflare の D1）を使う結合テストです。PR #14 のマージ後、`backend` で `npm test` を実行すると一緒に動きます。

### 手動CLIでのテスト送信

Worker を使わずに手元から1通だけ試す方法です（架空データの本文に【テスト送信】の表記が付きます）。

1. `cp .env.example .env` を実行し、`SLACK_BOT_TOKEN` と `ALLOWED_SLACK_TEAM_ID` を設定します。
2. Git管理外の `backend/.data/test-recipients.json` に、テストDMの受信OKをもらった人だけを書きます。

   ```json
   [{ "person_id": "00000000-0000-4000-8000-000000000001", "slack_team_id": "T...", "slack_user_id": "U..." }]
   ```

3. `node --env-file=.env backend/scripts/weekly-digest.mjs --send --only=00000000-0000-4000-8000-000000000001`

## ファイル

- `backend/src/jobs/weeklyDigest.js` — バッチ本体。DB・AI・Slack はすべて引数で差し替えます。
- `backend/src/jobs/scheduled.js` — Cron 入口。設定の検証、`auth.test`、実行モード、件数だけのログを担当します。
- `backend/src/jobs/mock.js` — 架空の人物・投稿・repo・ダミー要約（CLI とテスト用）
- `backend/src/slack/client.js` — Slack Web API（`auth.test` / `conversations.open` / `chat.postMessage`）
- `backend/scripts/weekly-digest.mjs` — 手動実行CLI
- `backend/test/` — 単体テスト（`*.test.js`）と #4 との結合テスト（`weeklyScheduled.integration.test.mjs`）

## #4 との契約（実装済み）

PR #14 の `backend/src/data/repository.mjs` が、次の関数をこの形で実装しています。

| 関数 | 戻り値 |
|---|---|
| `listPersonPosts({ from, to })` | `target_type='person'` かつ `from <= created_at < to` の投稿 `[{ id, author_person_id, target_type, target_id, sentiment, text, created_at }]` |
| `getRecipient(personId)` | `{ id, slack_team_id, slack_user_id, display_name, feedback_opt_in }` または `null` |
| `listDisplayNames()` | 全人物の `display_name` |
| `getDelivery(personId, weekKey)` | `slack_digest_deliveries` の行または `null` |
| `claimDelivery(personId, weekKey)` | 未送信 or `failed` のときだけ `sending` にして `true`（原子的） |
| `finishDelivery(personId, weekKey, { status, ts?, channel?, error? })` | `status`: `sent` / `failed` / `unknown` |

要約は `backend/src/ai/gemini.mjs` の `createGemini({ apiKey, model, fetch }).summarize({ good, motto }) => { good, motto, needs_review }` を使います。

## 運用メモ

- `unknown` は、Slack 側に届いている可能性がある状態です（送信結果が不明、または送信後の記録に失敗）。自動再送はしません。DMが届いたか確認し、届いていなければ `slack_digest_deliveries.status` を `failed` に戻してから再実行します。
- `sending` のまま残った場合（処理が途中で落ちた場合）も、同じように到着を確認してから手で戻します。
- `held:needs_manual_review` になった人の分は自動では送りません。内容を人が確認してから扱いを決めます。
