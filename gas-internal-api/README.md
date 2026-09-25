# 社員版Vercel用 Apps Script API

既存社員UIとは別のApps Script project/deploymentとして作成する、server-to-server専用APIです。HTMLは配信せず、`GET`では常に拒否JSONだけを返します。

## 必須Script Properties

- `INTERNAL_GAS_SIGNING_SECRET`: Vercelと共有するHMAC署名鍵
- `ACCESS_POLICY_HMAC_SECRET`: 許可メールをHMAC化するGAS内専用鍵（Vercelへ渡さない）

どちらも十分に長いランダム値を使用し、Git、ログ、HTML、リクエスト本文へ保存しないでください。

## 新規projectの作成

既存社員版Apps Script projectを再利用しません。このディレクトリで新しいstandalone projectを作成し、`.clasp.json.example`を参考に、実際の`.clasp.json`をローカルだけへ置きます。

Webアプリdeploymentは次の条件にします。

- 実行ユーザー: 自分
- アクセス: 匿名を含む全員（入口のHMAC署名検証で拒否）
- API専用（HTMLなし）
- Vercel Functionからの署名済みPOSTのみ

この設定を `appsscript.json` の `webapp` に明示し、CLIでversionを更新しても
Webアプリentry pointが失われないようにします。公開入口では最初にHMAC署名、
timestamp、nonceを検証し、その後にSpreadsheet共有権限を照合するため、
署名なしリクエストから社員情報は取得できません。

deploymentを外部公開する前に、対象Spreadsheetの読み取り、Drive権限メタデータ、必要なGoogle Groupメンバー参照だけが許可されていることを確認してください。Spreadsheetへの書き込み処理はありません。

`SpreadsheetApp.openById()` はApps Scriptの仕様上 `spreadsheets` scopeを要求するため、manifestにはこのscopeを明示します。scope自体は書き込み権限を含みますが、このAPIの実装と回帰テストはSpreadsheetへの書き込みメソッドを禁止しています。

## キャッシュ更新

必要に応じて `refreshCalendarAggregateCache` を1分間隔の時間主導トリガーで実行します。社員認可は各APIリクエストでSpreadsheet共有権限を再取得するため、既存sessionが残っていても共有解除後の次回アクセスは拒否されます。
