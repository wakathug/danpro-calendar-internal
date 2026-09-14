# 混雑見込みカレンダー（社員用）

Google Spreadsheetの日別スケジュールを読み取り、社員用の混雑見込みカレンダーと案件詳細を表示するGoogle Apps Scriptです。

## 混雑数の定義

N列以降の日別スケジュール領域で、セルの値を文字列化して前後の空白を除去した後、次のいずれかに完全一致するセル数をその日の `count` とします。M列の「日時」は同じ行の `AM` / `PM` を表し、L列の「納品方法」とは分離して読み取ります。

- 印刷
- 工場
- 組立
- 梱包
- CAD

その他の値や空白は集計しません。部分一致は使用しないため、例えば `印刷確認` は `印刷` として集計しません。

| count | 混雑度 | 表示文言 |
| ---: | :---: | --- |
| 0 | ◎ | 余裕あり |
| 1〜2 | ○ | 対応可能 |
| 3〜4 | △ | やや混雑 |
| 5以上 | × | 混雑 |

`getDayDetails(date)` は集計対象工程に限定せず、従来どおり指定日に登録されたすべての予定を返します。詳細はAM、PM、periodなし・未知値の順に並べ、同じ時間帯ではSpreadsheet上の元の行順を維持します。各予定の `period`（`AM` / `PM`）は、詳細モーダルとPCのhoverプレビューでそれぞれ「午前」/「午後」と表示します。periodがない場合は工程名だけを表示します。

カレンダーは日曜始まり（`日 月 火 水 木 金 土`）です。平日は `count = 0` を `◎` として表示し、土日祝相当の週末は `count = 0` の場合に日付番号だけの休業日表示とします。週末でも `count >= 1` の場合は平日と同じ混雑記号・背景色・案件詳細を表示します。

## 案件詳細キャッシュ

`getCalendarData()` の更新時に、案件詳細を日付ごとにGoogle Apps Scriptのユーザー専用キャッシュへ75秒間保存します。`getDayDetails(date)` は指定日のキャッシュだけを返し、キャッシュがない場合はSpreadsheetを読み取って復帰します。

PCでは日付へポインターが入った瞬間に詳細取得を開始し、プレビュー表示だけを250ms遅らせます。同じ日付の取得中Promiseと取得済み結果はhoverとクリックで共有するため、hover後に詳細モーダルを開いても再通信しません。スマートフォンでは従来どおりタップで詳細モーダルを開きます。

Spreadsheetから読み取った詳細表示対象データとsheetIdをSHA-256で要約した`detailRevision`を返します。60秒更新後もrevisionが同じ場合はブラウザーの詳細キャッシュを維持し、内容または対象シートが変わった場合だけ破棄して再取得します。開いている詳細モーダルもrevision変更時に更新します。顧客情報の全件データはブラウザーへ送信せず、revisionは内容を復元できないハッシュ値だけを返します。

## 初期表示キャッシュと計測

成功したカレンダーの`days`（date / count / level / symbol）、`levels`、`updatedAt`だけをブラウザーのlocalStorageへ最大24時間保存します。次回起動時はこれを先に描画し、直後に通常の`getCalendarData()`で最新データへ更新します。顧客名、商品名、工程詳細、period、Spreadsheet URL、detailRevisionは保存しません。アクセス拒否時は保存済みカレンダーと画面表示を消去します。

サーバーは候補シートごとにヘッダー行から最終行までを1つのRangeで一括取得し、その配列を最新シート判定、集計、詳細生成、detailRevision生成で再利用します。`getCalendarData()`の応答にはSpreadsheetオープン、Range読み取り、最新シート判定、集計、revision、詳細キャッシュ保存の各所要時間を`serverTiming`として含め、ブラウザー側は初期表示の各時点を`window.__danproCalendarTiming`とコンソールへ記録します。この計測値と顧客情報はlocalStorageへ保存しません。

