# GM-005 結合・互換性検証

対応: Refs #4（GM-005のみ）。PRの宛先は `feat/4-backend-api`。API契約は変更しません。

## 再現方法と検証範囲

Node.js 24、npm、Git、tarを使います。リポジトリ直下で実行します。

```sh
npm run ci
npm run verify:branches --prefix backend
git status --short
```

`npm run ci` は依存を入れ直し、既存テストと `backend/test/integration.test.mjs` を実行します。後者は実アプリとMiniflareのローカルD1を使い、Slackの署名鍵は実行時生成、Slack/Gemini通信は全件モックです。他担当ブランチ、Secret、Cloudflareログインに依存しません。GitHub Actionsの `test` も新しいチェックアウトで同じコマンドを実行します。

`verify:branches` はCI対象外です。5173/8787番ポートを空けてください。固定コミットを `git archive` で一時ディレクトリへ展開し、元のWebの `npm run dev` と開発モードの `wrangler dev` を起動します。Webはliveモード、文字数上限500、バイト上限なしで、元のVite proxyを使います。APIは現在の作業ツリーの実装を一時領域へコピーします。手元の `.dev.vars` やSecretを読みません。追加依存（Playwright含む）、Chromium、D1も一時領域に置きます。npm/ブラウザの取得以外はループバック通信とモックだけです。全体600秒、各外部コマンド120秒を上限にし、終了時にはサーバーと一時ファイルを破棄します。実行前後の `git status` と全refsの一致も検査します。

Chromiumの取得・起動ができない環境では、固定Webの `createHttpApi` をNodeから実Vite/Workerに接続して検査し、「実ブラウザ未検証」と出力します。ブラウザを起動できた後の画面検証の失敗はエラーにします。今回の最終結果は下表に記録します。

## 検証結果

実施日: 2026-11-04。バックエンドの基準は `8b8727f`（GM-001〜GM-004マージ済み）と本PRの変更です。氏名、投稿、Slack ID、キーはすべて架空のテスト用データです。

| 対象 | コミット | 実施内容 | 結果 | 問題点・限界 |
| --- | --- | --- | --- | --- |
| Web相当のCI統合テスト | 本PR | productionでOIDCログイン→me→同意→analyze→people/places→投稿→ログアウト。Webのキー・型・created・204検査 | 成功（追加3テスト中の1件） | 外部通信はモック |
| 本文・人物の選択 | 本PR | trim後コードポイント500/501、日本語・絵文字・結合文字。AIの人物IDをnullにし、選択したpeople.idをD1で照合 | 成功 | 実際のGeminiの分類品質は未検証 |
| M5Stack相当 | コードなし | 実API投稿の件数から契約式で色を計算。合計4/5、65%/40%、それぞれの下側、人物投稿の除外と公開5キーを検査 | 成功 | M5Stackの機種・ファームウェア・実機は未検証 |
| 週次内部インターフェース | 本PR | createRepositoryとGemini.summarizeの型・送信履歴・次回getRecipientへの受信撤回反映 | 成功 | 実際のSlack/Geminiへの通信なし |
| Web PR #8 | `e605317b10be7293e2e387c64ef7a61473a1f128` | 元のVite+実Worker+D1をヘッドレスChromiumで操作 | 成功。401→ログイン、403→利用設定、同意→入力→分析→人物選択→投稿201→完了→ログアウト204、500/501文字 | 実サービスの通信はモック |
| Secure Cookie | 同上 | HTTPループバック+Vite proxyでCookie保存と認証APIを確認 | Chromium 141.0.7390.37で受理、me 200 | 他のブラウザ・公開HTTPSでの実OIDCは未検証。属性の緩和なし |
| Originの旧設定 | 同上+本PR | localhost許可設定に対して127.0.0.1のOriginでanalyze | 403 FORBIDDENを再現 | `.dev.vars.example` とbackend READMEを127.0.0.1に修正。Origin判定は完全一致のまま |
| Slack週次 PR #7 | `962148369976a6b1c9b570243a61df93d59a9cd4` | 取り出したrunWeeklyDigestに実D1 repo、Gemini要約モック、偽deliverを注入 | 成功 | 実SlackのDMは未検証・送信なし |
| 週次のガード・冪等性 | 同上 | 投稿者3人ならdry-run本文生成、2人なら保留、未同意/別チームskip。400文字許可、401文字/数字/引用符は保留。本実行は偽deliver1回、同週再実行はalready_sent。撤回後no_consent | 成功 | 匿名性の保証や実データでの要約品質は評価していない |
| scheduled組み込み例 | 同上 | `{ fetch: app.fetch, scheduled: scheduledWeeklyDigest }` のfetchとscheduled呼び出し | fetchは動作。D1ありでは警告を出してskip | PR #7側の入口はD1 repo/要約が未接続。今回変更せず、マージ後に実装が必要 |
| マージ見通し | 基準ブランチ対各固定コミット | 3引数の読み取り専用git merge-tree | PR #7はREADME.mdだけ衝突、PR #8は衝突なし | マージ順・今後の変更で変化する。実マージは行っていない |
| 実サービス | — | 実Slack/Gemini/Cloudflare、M5Stack実機 | **未検証** | 接続、Secret使用、デプロイ、DM送信は実施していない |

`npm run ci` は201件すべて成功しました（新規3件、既存198件）。`verify:branches` も終了コード0で完了し、一時ファイルとサーバーの破棄、実行前後の作業ツリー状態・全refsの一致を確認しました。Webの初回実行では204の本文取得を要求した検証側の不具合があり、修正後の再実行で全経路が成功しました。アプリの既存テストは変更・弱体化していません。

