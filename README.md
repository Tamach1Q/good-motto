# Good / Motto

日常の Good / Motto を記録し、場所の状態を M5Stack で可視化し、人物向けの週次フィードバックを Slack で届けるシステムの開発リポジトリです。

## Slack 週次ブリーフ（Issue #2）

人物宛ての Good/Motto を週1回まとめ、受信に同意した本人に Slack DM で送るバッチです（独立した投稿者数などの暫定ガード付き。匿名性を保証するものではありません）。現在はモックで動作します（Node.js 22以上、追加依存なし）。

```sh
node backend/scripts/weekly-digest.mjs
```

詳細は [週次ブリーフ](docs/slack/weekly-digest.md)、Bot の作成手順は [Slack Bot](docs/slack/README.md) を参照してください。Gemini要約とD1接続は #4 と連携して実装予定です。

## システム設計

- [システム構成図・設計案](docs/architecture/README.md)
- [C4 Container図（SVG）](docs/architecture/good_motto_c4_container.svg)
- [データフロー図（SVG）](docs/architecture/good_motto_dataflow.svg)
- [API契約 v1（4人共通）](docs/api/contract-v1.md)



## 共同開発

- [GitHub運用ルール](CONTRIBUTING.md)
- [Slack OpenID Connect 認証設計 v1（採用方式）](docs/auth/slack-oidc-v1.md)
- [認証方式の比較資料](docs/auth/identity-options.md)
