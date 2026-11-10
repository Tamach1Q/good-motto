# Good / Motto

日常の Good / Motto を記録し、場所の状態を M5Stack で可視化し、人物向けの週次フィードバックを Slack で届けるシステムの開発リポジトリです。

## API・Slack OIDC・D1・Gemini（GM-004）

Workers + Honoの10エンドポイントを、ローカルD1と架空データで確認できます。ログインはローカル開発のみモック、production/stagingでは単一ワークスペースのSlack OIDCです。ローカル分析はGemini設定が両方空なら固定応答、`GEMINI_API_KEY` と `GEMINI_MODEL` を両方指定するとGeminiを使います。片方だけの指定は503です。Node.js 24を使用し、リポジトリ直下で次を実行してください。

```sh
npm run ci
npm run db:migrate --prefix backend
npm run db:seed --prefix backend
cp backend/.dev.vars.example backend/.dev.vars
# backend/.dev.vars の M5_DEVICE_KEY をローカル専用のランダム値に置き換える
npm run dev --prefix backend
```

ベースURLは `http://127.0.0.1:8787`。`ENV=development`はループバック限定です。`production` / `staging`はSlack OIDC必須設定とD1がすべてあればAPIが動作し、analyzeはGemini設定が両方必要です。未設定・その他のモードや必須設定欠落は全APIが503です。投稿・同意・セッションはD1に保存され、再起動後も同じCookieが有効です。実際のSlackとの接続、Geminiとの疎通・文章品質は未検証です。実在の人物や不満は確認に使わないでください。設定、実キーで後日確認する手順、内部要約モジュール、架空ユーザーの切替、curl例、Viteのliveモードでの結合確認手順、未実装の範囲は [backend/README.md](backend/README.md) を参照してください。

## システム設計

- [システム構成図・設計案](docs/architecture/README.md)
- [C4 Container図（SVG）](docs/architecture/good_motto_c4_container.svg)
- [データフロー図（SVG）](docs/architecture/good_motto_dataflow.svg)
- [API契約 v1（4人共通）](docs/api/contract-v1.md)



## 開発ブランチとPull Request

- 通常の開発PRは **`develop` 宛（base: `develop`）** に作成してください。**`main` 宛に作成しないでください。**
- 担当者・AIエージェントは各機能ブランチ（head）で作業し、`main` / `develop` に直接pushしません。
- PRを作っても自動ではマージしません。レビューとCI確認後にチームでマージを判断します。
- 作業前に [CONTRIBUTING.md](CONTRIBUTING.md) を必ず読んでください。

## 共同開発

- [GitHub運用ルール](CONTRIBUTING.md)
- [Slack OpenID Connect 認証設計 v1（採用方式）](docs/auth/slack-oidc-v1.md)
- [認証方式の比較資料](docs/auth/identity-options.md)

## 結合・互換性検証（GM-005）

`npm run ci` は他担当ブランチに依存しない統合テストも実行します。`npm run verify:branches --prefix backend` はPR #7・#8の固定コミットを一時領域に展開して実コードとの接続を確認します（CI対象外）。ヘッドレスChromium、ローカルD1、モックの外部通信を使い、実サービスのSecretは不要です。実行方法、検証結果と本番前の残作業は [結合・互換性検証](docs/integration/README.md) を参照してください。
