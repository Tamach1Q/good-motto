# Slack 週次ブリーフ（Issue #2）

人物宛ての Good/Motto を週1回まとめ、受信に同意した本人にだけ Slack DM で送ります。公開HTTPエンドポイントは作らず、Cron で動く内部処理です。項目名は [Slack OIDC 認証設計 v1](../auth/slack-oidc-v1.md) §5 の D1 スキーマ（`people.id` / `feedback_opt_in` / `slack_team_id` / `slack_user_id` / `posts.author_person_id`）に合わせています。

## 現状（Phase 1：モックで完結）

| 項目 | 状態 |
|---|---|
| 週次抽出（前週の月曜0:00〜日曜24:00 JST、`target_type='person'` のみ） | ✅ `targetWeek()` |
| `slack_team_id` が `ALLOWED_SLACK_TEAM_ID` と一致しない人には送らない | ✅ |
| `feedback_opt_in` が true でない人／Slack ID がない人には送らない | ✅ |
| 独立した投稿者が3人未満なら保留（自分への投稿は数えない） | ✅ 暫定ガード |
| 要約に原文（連続12文字）・他人の表示名が含まれたら保留 | ✅ 暫定ガード |
| 要約に数字・日時・引用など具体情報がある、または要約側が `needs_review: true` を返したら保留（手動確認） | ✅ 暫定ガード |
| 同じ人物・同じ週の二重送信防止（送信前に「送信中」を確保） | ✅ |
| 送信失敗 `failed` は再実行で再試行／結果不明 `unknown` は自動再送しない | ✅ |
| 送信成功後に記録だけ失敗した場合も再送しない（`unknown` ＝ 要手動照合） | ✅ |
| dry-run（送信しない） | ✅ 既定動作 |
| Cron（毎週月曜 00:00 UTC = 09:00 JST） | ✅ 入口 `scheduledWeeklyDigest()`。#4 の Worker に組み込む。D1未接続の間はモックで dry-run のみ |
| Gemini 要約 | ⏳ 共通AIモジュール（#4）待ち。現在は原文を使わないダミー要約 |
| D1 の人物・投稿・送信履歴 | ⏳ #4 と合意が必要（下記） |

**匿名性について**：上の「暫定ガード」は再識別リスクを下げるための最低限の防御で、匿名性を保証するものではありません。少人数の集団では、一意の出来事から投稿者が推測される可能性があります。しきい値や手動確認の運用は利用開始前にチームで合意してください。

## 動かし方

Node.js 22以上。追加パッケージは不要です。

```sh
node backend/scripts/weekly-digest.mjs                              # 架空データで本文を確認（送信しない）
node backend/scripts/weekly-digest.mjs --now=2026-11-02T00:00:00Z   # 実行時刻を指定
node --test backend/test/*.test.js                                  # テスト
```

### 実際のSlackへのテスト送信

[CONTRIBUTING.md](../../CONTRIBUTING.md) のとおり、Slack App の利用許可と本人の同意がそろった人にだけ送ります。

1. `cp .env.example .env` を実行し、`SLACK_BOT_TOKEN` と `ALLOWED_SLACK_TEAM_ID` を設定します。
2. Git管理外の `backend/.data/test-recipients.json` に、テストDMの受信OKをもらった人だけを書きます。モックの人物IDに実際のSlack IDを対応させます。実在のIDはリポジトリに置きません。

   ```json
   [{ "person_id": "00000000-0000-4000-8000-000000000001", "slack_team_id": "T...", "slack_user_id": "U..." }]
   ```

3. `node --env-file=.env backend/scripts/weekly-digest.mjs --send --only=00000000-0000-4000-8000-000000000001`

- このファイルに書いた人だけが同意済みとして扱われます。それ以外の人は送信されません。本文には必ず【テスト送信】の表記が入ります。
- 送信履歴は `backend/.data/slack-deliveries.json`（Git管理外）に残ります。再実行しても、同じ週に二重送信はされません。

## ファイル

- `backend/src/jobs/weeklyDigest.js` — バッチ本体。DB・AI・Slack はすべて引数で差し替えます。
- `backend/src/jobs/scheduled.js` — Cron Trigger 用の入口。#4 の Worker の `scheduled` から呼びます。
- `backend/src/jobs/mock.js` — 架空の人物・投稿・repo・ダミー要約
- `backend/src/slack/client.js` — Slack Web API（`conversations.open` → `chat.postMessage`）
- `backend/scripts/weekly-digest.mjs` — 手動実行CLI
- `backend/test/weeklyDigest.test.js`

## バックエンド担当（#4）と合意したいこと

バッチが依存するのは次の `repo` インターフェースだけです。D1 実装はこれを満たす関数群として用意してもらえれば、そのまま差し替えられます。

| 関数 | 戻り値 |
|---|---|
| `listPersonPosts({ from, to })` | `target_type='person'` かつ `from <= created_at < to` の投稿 `[{ id, author_person_id, target_type, target_id, sentiment, text, created_at }]` |
| `getRecipient(personId)` | `people` の行 `{ id, slack_team_id, slack_user_id, display_name, feedback_opt_in }` または `null` |
| `listDisplayNames()` | 全人物の `display_name`（要約に他人の名前が混ざっていないかの検査用） |
| `getDelivery(personId, weekKey)` | `{ status, ... }` または `null` |
| `claimDelivery(personId, weekKey)` | 未送信 or `failed` なら `sending` に更新して `true`、それ以外は `false`（**原子的に**） |
| `finishDelivery(personId, weekKey, { status, ts?, channel?, error? })` | `status`: `sent` / `failed` / `unknown` |

共通AIモジュールには `summarize({ good: string[], motto: string[] }) => Promise<{ good, motto, needs_review }>` の形を期待しています。投稿者IDや日時は渡しません。`needs_review` は、一意の出来事など特定につながる内容があるときに true を返してもらう想定です。

送信履歴テーブル案（命名は #4 側で決定してOK）:

```sql
CREATE TABLE slack_digest_deliveries (
  person_id TEXT NOT NULL REFERENCES people(id),
  week_key TEXT NOT NULL,          -- 対象週の月曜（JST）例: 2026-10-26
  status TEXT NOT NULL,            -- sending / sent / failed / unknown
  attempts INTEGER NOT NULL DEFAULT 1,
  slack_ts TEXT, error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (person_id, week_key)
);
-- claimDelivery は INSERT ... ON CONFLICT(person_id, week_key) DO UPDATE ... WHERE status='failed' で原子的に行う
```

Worker への組み込み例:

```js
import { scheduledWeeklyDigest } from './jobs/scheduled.js';
export default { fetch: app.fetch, scheduled: scheduledWeeklyDigest };
// wrangler: "triggers": { "crons": ["0 0 * * 1"] }
```

## 運用メモ

- `unknown` は、Slack 側に届いている可能性がある状態です（送信結果が不明、または送信後の記録に失敗）。自動再送はしません。DMが届いたか確認し、届いていなければ履歴を `failed` に戻してから再実行します。
- `sending` のまま残った場合（処理が途中で落ちた場合）も、同じように到着を確認してから手で戻します。
- `held (needs_manual_review)` になった人の分は自動では送りません。内容を人が確認してから扱いを決めます。