## PR #8マージ後の作業

- Workers Static AssetsでWebのビルド出力を配信する設定を追加し、WebとAPIを同一オリジンにする。
- 現在のWorkerは `/` を返さないため、本番構成ではログイン後のリダイレクト先が404になる。Viteの開発サーバーで成功しても本番配信の検証にはならない。
- `VITE_POST_MAX_CHARACTERS` を契約の上限に設定し、`VITE_POST_MAX_BYTES` で独自上限を加えない。固定コミットのHANDOFFには上限未合意の古い記述が残るため、マージ後に担当者が文書を更新する。
- 本番HTTPS・実SlackログインとCookieの受理、同意保存、投稿、ログアウトを通して確認する。

## PR #7マージ後の作業

- Workerの `scheduled` を追加し、Wranglerに `crons: ["0 0 * * 1"]`（月曜09:00 JST）を設定する。
- `scheduled.js` のD1ありでskipする分岐を、`createRepository(env.DB)` と `createGemini(...).summarize` を使う処理に接続する。
- `SLACK_BOT_TOKEN` と許可チームを設定し、明示同意したテスト受信者だけでSlack接続を確認する。
- 最初はdry-runで本文と匿名性ガードを人が確認する。`sending` / `unknown` の照合、保留の手動確認、失敗時の再実行手順を決める。

これらのscheduled、crons、静的アセット設定は本PRには追加していません。PR #7・#8へのコミット、コメント、マージも行っていません。

## 本番前に人が準備・判断すること

- 学校のSlack管理者の承認、Slack Appの作成・必要権限、学校のワークスペースID、公開HTTPS URLとRedirect URL。
- 本番D1の作成、`database_id` とバインディング、マイグレーション。開発シードを本番へ入れない。
- 各Secretの発行・設定・ローテーションと管理担当。端末用キーは読み取り専用で配布し、M5Stackの機種と配布・失効方法を決める。
- Gemini無料枠に実データを送るかどうか、説明と同意、データ最小化。
- 匿名性のしきい値（独立投稿者3人は暫定）、少人数・特定可能な内容の保留と手動確認、確認者と記録の保管方法。
- Slack退会者の無効化、既存セッションの失効、アカウントと投稿の削除、利用同意撤回の運用手順。

## 本番前の技術確認

- 実際のGeminiで疎通、制限・エラー、非攻撃性と再識別リスク、引用・人物名・数字・400文字など要約の品質を確認する。
- 実際のSlackで署名済みOIDCログイン、チーム制限、公開HTTPS URLへの復帰を確認する。Botによる送信も別途明示同意した対象だけで確認する。
- 未認証の `login` が `oauth_states` を増やせる。期限切れの掃除はあるが、開始リクエスト自体の429制限は未実装。公開前に回数制限と監視を設計・確認する。
- 実機で端末認証、5分ごとの取得、色の境界、通信断時の古い値・エラー表示を確認する。

## 環境ごとの設定一覧（値は記載しない）

| 環境 | 変数・バインディング名 | 扱い |
| --- | --- | --- |
| ローカルWorker | `ENV`, `ALLOWED_ORIGIN`, `M5_DEVICE_KEY`, `DB` | モックログイン、単一Origin、端末用キー、ローカルD1。Git管理外の.dev.varsを使う |
| ローカルWorkerでGeminiを使う場合 | `GEMINI_API_KEY`, `GEMINI_MODEL` | 両方必要。今回の検証は未設定の固定分析か通信モック |
| ローカルWeb | `VITE_API_MODE`, `VITE_POST_MAX_CHARACTERS`, `VITE_POST_MAX_BYTES`, `VITE_API_BASE_URL` | 実API接続モードと契約の文字数を指定。バイト上限とbase URLは未指定で同一Origin proxyを使う |
| CI統合テスト | `DB`と上記Worker/OIDC/Gemini設定名 | テスト内部のローカルD1・架空値のみ。外部Secret不要 |
| 固定ブランチ検証 | ローカルWorker/Web設定名、`CI`, `WRANGLER_SEND_METRICS`, `PLAYWRIGHT_BROWSERS_PATH`, `XDG_CONFIG_HOME`, `WRANGLER_LOG_PATH` | スクリプトが一時領域へ設定。利用者のSecret環境変数を子プロセスへ渡さない |
| staging / production | `ENV`, `DB`, `ALLOWED_ORIGIN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`, `ALLOWED_SLACK_TEAM_ID`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `M5_DEVICE_KEY` | OIDC必須設定と本番D1。secret類はWorker Secretsで管理 |
| PR #7マージ後の週次 | `SLACK_BOT_TOKEN`, `ALLOWED_SLACK_TEAM_ID`, `DB`, `GEMINI_API_KEY`, `GEMINI_MODEL` | scheduledから実repo/要約を呼ぶ組み込みが別途必要 |
| 本番Webビルド | `VITE_API_MODE`, `VITE_API_BASE_URL`, `VITE_POST_MAX_CHARACTERS`, `VITE_POST_MAX_BYTES` | 同一オリジン配信、契約どおりの文字数、独自のバイト上限なし |

Secret扱いは `SLACK_CLIENT_SECRET`、`GEMINI_API_KEY`、`SLACK_BOT_TOKEN`、`M5_DEVICE_KEY` です。値・実在人物・実投稿はこの文書にも検証出力にも残しません。
