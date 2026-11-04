# Good / Motto

日常の Good / Motto を記録し、場所の状態を M5Stack で可視化し、人物向けの週次フィードバックを Slack で届けるシステムの開発リポジトリです。

## ローカルAPIとD1（GM-002）

Workers + Honoの10エンドポイントを、ローカルD1と架空データで確認できます。ログインと分析はモックです。Node.js 24を使用し、リポジトリ直下で次を実行してください。

```sh
npm run ci
npm run db:migrate --prefix backend
npm run db:seed --prefix backend
cp backend/.dev.vars.example backend/.dev.vars
# backend/.dev.vars の M5_DEVICE_KEY をローカル専用のランダム値に置き換える
npm run dev --prefix backend
```

ベースURLは `http://127.0.0.1:8787`。開発設定を明示したローカル環境だけで動作し、それ以外は503を返します。投稿と同意はD1に保存され、開発サーバーの再起動後も残ります。設定、架空ユーザーの切替、curl例、Viteのliveモードでの結合確認手順、未実装の範囲は [backend/README.md](backend/README.md) を参照してください。

## システム設計

- [システム構成図・設計案](docs/architecture/README.md)
- [C4 Container図（SVG）](docs/architecture/good_motto_c4_container.svg)
- [データフロー図（SVG）](docs/architecture/good_motto_dataflow.svg)
- [API契約 v1（4人共通）](docs/api/contract-v1.md)



## 共同開発

- [GitHub運用ルール](CONTRIBUTING.md)
- [Slack OpenID Connect 認証設計 v1（採用方式）](docs/auth/slack-oidc-v1.md)
- [認証方式の比較資料](docs/auth/identity-options.md)
