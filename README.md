# Good / Motto

日常の Good / Motto を記録し、場所の状態を M5Stack で可視化し、人物向けの週次フィードバックを Slack で届けるシステムの開発リポジトリです。

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
