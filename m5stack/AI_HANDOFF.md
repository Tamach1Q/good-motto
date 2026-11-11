# GOOD / MOTTO Core2 — AI・開発者向け引き継ぎ

最終更新: 2026-11-11

## 目的と現在地

GitHub Issue #1に従い、場所別のGOOD/MOTTO集計からM5Stack Core2の画面状態を決める端末を開発している。

現在はIssueのPhase 1までを実装したオフラインMVPである。API、データベース、Wi-Fiにはまだ接続しない。固定JSONで、API接続後と同じ解析・色判定・描画経路を実機確認する。

参照先:

- Issue: https://github.com/Tamach1Q/good-motto/issues/1
- API契約: https://github.com/Tamach1Q/good-motto/blob/main/docs/api/contract-v1.md
- リポジトリ: https://github.com/Tamach1Q/good-motto

## 実装済み

- `M5Unified`によるCore2初期化・A/B/Cタッチ入力
- `ArduinoJson`によるAPI契約形式のJSON解析
- Issue指定の5モックケース
- 件数5未満=グレー、GOOD率65%以上=緑、40%以上=黄、それ未満=赤
- 0件時のゼロ除算回避
- 背景色、比率リング、顔、状態文の表示
- 画面上での投稿生件数の非表示
- `M5Canvas`によるダブルバッファ描画
- データ取得元を差し替えるための`CountsProvider`インターフェース

## 重要な設計

```text
CountsProvider
      │
      ├── MockCountsProvider（現在）
      └── HttpsCountsProvider（Phase 2で追加）
              │
              ▼
       API契約形式のJSON
              │
              ▼
       parseCountsJson()
              │
              ▼
       PlaceCounts
              │
              ├── evaluateDisplayState()
              └── calculatePercentages()
                      │
                      ▼
                 Core2 UI
```

HTTP版を追加しても、JSON解析・判定・描画は変更しない方針。

## API契約

入力JSONの形:

```json
{
  "place_id": "laundry",
  "period_days": 7,
  "good_count": 13,
  "motto_count": 7,
  "updated_at": "2026-11-11T00:05:00Z"
}
```

端末は次を検証する。

- 必須キーの存在と型
- `period_days > 0`
- 件数が非負
- `place_id`が端末設定と一致
- `updated_at`が空でない

## モック操作

- A: 前のケース
- B: 次のケース
- C: 再読込

期待結果:

| GOOD/MOTTO | 色 |
| --- | --- |
| 8/12 | 黄 |
| 13/7 | 緑 |
| 7/13 | 赤 |
| 2/1 | グレー |
| 0/0 | グレー |

## Phase 2の実装計画

1. `HttpsCountsProvider`を追加する。
2. Wi-Fi接続情報とトークンを、コミット対象外の`secrets.h`へ分離する。
3. `GET /api/v1/places/{id}/counts`を呼ぶ。
4. `Authorization: Bearer ...`に読み取り専用トークンを使う。
5. サーバー証明書を検証する。`setInsecure()`は本番では使わない。
6. 5分間隔を`millis()`で管理する。
7. 再接続、HTTPエラー、JSONエラー、stale表示を追加する。
8. 最後に成功した値を保持し、通信失敗とデータなしを区別する。

Phase 2開始時に確認が必要な情報:

- ステージングAPIのHTTPSベースURL
- 実機に割り当てる`place_id`
- 読み取り専用Bearerトークンの安全な受け渡し方法
- TLSのルートCAまたは証明書運用方針
- API側のPRがマージされ、ステージングで利用可能か

## やってはいけないこと

- Wi-FiパスワードやBearerトークンをGitへ追加しない
- 投稿者や投稿の生データを画面に表示しない
- `main`または`develop`へ直接pushしない
- Phase 1へ旧MacコントローラーやCore2 HTTPサーバーを混在させない
- 本番HTTPS通信で証明書検証を無効にしない

## ブランチ・PR方針

Issueの指定に従い、作業ブランチ例は`feat/1-m5stack-mood`、PRのbaseは`develop`とする。自動マージはしない。現在のローカル作業は、リモートを設定していないためcommit/pushしていない。

## 主なファイル

- `m5stack.ino`: Phase 1ファームウェア
- `README.md`: 人向けセットアップ・動作確認
- `AI_HANDOFF.md`: この文書

旧`controller.html`はPhase 1では不要かつ誤解を招くため削除済み。
