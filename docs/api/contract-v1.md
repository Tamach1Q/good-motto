# Good/Motto — API契約 v1（4人開発用）

状態: 設計案 / 実装未完了。全担当はこの入出力を共通仕様とする。

## 技術スタック

- スマホ: React + TypeScript + Vite
- API・DB: Cloudflare Workers + Hono + D1
- AI: **Gemini API**（モデルIDは `GEMINI_MODEL` で管理し、無料枠対象モデルを選ぶ）
- M5Stack: Arduino C++ + M5Unified
- Slack通知: Cloudflare Cron Triggers / Slack Web API

通信は HTTPS、データは UTF-8 / JSON。APIのプレフィックスは `/api/v1`。

## エンドポイント

### 1. `POST /api/v1/posts/analyze`

ユーザーが入力した自由記述をGeminiで分類する。結果は**提案**でありユーザーが修正できる。

Request:

```json
{"text":"共用キッチンが汚くてイライラした"}
```

Response (200):

```json
{"sentiment":"motto","target_type":"place","target_id":"kitchen","target_label":"共用キッチン"}
```

- `sentiment`: `good | motto`
- `target_type`: `person | place | unknown`
- `target_id`: 対象ID。曖昧な場合は `null`
- 対象が分からなければ人に選択を促す。Geminiの推論だけで人物IDを決めつけない。

### 2. `POST /api/v1/posts`

ユーザーが分類を確認・修正した後、投稿を保存。

Request:

```json
{"text":"共用キッチンが汚くてイライラした","sentiment":"motto","target_type":"place","target_id":"kitchen"}
```

Response (201):

```json
{"post_id":"post_001","status":"created"}
```

投稿者IDと投稿日時はサーバー側で設定する。未認証投稿は禁止。対象IDと種類の組み合わせを検証する。

### 3. `GET /api/v1/places`

Response (200):

```json
{"places":[{"id":"kitchen","name":"共用キッチン"},{"id":"laundry","name":"洗濯室"}]}
```

### 4. `GET /api/v1/people?query=田中`

本人確認用の人物候補検索。検索結果はログインユーザーに許可された候補に限定。

Response (200):

```json
{"people":[{"id":"person_001","name":"田中さん"}]}
```

### 5. `GET /api/v1/places/{id}/counts`

**M5Stackが5分おきに呼び出す。割合や色は返さない。**

Response (200):

```json
{"place_id":"kitchen","period_days":7,"good_count":8,"motto_count":12,"updated_at":"2026-11-04T04:00:00Z"}
```

- 対象は `target_type=place` かつ指定 `place_id` の投稿のみ。
- `good_count` / `motto_count` は 0 以上の整数。直近7日間（日本時間基準）の件数。
- 投稿テキスト・人物情報・投稿者情報をM5Stackへ返さない。
- 端末専用の読み取り権限で取得する（認証方式・鍵配布はバックエンド担当が確定）。
- MVPはAPIがD1から件数をSQL集計して返す。場所の日次バッチは必須ではない。

## M5Stackの表示計算（端末担当）

```text
total = good_count + motto_count
if total < 5 -> gray
else:
  good_rate = good_count / total
  if good_rate >= 0.65 -> green
  else if good_rate >= 0.40 -> yellow
  else -> red
```

`good_count=8, motto_count=12` は40%なので黄色。
通信エラーは前回値を古い情報と明示するかエラー表示し、最新の傾向だと誤認させない。端末画面に投稿件数や投稿者を表示しない。

## Slack週次処理（内部バッチ）

HTTP APIとして外部公開せず、バックエンドのスケジュール実行で処理。
暫定実行時刻: **毎週月曜日09:00 JST**（Cloudflare Cronでは月曜00:00 UTC）。

1. 人物宛ての直近1週間の投稿を受信者ごとに抽出する。
2. DM受信の同意と、匿名性・再識別リスクを確認する。
3. GeminiでGood/Mottoを建設的・非攻撃的な文章に要約する。
4. Slack Web APIで本人へDMを送る。
5. 同じ週・同じ受信者には二重送信しない（冪等性）。
6. 失敗はログに残し、再実行可能にする。

初期の匿名性ガード案: 独立した投稿者が3人未満なら個別DMは送らない。3人以上でも特定可能な内容は削除・抽象化し、原文の転送は禁止。本人の同意がない場合も送信しない。しきい値や運用は利用開始前に合意する。

## 共通のエラー形式

```json
{"error":{"code":"INVALID_REQUEST","message":"入力を確認してください"}}
```

- `400`: 不正な入力
- `401/403`: 認証・権限エラー
- `404`: 対象なし
- `429`: 回数制限
- `500/503`: サーバーまたは外部APIでの失敗

## 機密情報・利用上の注意

- `GEMINI_API_KEY`、`SLACK_BOT_TOKEN`、デバイスキーは**サーバー/端末のシークレット設定**で管理し、Gitにコミットしない。
- Gemini無料枠はレート制限があり、公式案内では無料枠の送信データがサービス改善に使われる場合がある。人物への不満等のセンシティブな原文を外部送信する前に同意と匿名化・データ最小化を検討する。
- 認証、投稿者識別、ユーザーとSlack IDの対応付けはバックエンド担当とSlack担当の共通課題。最初に契約を合意する。

参考: https://ai.google.dev/gemini-api/docs/pricing
