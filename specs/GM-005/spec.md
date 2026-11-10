# GM-005 — 結合・互換性検証

対応Issue: #4 のうちGM-005のみ（PRは `Refs #4`。`Closes` にしない）
PRの宛先: `feat/4-backend-api`（`main` へは全タスク完了後に別途PRを作る）
前提: GM-001〜GM-004はマージ済み。

## なぜ作るか

4つの担当は同じ契約を見て別々に作ってきたが、実際のコード同士をつないだことはない。

GM-005の目的は、**PR #7・#8をマージせずに、実際のコードとバックエンドがつながることを確かめ、つながらない点と残作業を明らかにすること**。検証で見つけた問題を隠さず報告することも成果物に含む。

## 読むもの（この順で優先）

1. `docs/api/contract-v1.md`
2. `docs/auth/slack-oidc-v1.md`
3. `docs/architecture/README.md`
4. `CONTRIBUTING.md`（特に §1 モック、§3 PR記載事項、§6 秘密情報）
5. `backend/README.md`
6. PR #8 のブランチ `origin/feat/3-web-posting`（`frontend/src/api.ts`、`frontend/vite.config.ts`、`frontend/HANDOFF.md`）
7. PR #7 のブランチ `origin/feature/slack-weekly-digest`（`backend/src/jobs/`、`backend/src/slack/`、`docs/slack/weekly-digest.md`）

## 検証の対象

他担当のコードは次の時点のものを使う。**マージ、取り込み、変更をしない。**

| 対象 | ブランチ | コミット |
| --- | --- | --- |
| Web（PR #8） | `origin/feat/3-web-posting` | `e605317` |
| Slack週次（PR #7） | `origin/feature/slack-weekly-digest` | `9621483` |
| M5Stack（Issue #1） | コードなし | 契約の計算式で確認し、実機は未検証と記録する |

## 範囲に含めないもの

- PR #7・#8のマージ、コミット、コメント。`frontend/`、`backend/src/jobs/`、`backend/src/slack/`、M5Stackのファイルをこのリポジトリに追加しない
- 実際のSlack、Gemini、Cloudflareへの接続。Secretの使用。`--remote`、デプロイ、DM送信
- `wrangler` への `crons` と静的アセットの設定、Workerの `scheduled` の追加（下記 D節。PR #7・#8のマージ後に行う）
- API契約の変更

## 受け入れ条件

### A. リポジトリに残す統合テスト（`npm run ci` で実行）

`backend/test/` に `.test.mjs` として追加する。実際のアプリとローカルD1を使い、外部通信はモックする。他担当のブランチに依存しない。

Web相当:

- [ ] `production` モード（Slackはモック）で、ログイン→`/me`→利用同意→`analyze`→`/people`・`/places`→投稿→ログアウトを1本の流れとして確認する。Originは設定したものを送る
- [ ] 各応答が PR #8 の `api.ts` の検証を通る形であることを確認する（キー、型、`status:"created"`、ログアウトの204）
- [ ] 500文字と501文字を、Webと同じ数え方（trim後のUnicodeコードポイント）で確認する
- [ ] AIが人物らしき結果を返しても、投稿にはユーザーが選んだ `people.id` が保存されることを確認する

M5Stack相当:

- [ ] 実際の投稿から件数を作り、契約の計算式で表示色を確認する: 合計5件未満はグレー、Good率65%以上は緑、40%以上は黄、それ未満は赤。境界（65%、40%、合計4件と5件）を含める
- [ ] 応答に本文、人物情報、投稿者情報が含まれないことを確認する。人物宛ての投稿が件数に入らないことを確認する

週次処理相当:

- [ ] `createRepository` と `createGemini().summarize`（通信はモック）が `docs/slack/weekly-digest.md` のインターフェースを満たすことを確認する
- [ ] 同意の撤回が次回の `getRecipient` に反映されることを確認する

### B. 他担当の実コードとの検証スクリプト（`npm run ci` には含めない）

`backend/package.json` に `verify:branches` を追加する。コミットを固定して一時ディレクトリへ取り出し、作業ツリーとGitの履歴を変更せず、終了時に一時ファイルとサーバーを片付ける。追加の依存が必要なら一時ディレクトリに入れ、`backend/package.json` に加えない。

Web（PR #8）:

- [ ] 取り出した `frontend/` の `npm run dev`（`VITE_API_MODE=live`、`VITE_POST_MAX_CHARACTERS=500`）と、開発モードの `wrangler dev` を起動する。設定は実際の開発手順と同じにする
- [ ] **ヘッドレスChromium**で、ログイン→利用同意→本文入力→分析→対象選択→投稿→完了→ログアウトまで画面を操作して確認する
- [ ] 実ブラウザが `__Host-gm_session`（`Secure`）をこの構成で受け付けるかを確認し、結果を記録する。受け付けない場合は、GM-001の条件に従い、モックモードだけCookieの属性を変えて対応する
- [ ] 401と403の画面の分岐（未ログインでログイン画面、未同意で設定画面）を確認する
- [ ] Chromiumをこの環境で動かせない場合は、代わりに `createHttpApi` をNodeから実サーバーへ向けて確認し、**実ブラウザは未検証**とPRに明記する。確認できたふりをしない