初回ブラウザー向けには、Apps ScriptのScript Cacheへ表示専用の事前集計を最大3分保存します。内容は`days`（date / count / level / symbol）、`levels`、更新時刻、対象sheetId、detailRevisionだけで、顧客名、商品名、工程詳細、period、Spreadsheet URLは含めません。カレンダーキャッシュがない、2分より古い、壊れている、またはCache Serviceが失敗した場合は、権限キャッシュで許可済みのユーザーに限って通常のSpreadsheet一括取得と集計へフォールバックします。

アクセス権限は同じ時間主導更新でDrive APIから取得し、個別共有ユーザーと閲覧可能なGoogle Groupメンバーは正規化メールのSHA-256ハッシュ、ドメイン共有はドメイン条件としてScript Cacheへ180秒保存します。有効性は生成から150秒までに制限します。1分更新が遅延したり1回分ずれたりしても約120秒の更新間隔までは正規ユーザーの利用を継続でき、更新が止まった場合は生成から150秒を超えた時点で必ずfail-closedになります。Webリクエストでは`Session.getActiveUser().getEmail()`と権限キャッシュだけを照合するため、カレンダーキャッシュ命中時は`SpreadsheetApp.openById()`、Range読み取り、Drive API、Groups APIを呼びません。メールを取得できない場合、権限キャッシュがない・破損・期限切れの場合、または照合不一致の場合はSpreadsheetへフォールバックせず`ACCESS_DENIED`にします。`getDayDetails()`にも同じ照合を適用します。

Drive権限の`user`、`group`、`domain`、`anyone`を区別します。Google Groupは直接メンバーの役割がOWNER、MANAGER、MEMBERのユーザーだけを許可し、子Groupを再帰的に展開します。ドメイン／全員共有は検索可能な権限だけを許可対象とし、「リンクを知っているユーザー」型の権限は安全側で許可リストへ展開しません。トリガー実行者がGroupメンバー一覧を閲覧できない場合や上限を超えた場合は権限キャッシュを更新せず、既存キャッシュも生成から150秒を超えると無効になるfail-closed方式です。Google側でGroupメンバー変更の反映に遅延がある場合、アプリはDrive／Groups APIで確認できた状態を次回トリガーで反映します。

`serverTiming`には、Apps Script処理開始を基準とした`activeUserLookupMs`、`accessCacheLookupMs`、`permissionCheckCompletedMs`、`serverCacheLookupCompletedMs`、`spreadsheetFetchCompletedMs`、`cacheHit`を含めます。ブラウザーの`window.__danproCalendarTiming`にある`getCalendarDataStartedMs`と`latestCalendarRenderedMs`を合わせると、RPC開始から混雑記号描画までを確認できます。キャッシュ命中時の`spreadsheetOpenMs`とRange読み取り回数は0、`spreadsheetFetchCompletedMs`は`null`です。

## 事前集計トリガー（本番では手動設定）

コード内の`refreshCalendarAggregateCache()`が表示専用キャッシュを再集計する関数です。リポジトリや`clasp push`からトリガーを自動作成しません。本番で有効化する場合は、Apps Scriptエディタの「トリガー」から次の設定を1件追加してください。

1. 実行する関数: `refreshCalendarAggregateCache`
2. イベントのソース: 時間主導型
3. 時間ベースのトリガー: 分ベースのタイマー
4. 時間の間隔: 1分おき

トリガー作成者には対象Spreadsheetの閲覧権限に加え、Driveメタデータと、共有にGoogle Groupがある場合はそのメンバー一覧を閲覧できる権限が必要です。Drive API v3はmanifestで有効化済みです。コード更新後はエディタから関数を1回実行して追加スコープを承認し、実行がエラーなく完了することを確認してください。関数はSpreadsheetや共有設定へ書き込みません。Webアプリは従来どおり「アクセスしているユーザーとして実行」する構成を維持します。
