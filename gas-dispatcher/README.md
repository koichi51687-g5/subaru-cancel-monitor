# SUBARU空席監視：Google Apps Script外部起動

GitHub Actions自身の定期起動が遅れる場合でも、Google Apps Script（GAS）から約15分ごとに既存の予約監視を起動します。監視対象は **2027年1月11日（月・祝）9:00〜10:45／個人のお客様／2名** です。

## 通知経路（2026年11月21日改訂）

| 用途 | 送信元 | 受信先 |
| --- | --- | --- |
| 2名分の空席発生 | GitHub Actions（既存の `monitor.yml`） | ntfy → Pixel 8 |
| GitHub監視が45分以上正常終了しない・起動失敗 | GAS（この `Code.gs`） | Gmail |
| 監視復旧 | GAS（この `Code.gs`） | Gmail |

GitHub→ntfyの通知テストは2026年11月21日に実機で成功。GAS→ntfyはHTTP 429で拒否されたため、GASの**障害通知だけ**MailAppに変更しました。MailAppはメール送信のみ行い、Gmailの受信トレイを読むことはできません。

**注意：GitHub内の`Code.gs`を更新しても、既に作ったGASプロジェクトには自動反映されません。** 下記の手順で全文を貼り替える必要があります。

## 1. GitHub専用トークン

1. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens。
2. 有効期限は2027年1月11日以降。Resource ownerは自分。
3. Repository accessは`Only select repositories`で`koichi51687-g5/subaru-cancel-monitor`の1件のみ。
4. Repository permissionsは`Actions: Read and write`。Metadata Read-onlyは必須既定。
5. トークンはGASのスクリプトプロパティだけに保存。ソースコードやスクリーンショットに含めない。

**以前のトークンがスクリーンショットに一部写った場合は、正式稼働前に新しいトークンへ交換して古いトークンを失効させること。** 交換時は新トークンをGASの`GITHUB_TOKEN`へ先に保存し、接続テストに成功した後、旧トークンを失効させます。

## 2. GASのコードとプロパティ

1. 既存の専用プロジェクト`1. SUBARU空席監視_外部起動`を開く（ほかのプロジェクトを変更しない）。
2. 左の`<>`エディタで`コード.gs`を開き、[Code.gs](./Code.gs) の**全文**に置き換え、Ctrl+Sで保存する。
3. 左の歯車「プロジェクトの設定」→「スクリプト プロパティ」に以下を登録する。

| プロパティ | 値 |
| --- | --- |
| `GITHUB_TOKEN` | 上記のFine-grainedトークン（既存値は更新時だけ差し替える） |
| `ALERT_EMAIL` | 自分の通知先Gmailアドレス（例：自分のアドレス） |

**GAS側の`NTFY_TOPIC`は新コードでは不要**。残っていても使いませんが、誤用防止のため削除してかまいません。GitHub Secrets側の`NTFY_TOPIC`は空席通知に使うため**変更・削除しない**でください。

## 3. 本番起動前の検証

1. GASの関数選択で`testEmailNotification`を選んで「実行」。Googleの追加承認が求められたら**外部サービスへの接続・自分が不在のときの実行・メール送信**の権限を内容確認のうえ許可する。MailAppは受信トレイを読みません。
2. Gmailに「SUBARU空席監視：Gmailテスト（空席ではありません）」が届くことを確認。
3. GASの`testGitHubConnection`を実行。これは`dry_run=true`で**通知なし**の検証を依頼する。
4. [GitHub監視の実行履歴](https://github.com/koichi51687-g5/subaru-cancel-monitor/actions/workflows/monitor.yml)で新しい手動実行が`success`かつ`CLOSED`または`OPEN`であることを確認。`UNKNOWN`は失敗扱い。
5. GitHub→ntfyは[専用の手動テスト](https://github.com/koichi51687-g5/subaru-cancel-monitor/actions/workflows/notify-test.yml)で確認する（2026年11月21日にPixel 8受信成功済み）。

## 4. 15分監視開始

1. GASで`setupMonitor`を**1回**実行する。
2. 左の「トリガー」で`monitorTick`が**15分ごとに1件**登録されていることを確認する。
3. GitHubで`workflow_dispatch`の本番実行が**3回連続成功**し、ログが`OPEN`または`CLOSED`であることを確認する。
4. 正常起動が安定した段階で、既存GitHub側の`schedule`を重複抑制のため停止するか判断する。作業完了前に予定済み監視を無効化しない。

GASは本番では`dry_run=false`を明示してGitHubに送ります。空席がない場合、通常のntfy通知はありません。

## 停止と異常時の安全性

- `stopMonitor`をGASから実行すると15分トリガーを削除して停止。
- 2027年1月11日9:00（JST）を過ぎた次のGAS起動時、トリガーを自動削除。
- Gmailの送信制限や通信不良があっても、**監視起動は継続**する。メール送信失敗はGASの実行ログに残す。GitHub API自体が失敗した場合はエラー終了。
- 45分以上正常終了がない場合はGmail異常通知を1回送信。成功確認後は復旧通知を送信する。
- GASとGitHubとも実行時刻が秒単位で保証されるわけではない。
- 終了後は専用PATを失効し、GASスクリプトプロパティを削除する。

公式資料：
- [Apps Script 15分トリガー](https://developers.google.com/apps-script/reference/script/clock-trigger-builder)
- [Apps Script プロパティ](https://developers.google.com/apps-script/guides/properties)
- [MailApp（送信専用）](https://developers.google.com/apps-script/reference/mail/mail-app)
- [GitHub Actions dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

開発者向けオフライン検証：`node gas-dispatcher/test.cjs`。ダミーAPI応答だけで検証し、実際のメール送信や予約サイトへのアクセスは行いません。