週次処理（PR #7）:

- [ ] 取り出した `runWeeklyDigest` に、実際の `createRepository`（ローカルD1）、`createGemini().summarize`（通信はモック）、偽の `deliver` を渡して実行する。Slackへは送信しない
- [ ] dry-runで、投稿者3人以上の受信者は本文が生成され、3人未満は保留、未同意と別ワークスペースはスキップされることを確認する
- [ ] dry-runを外して偽の `deliver` で実行し、1回だけ送られ、同じ週の再実行で再送されないことを確認する
- [ ] 取り出した `backend/src/jobs/scheduled.js` の組み込み例（`{ fetch: app.fetch, scheduled }`）が動く形か確認し、結果を記録する。同ファイルは現在D1があると処理をスキップするので、その旨も記録する
- [ ] モック要約が、PR #7の検査（数字、引用符、400文字）を通る場合と保留になる場合の両方を確認する

マージの見通し:

- [ ] `git merge-tree` で、`feat/4-backend-api` とPR #7・#8の衝突を確認して記録する（読み取りのみ。現時点ではPR #7の `README.md` のみと見込まれる）

### C. 見つかった問題の扱い

- [ ] **既知の問題を直す**: PR #8の開発サーバーは `vite --host 127.0.0.1` で起動するので、ブラウザのOriginは `http://127.0.0.1:5173` になる。`backend/.dev.vars.example` の `ALLOWED_ORIGIN` は `http://localhost:5173` のままで、Originは完全一致で判定するため、更新系のAPIが403になるはずである。実際に再現して記録し、`.dev.vars.example` と `backend/README.md` を実際の起動方法に合わせる。判定を緩めない（複数Originやワイルドカードにしない）
- [ ] バックエンドが契約に違反している問題は、契約を変えずにこのPRで直す
- [ ] 他担当のコードの問題は、変更せずに結果へ記録する。**他担当の問題が残っていても、記録できていればこのタスクの失敗としない**
- [ ] 契約を変えないと解決できない問題は、実装を進めず結果へ記録する

### D. 文書

`docs/integration/README.md` を追加し、READMEからリンクする。

- [ ] 検証結果の表: 対象、コミット、実施内容、結果、問題点。実施していないものは未検証と書く
- [ ] PR #8のマージ後に必要な作業: Workers Static Assetsの設定（現在はWorkerが `/` を返さないので、本番ではログイン後に404になる）
- [ ] PR #7のマージ後に必要な作業: Workerの `scheduled`、`crons`（`0 0 * * 1`）、`scheduled.js` からの `createRepository` と `summarize` の呼び出し、`SLACK_BOT_TOKEN`
- [ ] 本番前に必要な人の作業と判断: 学校のSlack管理者の承認、Slack App、ワークスペースID、公開HTTPS URL、本番D1と `database_id`、各Secret、M5Stackの機種と端末キーの配布、Geminiの無料枠を実データに使うか、匿名性のしきい値と手動確認の運用、退会者の無効化と削除の手順
- [ ] 本番前の技術的な確認事項: 実際のGeminiでの疎通と要約の品質、実際のSlackでのログイン、未認証の `login` が `oauth_states` を増やせること（429は未実装）
- [ ] 環境ごとの環境変数の一覧。値は書かない
- [ ] 実在の人物、実データ、Secretを書かない

### E. 共通

- [ ] GM-001〜GM-004の受け入れ条件を維持する。既存テストを弱めない（変更する場合はPRに理由を書く）
- [ ] 架空の人物名、架空の投稿、存在しないSlack IDだけを使う
- [ ] テストと `verify:branches` はSecretとCloudflareへのログインを必要としない

### F. 検証

- [ ] 新しいチェックアウトで、リポジトリ直下の `npm run ci` だけで依存のインストールとテストが完了する。GitHub Actionsの `test` ジョブも成功する。`verify:branches` はCIで実行しない
- [ ] `npm run verify:branches --prefix backend` を実際に実行し、結果をPRと `docs/integration/README.md` に書く
- [ ] 実行後に `git status` で作業ツリーに変更が残らないことを確認する
- [ ] PR本文に CONTRIBUTING §3 の6項目を書く。「何をしていないか」に、実際のSlack、Gemini、Cloudflare、M5Stack実機は未検証であることを明記する

## API契約について

このタスクで契約の変更は不要。エンドポイント名、HTTPメソッド、JSON形式を変えない。実装者は契約を変更しない。
