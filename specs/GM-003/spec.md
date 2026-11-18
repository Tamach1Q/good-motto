# GM-003 — Gemini連携

対応Issue: #4 のうちGM-003のみ（PRは `Refs #4`。`Closes` にしない）
PRの宛先: `feat/4-backend-api`（`main` へは全タスク完了後に別途PRを作る）
前提: GM-001（Hono API）とGM-002（ローカルD1）はマージ済み。GM-004・GM-005は別タスク。本タスクでは着手しない。

## なぜ作るか

`POST /posts/analyze` はまだ固定応答で、週次処理（PR #7）には本物の要約手段がない。

GM-003の目的は、**自由記述をGeminiで分類して投稿者に提案できるようにし、週次処理が使える共通の要約モジュールを用意すること**。扱うのは他人への不満を含み得る文章なので、外部へ送る内容を最小にし、AIの出力を信用しすぎないことを同じくらい重視する。

## 読むもの（この順で優先）

1. `docs/api/contract-v1.md`（通信の唯一の正。特に §1 と「機密情報・利用上の注意」）
2. `docs/auth/slack-oidc-v1.md`（特に §6 人物を間違えずに特定する）
3. `CONTRIBUTING.md`（特に §1 モック、§3 PR記載事項、§6 秘密情報）
4. `backend/README.md`

## 範囲に含めるもの

- `POST /api/v1/posts/analyze` のGemini接続
- 週次処理向けの共通要約モジュール `summarize`
- 外部APIをモックした自動テスト

## 範囲に含めないもの

- 実Slack OIDC、D1セッション（GM-004）
- 週次ジョブの組み込み、Cron、Slack送信（GM-005）
- 実際のGemini APIの呼び出し（キーは用意されていない）。自動テストでも手動でも呼ばない
- 本番環境の設定、デプロイ
- OpenAI APIなどGemini以外のAI。使わない
- PR #7・#8のマージ、`frontend/`・M5Stack・`backend/src/jobs/`・`backend/src/slack/` の変更
- 自前のレート制限、応答のキャッシュ、自動リトライ

## 受け入れ条件

### A. 動作モード

| `ENV` | `GEMINI_API_KEY` と `GEMINI_MODEL` | `analyze` の動作 |
| --- | --- | --- |
| `development` | 両方なし | 今までの固定応答（ローカル開発用） |
| `development` | 両方あり | Geminiを呼ぶ |
| `development` | 片方だけ | 503 |
| それ以外 | 問わない | 503。固定応答を返さない |

- [ ] 上の4行をテストする。GM-004で開発モード以外のAPIが有効になっても固定応答が出ないよう、固定応答の選択は `ENV` を直接確認する
- [ ] モデルIDをコードに固定しない。`GEMINI_MODEL` だけで決める（契約どおり）
- [ ] `backend/.dev.vars.example` には変数名だけを追加し、値を入れない

### B. Geminiへ送る内容（データ最小化）

- [ ] `analyze` が送るのは、trim後の本文と `places` の `id` と `name` だけ
- [ ] 人物の氏名一覧、人物ID、投稿者の情報、Slack ID、セッションを送らない。モックした `fetch` の送信内容に含まれないことをテストする（シードの `display_name` を使う）
- [ ] APIキーはURLに入れず、ヘッダーで送る。ブラウザへ渡さない
- [ ] 401・403・400になるリクエストではGeminiを呼ばない（呼び出し回数0をテスト）。認証、同意、Origin、本文の検証を先に行う
- [ ] `analyze` はD1に本文を保存しない（テスト必須）
- [ ] 本文、Geminiの応答、APIキーをログに出さない（テスト必須）

### C. `analyze` の応答

応答は常に契約の4キーだけ。Geminiの出力は信用せず、次の表のとおりサーバーで検証して組み立てる。

| Geminiの出力 | APIの応答 |
| --- | --- |
| `place` で、`target_id` が `places` に存在する | `target_type:"place"`、`target_id` はそのID、`target_label` は**D1の** `places.name` |
| `place` で、`target_id` が存在しない・空 | `target_type:"place"`、`target_id:null`、`target_label` は下記の検証を通った値か `null` |
| `person` | `target_type:"person"`、`target_id` は**常に** `null`、`target_label` は下記の検証を通った値か `null` |
| `unknown`、または `target_type` がそれ以外の値 | `target_type:"unknown"`、`target_id:null`、`target_label:null` |

