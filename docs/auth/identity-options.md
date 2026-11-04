# 認証と人物IDの管理 — 選択肢と推奨案

状態: **検討中（未決定）**。本番利用や実在人物へのDMの前にチームで決定する。

## 問題を3つに分ける

1. **ログイン認証**: 今投稿しているのは誰か
2. **人物マスタ**: 文章中の「田中さん」がどの内部ユーザーか
3. **Slack送信先**: 本人のSlackユーザーID（＋所属ワークスペース）をどう取得するか

「匿名フィードバック」は**受信者から投稿者を見えなくする**という意味。サーバーも投稿者不明にすると、なりすまし・大量投稿の対策や同意判定が難しい。サーバーは投稿者IDを保持し、受信者には渡さない。

## 候補A: Slackでログイン（同じSlackワークスペースが前提 / 推奨候補）

Slack公式の *Sign in with Slack* （OpenID Connect）を使う。

- 利用者はスマホで「Slackでログイン」。
- バックエンドがSlackの署名済み認証結果を検証し、許可したワークスペースだけを受け入れる。
- Slackから `team_id` と `user_id` を取得して、内部 `person_id` に紐づける。
- 投稿者はサーバーがログイン情報から確定する。クライアントが自由な `author_id` を送れない。
- 受信者は、同意済みの人物マスタから選択。SlackへのDMは同じ人物に紐づいた `slack_user_id` に送る。
- 投稿本文に書かれた名前だけで人物を特定しない。ユーザーが候補から選ぶ。

**長所:** SlackユーザーIDとの一致が明確。パスワードを自作しない。

**注意:** 学校Slackにアプリをインストール・承認できる必要がある。OpenID Connectの標準ライブラリを使い、`state`/`nonce`、トークン検証、セッションCookieを適切に扱う。SlackログインとBotのメッセージ送信は**別々の認可フローと権限**。

公式:
- https://docs.slack.dev/authentication/sign-in-with-slack/
- https://docs.slack.dev/reference/methods/openid.connect.userInfo/
- https://docs.slack.dev/reference/methods/chat.postMessage/

## 候補B: 学校Googleアカウントでログイン ＋ Slack紐づけ

- Googleアカウントでログイン（既存の認証サービス、例えばCloudflare Accessを利用）。
- バックエンドで検証済みGoogleの識別子を `person_id` に紐づける。
- Slack IDは、本人にSlackアカウント連携してもらうか、許可を得た管理者が対応表を登録する。
- メールで照合する場合は `users.lookupByEmail` などを使う。ただし学校GoogleとSlackのメールが一致するとは限らず、必要な権限もある。**メールや表示名が一致しただけで自動確定しない**。

**長所:** Slackアプリでのログインが禁止されても利用可能。

**短所:** Slackアカウントをひもづける作業が追加で必要。

参考:
- https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- https://docs.slack.dev/reference/methods/users.lookupByEmail/

## 候補C: アプリ独自のアカウント作成

メール＋パスワード等でログインし、別途Slack IDをひもづける。

**長所:** SlackやGoogleに依存しない。

**短所:** パスワード管理・再設定・認証基盤・本人確認の負担が大きく、非エンジニア4人のPoCには非推奨。自作せず既存の認証サービスを使う。

## 推奨する人物テーブル（D1）

```text
people
- id                 UUID / TEXT PRIMARY KEY（内部の固定ID）
- display_name       TEXT（表示名、同姓同名あり得る）
- slack_team_id      TEXT
- slack_user_id      TEXT
- dm_opt_in          BOOLEAN DEFAULT false
- created_at         DATETIME
- UNIQUE(slack_team_id, slack_user_id)

posts
- id                 UUID / TEXT PRIMARY KEY
- author_person_id   TEXT（ログイン済み本人からサーバーが確定）
- target_type        'person' | 'place'
- target_id          TEXT（人物ならpeople.id、場所ならplaces.id）
- sentiment          'good' | 'motto'
- text               TEXT
- created_at         DATETIME

places
- id                 TEXT PRIMARY KEY（例: kitchen）
- name               TEXT
```

※実際のSQLはマイグレーション時に確定する。投稿は本人でなくても対象を選べるようにする一方、検索対象・閲覧権限・本人の受信同意を検証する。

## 最小の処理フロー（候補A）

1. ユーザーがSlackでログインする → サーバーで身元を検証。
2. `people` の `(slack_team_id, slack_user_id)` から内部 `person_id` を取得（未登録なら許可条件を確認して作成）。
3. 投稿画面で文章入力 → Geminiが `good/motto` と人物/場所の候補を提案。
4. 投稿者が対象者を候補から**確定**し、`POST /api/v1/posts` に送信。
5. サーバーが**ログイン本人を投稿者**としてD1に保存する。
6. 週次バッチで受信同意・匿名性条件をチェック。必要な場合にのみSlack IDで本人にDM。

## 運用前に決めること

- Slackのワークスペースは1つか。学内でSlack AppとSign in with Slackが許可されるか。
- **誰がフィードバック対象者になれるか**（自ら登録・同意した人だけにするか）。
- DMに送る基準：独立した投稿者数が足りても特定されうる投稿は通知しない。初期の「3人」は匿名性の保証ではない。
- 本人が受信拒否・撤回できるか。投稿の保存期間、削除、閲覧権限、誹謗中傷や嫌がらせの通報・対応。
- Gemini無料枠へ実在の個人が含まれる原文を送ってよいか。公式のプライバシー条件と利用者への説明・同意を確認する。

PoCの最初は**架空の人物・投稿とモック認証**だけで動かし、本人確認と同意が実装できるまで実在の人物へのDMを送信しない。
