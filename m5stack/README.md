# GOOD / MOTTO Core2 — Issue #1 Phase 1

GitHub Issue [#1「場所別Good/Motto件数を取得し、割合から画面色を表示する」](https://github.com/Tamach1Q/good-motto/issues/1) のPhase 1（オフライン・モック版）です。

この段階ではWi-Fi、API、データベース、Macコントローラーを使いません。Issueで指定されたAPIレスポンスと同じ形の固定JSONをCore2内に持ち、色判定とUIを実機で確認します。

## 現在できること

- 5種類のモックJSONをA/Bボタンで切り替える
- API契約のJSONをArduinoJsonで解析する
- GOOD率をCore2側で計算する
- Issue #1の閾値どおりに背景色と顔を変える
- 320×240画面をオフスクリーン描画し、ちらつきを抑える
- 投稿の生件数を画面には表示しない

## 色の判定ルール

`total = good_count + motto_count` とします。

| 条件 | 表示色 |
| --- | --- |
| `total < 5` | グレー |
| GOOD率 `>= 65%` | 緑 |
| GOOD率 `>= 40%` | 黄 |
| GOOD率 `< 40%` | 赤 |

0件のときは割り算を行わず、グレー表示になります。

## モックケース

| ケース | GOOD | MOTTO | 期待する色 |
| --- | ---: | ---: | --- |
| 1 | 8 | 12 | 黄 |
| 2 | 13 | 7 | 緑 |
| 3 | 7 | 13 | 赤 |
| 4 | 2 | 1 | グレー |
| 5 | 0 | 0 | グレー |

画面には割合のみを表示します。確認用の生件数はシリアルモニターだけに出力されます。

## 自動テスト

色判定はArduino非依存の`mood_logic.h`へ分離しています。Macのターミナルで次を実行すると、Issue指定の5ケースと境界値を確認できます。

```sh
./m5stack/tests/run_tests.sh
```

テスト対象:

- Issue指定: 8/12、13/7、7/13、2/1、0/0
- 合計件数: 4件、5件
- GOOD率: 39%、40%、64%、65%
- 0件時のゼロ除算回避

判定は浮動小数点ではなく整数の交差乗算を使用します。

```cpp
good_count * 100 >= total * 65
good_count * 100 >= total * 40
```

### 2026-11-11の確認結果

- Arduino CLIによるCore2向けコンパイル: 成功
- ホスト上の色判定テスト: 11件すべて成功
- 新コードのCore2への書き込み: 未完了
- A/B/C操作と5ケースの実機画面: 未確認

実機書き込みはmacOSのCH9102 USBシリアルドライバーで`termios.error: (22, 'Invalid argument')`が発生しているため、ドライバーを再設定してから確認します。実機確認前に完了済みとは扱いません。

## ファイル

```text
m5stack/
├── m5stack.ino         # Core2ファームウェア
├── mood_logic.h        # Arduino非依存の色判定
├── tests/
│   ├── run_tests.sh    # Mac用テスト実行スクリプト
│   └── test_mood_logic.cpp
├── README.md           # セットアップと操作方法
└── AI_HANDOFF.md       # 開発者・AI向けの引き継ぎ情報
```

旧Mac用`controller.html`は、Phase 1のデータ取得方式と異なるため削除しました。

## 必要な環境

- M5Stack Core2
- Arduino IDE 2.x
- M5Stack ESP32ボードパッケージ 2.1.4
- M5Unified 0.2.17
- ArduinoJson 7.4.3

Arduino IDEのライブラリマネージャーで`M5Unified`と`ArduinoJson`をインストールしてください。

## Arduino IDEから書き込む

1. Arduino IDEで`m5stack.ino`を開きます。
2. 「ツール」→「ボード」で`M5Stack-Core2`を選びます。
3. PSRAMを`Enabled`にします。
4. USB接続したCore2のポートを選びます。
5. 「検証」でコンパイルします。
6. 「書き込み」を押します。
7. 必要ならシリアルモニターを`115200 baud`で開きます。

Wi-FiのSSID、パスワード、APIトークンを入力する場所はありません。Phase 1は完全にオフラインで動きます。

## 実機での操作

Core2下部のタッチボタンを使います。

| ボタン | 動作 |
| --- | --- |
| A（左） | 前のモックケース |
| B（中央） | 次のモックケース |
| C（右） | 現在のケースを再読込 |

起動直後はケース1の黄色です。Bを押すたびに、緑→赤→グレー→グレー→黄色の順で切り替われば正常です。

## Phase 2で追加するもの

Phase 2では`MockCountsProvider`をHTTPS版のProviderへ差し替え、次を追加します。

- `GET /api/v1/places/{id}/counts`
- 5分ごとの取得
- 読み取り専用Bearerトークン
- TLS証明書検証
- 通信失敗・古いデータの表示
- Wi-Fi再接続

モック版とAPI版で同じ`PlaceCounts`、JSON解析、色判定、UIを使う設計です。

Phase 2を始める際に必要なのは、ステージングAPIのHTTPSベースURL、`place_id`、読み取り専用デバイストークン、TLS証明書の扱いです。トークンはGitへコミットしないでください。

ステージングのベースURLは`https://good-motto-staging.tamach1q.workers.dev`です。2026-11-11時点では仮Workerで、件数APIは未公開です。

## トラブルシューティング

### `M5Unified.h`が見つからない

Arduino IDEのライブラリマネージャーから`M5Unified`をインストールし、IDEを再起動してください。旧`M5Core2`ライブラリではなく`M5Unified`を使います。

### `ArduinoJson.h`が見つからない

ライブラリマネージャーから`ArduinoJson` 7系をインストールしてください。

### `SCREEN BUFFER ERROR`と表示される

Arduino IDEのPSRAM設定を`Enabled`にして、もう一度書き込んでください。

### A/B/Cを押しても変わらない

- 画面下端の左・中央・右のタッチ領域を押す
- ボード設定が`M5Stack-Core2`か確認する
- Core2を再起動する

### 画面がちらつく

本コードは`M5Canvas`へ一度描いてから一括転送します。別の描画処理を追加する場合も、LCDへ直接何度も描かずCanvas内に描いてください。