- [ ] `target_label` の検証: 文字列で、trim後1〜50文字。それ以外は `null`
- [ ] Geminiが人物IDらしき値（シードのUUIDなど）を返しても応答に出さない。余分なキーも出さない（テスト必須）
- [ ] 本文に指示文が含まれていても、結果は上の表の範囲を出ない。Geminiにツールや関数呼び出しを渡さない。本文はプロンプト内でデータとして明確に区切る

### D. `analyze` の失敗時

| 状況 | APIの応答 |
| --- | --- |
| Geminiが429 | `429` `RATE_LIMITED` |
| Geminiのその他のエラー、通信失敗 | `503` `SERVICE_UNAVAILABLE` |
| 15秒以内に応答がない（Webは20秒で打ち切る） | `503` `SERVICE_UNAVAILABLE` |
| 応答が空、安全性フィルタでブロック、JSONでない | `503` `SERVICE_UNAVAILABLE` |
| `sentiment` が `good|motto` 以外（判定不能を含む） | `503` `SERVICE_UNAVAILABLE` |

- [ ] 上の各行をテストする。Webは503のとき本文を残して入力画面へ戻す
- [ ] 失敗時に固定応答へ切り替えない。自動リトライしない
- [ ] エラー応答にGeminiの詳細、本文、キーを含めない

### E. 共通要約モジュール `summarize`

- [ ] `backend/src/ai/` など `jobs/` 以外の場所に置き、設定（キー、モデル、`fetch`）を受け取って `summarize` を返す形で公開する。HTTPに公開しない
- [ ] PR #7 の期待どおり、`summarize({ good: string[], motto: string[] })` は `Promise<{ good: string, motto: string, needs_review: boolean }>` を返す
- [ ] 送るのは `good` と `motto` の本文だけ。引数に別のキー（投稿者ID、日時など）があっても送らないことをテストする
- [ ] 片方が空配列なら、その側の結果は Geminiの出力によらず空文字列。両方空ならGeminiを呼ばない
- [ ] 失敗（エラー、429、30秒のタイムアウト、JSONでない、型違い、`needs_review` が真偽値でない）は例外を投げる。例外のメッセージに本文を含めない。PR #7はこれを `summarize_failed` として扱う
- [ ] 固定の文章へ切り替えない。自動リトライしない（週次処理の再実行に任せる）。結果の切り詰めもしない（超過はPR #7が保留にする）

プロンプトには次の要件を含める。PR #7の検査で保留になる文章を減らすためのもの。

- [ ] 受信者本人に向けた、建設的で攻撃的でない日本語にする
- [ ] 原文を引用・転載しない。人物名を書かない
- [ ] 数字、日時、曜日、部屋番号、かぎかっこ・引用符を使わない（PR #7の検査で手動確認に回される）
- [ ] `good` と `motto` はそれぞれ400文字以内（PR #7の上限）
- [ ] 特定の出来事や個人を推測できそうな内容が残るときは `needs_review` を `true` にする
- [ ] 実際の文章の品質は、実キーでの確認が必要な項目としてPRに書く

### F. 共通

- [ ] GM-001とGM-002の受け入れ条件を維持する。既存テストを弱めない（変更する場合はPRに理由を書く）
- [ ] 架空の人物名・架空の投稿だけを使う（CONTRIBUTING §1）。秘密情報をコミットしない
- [ ] `backend/README.md` に、モードの切り替え、必要な環境変数、実キーで確認する手順、**実在の人物や不満を確認に使わないこと**、無料枠では送信内容がサービス改善に使われる場合があることを書く

### G. 検証

- [ ] Geminiへの通信はすべてモックする。テストはキー、外部通信（依存の取得を除く）、Cloudflareへのログインを必要としない
- [ ] 新しいチェックアウトで、リポジトリ直下の `npm run ci` だけで依存のインストールとテストが完了する。GitHub Actionsの `test` ジョブも成功する
- [ ] PR #7 のテスト実行方法（`node --test backend/test/*.test.js`）を壊さない配置にする
- [ ] ローカルの `wrangler dev` を起動し、Geminiの代わりにローカルのスタブへつなぐか固定応答モードで、ログイン→`analyze`→投稿をHTTPで確認し、結果をPRに書く
- [ ] PR本文に CONTRIBUTING §3 の6項目と、実行したテストコマンド・結果を書く。**実際のGeminiでは未検証であること**を「何をしていないか」に明記する

## API契約について

このタスクで契約の変更は不要。エンドポイント名、HTTPメソッド、JSON形式を変えない。実装者は契約を変更しない。契約とこの仕様が食い違う場合は実装を進めず、PRに食い違いを書く。
