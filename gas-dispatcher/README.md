# SUBARU空席監視：Google Apps Script外部起動

GitHub Actions自身の `schedule` が起動しない場合でも、Google Apps Script（GAS）から約15分ごとに既存の監視を起動するための設定です。実際の予約サイトの読み取りと空席通知は、既存のGitHub Actionsが行います。

## 現時点の状態

このフォルダーは**導入用コード**です。GASプロジェクトの作成・認証・トリガー有効化は、こういちさんのGoogleアカウントで行う必要があります。完了するまでは自動監視が復旧したとは扱いません。

## 1. GitHubの専用認証トークンを作る

1. GitHubで **Settings → Developer settings → Personal access tokens → Fine-grained tokens** を開く。
2. 「Generate new token」でトークンを作る。名前の例：`subaru-gas-dispatcher`。
3. 有効期限は **2027年1月11日を過ぎる日** に設定する（例：90日）。
4. Repository access は **Only select repositories** → `koichi51687-g5/subaru-cancel-monitor` だけを選択。
5. Repository permissions は **Actions: Read and write**（ほかは必要最小限、MetadataのReadは自動付与）。
6. 発行されたトークンを安全に保管する。**ChatGPTへ貼り付けない・GitHubのファイルへ書き込まない**。

GitHub公式：<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>

## 2. 専用GASプロジェクトを作る

1. <https://script.google.com/home/projects/create> を開き、**新しい独立したプロジェクト**を作る（既存の寿司予測アプリは触らない）。
2. プロジェクト名を `SUBARU空席監視_外部起動` などにする。
3. `コード.gs` の中身を、[Code.gs](./Code.gs) の**全文**に置き換えて保存する。
4. 左の歯車 **プロジェクトの設定 → スクリプト プロパティ** に以下を登録する（両方必須）。

   | プロパティ | 値 |
   |---|---|
   | `GITHUB_TOKEN` | 1で発行したFine-grainedトークン |
   | `NTFY_TOPIC` | Pixel 8のntfyアプリが購読している、既存のランダムなトピック名（GitHub Secretと同じ値） |

   **公開共有や、認証情報をコード内に直書きすることは禁止。** `NTFY_TOPIC` はGitHub Secretsの画面で値を再表示できないため、分からなければntfyアプリの購読トピックで確認する。

## 3. 通知・手動起動を先にテストする

1. GAS画面上部の関数プルダウンから `testNtfyNotification` を選んで **実行**。初回はGoogleによる権限確認が表示されるため、内容を確認して許可する。
2. Pixel 8に **「SUBARU監視：テスト」** が届いたことを確認。これは空席通知ではない。
3. 次に `testGitHubConnection` を **実行**。これは `dry_run=true` でGitHub Actionsを起動するため、空席通知は送らない。
4. [GitHub Actionsの実行履歴](https://github.com/koichi51687-g5/subaru-cancel-monitor/actions/workflows/monitor.yml) で新しい `Manually run` が**成功**になり、ログに `CLOSED` または `OPEN` が表示されることを確認。`UNKNOWN` や赤い失敗表示は合格にしない。

**重要：** GASによる本番起動では必ず `dry_run=false` を明示して送信する実装です。GitHub側の手動実行は既定が `true` なので、ここを省略すると空席があっても通知されません。

## 4. 15分トリガーを有効にする

1. GASの関数プルダウンから `setupMonitor` を選択して **実行**。
2. 左の時計アイコン **トリガー** で `monitorTick` が **15分ごと** に1件だけ登録されていることを確認。
3. その後、GitHubのワークフローが `workflow_dispatch` で **3回以上連続成功** することを確認する（各回のカレンダー結果は `OPEN` または `CLOSED`）。
4. 空席がなければntfy通知は通常届かない。障害時にはGASから「SUBARU空席監視：異常」を送信し、正常化したら復旧通知を送信する。

### 終了・一時停止

- `stopMonitor` をGASから手動実行すると、15分トリガーだけが停止する。
- **2027年1月11日9:00（日本時間）以降**は、次にGASが起動した際に自動的にトリガーを削除する。
- 終了後はGitHubのFine-grainedトークンを削除・失効させ、GASのスクリプトプロパティも削除する。

## 注意・限界

- GASもGitHubも実行時刻を完全保証するサービスではない。GASの定期実行には多少の遅延があり得る。
- GitHubワークフローが成功と表示されても、空席読み取りが `UNKNOWN` なら監視成功とは扱わず、ワークフローを失敗させるよう設定する。
- GAS側は成功が45分以上確認できない場合にntfy警告を**1度**送る（繰り返しの通知を抑える）。GitHub APIやGAS自身が停止した場合には、監視不能の可能性がある。
- 切り替え初期はGitHubの元の `schedule` が残るため、復旧して二重起動になる可能性がある。GASの本番起動が3回成功した後に元のscheduleを停止する判断を行う。
- GitHub側の `NTFY_TOPIC` は従来の空席通知用、GAS側の同名プロパティは異常通知用。どちらも公開してはいけない。

公式参考：

- GAS 15分トリガー：<https://developers.google.com/apps-script/reference/script/clock-trigger-builder>
- GASスクリプトプロパティ：<https://developers.google.com/apps-script/guides/properties>
- GitHub ActionsのAPI起動：<https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event>

開発者向けのローカル検証：`node gas-dispatcher/test.cjs`。Google・GitHub・ntfyへの実通信は行わず、テスト用のダミー応答で動作を確認します。
