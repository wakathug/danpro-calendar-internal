# 社員版詳細キャッシュ staging 検証記録（2026-09-29）

## 1. 本番・検証環境の分離

- 作業ブランチ: `codex/detail-display-performance`
- 検証用 Apps Script: `danpro-calendar-internal-staging`
- 検証用 Script ID: `1cQSSPk0RJzPC4oI9Yl3SZFLqOnxAm-XNmdVFD9y8flhIoZW7VDBmSWQG`
- bootstrap deployment: version 1、`AKfycbzZrfwKaD9U-nBPEcBrWNNrB8qbAzxEY9Ry_aroe2i-E9H7gI2cUQCtp4kO2AFILSWzLg`
- 詳細キャッシュ検証用 Web deployment: version 2、`AKfycbz5rffL5LVpdwkFVr-oLdgvih1XrxifMkNDnTsRJkwXrqkO0EwaskYEF0wPHIgMbI04dA`
- 検証用 HEAD、deployment、Script Properties、CacheService、署名 secret、ダミー Spreadsheet は本番と別プロジェクトに分離した。
- secret 値とダミー Spreadsheet ID はこの記録、実行ログ、Git に保存していない。
- staging runtime は `STAGING_ENVIRONMENT` と `CALENDAR_SPREADSHEET_ID` が不足する場合に fail-closed とし、本番 Spreadsheet ID へフォールバックしない。
- guard は既知の staging Script ID 以外、本番 Script ID、`main` / `master`、TTL 75秒・UserLock・runtime guard を欠くソースへの push を拒否する。
- 本番 GAS HEAD / deployment / Properties / cache / trigger、Vercel Production / Production環境変数、一般版、社員版 Apps Script UI、Spreadsheetの内容・共有権限、`main` は変更していない。

## 2. staging 単発スモーク

- 2026-09-29 11:58:28 JST に `refreshCalendarAggregateCache` をエディタから1回だけ実行した。
- 対象は staging のダミー Spreadsheet。11:58:30 に成功し、Apps Script実行履歴の期間は1.484秒だった。
- 実行後も staging のインストール型triggerは0件だった。
- version 2 Web appへの未署名GETは `METHOD_NOT_ALLOWED` となり、キャッシュ抑止レスポンスを維持した。
- 定期trigger、10周期の自動実行、反復手動負荷試験、Production相当の性能計測は実施していない。
- stagingのダミーデータによる1.484秒は本番性能値として扱わない。

## 3. 競合・公開整合性

- triggerは実行中に script + current user scope の `UserLock` を保持し、重複triggerは長時間待機せずskipする。
- Web requestのcache miss fallbackはSpreadsheet読取中にlockを保持せず、公開直前だけ同じ`UserLock`を短時間試す。
- nonce replay protectionは既存の`ScriptLock`を維持し、Spreadsheet処理中に保持しない。
- triggerとfallbackは同じ公開関数を使用し、開始時刻が新しいgenerationを優先する。
- 詳細cacheを先に書き、active generationを次に、summary aggregateを最後に公開する。部分失敗やrevision不一致はcache missとして安全に扱う。
- 古い処理の後着、部分失敗、lock解放・回復、fallbackとの競合はローカル／モックテストで検証した。
- 詳細cache TTLは75秒。認可cacheとは独立し、毎リクエストの同期認可を置き換えない。

## 4. ローカル回帰テスト

- `npm test`: 51件すべて成功。既存41件に、重複実行、fallback競合、古いgenerationの後着、途中失敗、lock解放・回復、staging誤反映防止を追加した。
- HMAC、timestamp、nonce、Drive Permissions、employee membership、`private, no-store`、memory-only詳細cache、401/403後の破棄、遅延responseによる復活防止、summary-only graceの仕様は変更していない。

## 5. 既存ログの読み取り監査

観測窓は 2026-09-28 10:55:00 から 2026-09-29 10:55:00 JST。Apps Script実行画面から取得できた行を実行単位で重複除外した。下記の合計は観測されたwall-clock実行時間であり、Googleが課金・制限判定に使う正確なtrigger runtimeや残量ではない。

| 対象 | 件数 | 成功 | 失敗 | 観測時間合計 | p50 | p95 | 最大 | 重複開始 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 一般版 毎分 | 1,109 | 1,108 | 1 | 108.08分 | 4.390秒 | 11.171秒 | 479.962秒 | 3組、最大2並行 |
| 社員版 Apps Script UI 毎分 | 1,240 | 1,237 | 2（ほかに観測時実行中1） | 414.73分 | 8.801秒 | 80.479秒 | 202.651秒 | 108組、最大3並行 |
| API専用 毎分 | 931 | 931 | 0 | 342.99分 | 8.465秒 | 90.733秒 | 449.310秒 | 92組、最大5並行 |
| フォーム送信 | 2 | 2 | 0 | 17.278秒 | - | - | - | なし |

- 上記3本の毎分処理とフォームを合わせた観測wall-clock合計は 51,965.309秒（866.09分、14.435時間）。公式残量を表す値ではない。
- 明示的な利用上限エラーは観測した失敗ログから見つからなかった。一般版の1件はGoogle側server error、社員版UIの2件はJavaScript engineのINTERNAL errorだった。
- 7日範囲で確認できたフォーム送信は6件（成功4、失敗2）。失敗は希望納期空欄による`DEADLINE_PARSE_FAILURE`で、利用上限由来ではなかった。
- Apps Script画面で確認できた実行者はconsumer account（gmail.com）だった。メールアドレス自体は記録していない。
- Apps Script UIから取得できる履歴、別プロジェクト、同一実行者の未表示処理、公式残量は不明。観測値から正確な残量やreset時刻を推定しない。
- [Google公式のApps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)はconsumer accountでtrigger total runtime 90分/日、Google Workspaceで6時間/日とし、quotaは最初のrequestから24時間後にresetすると説明している。暦日切替とは扱わず、上のwall-clock合計へもそのまま対応づけられない。公式残量APIがないため、新しい毎分triggerは有効化しない判断を維持した。

## 6. 負荷削減候補（未実装）

1. 3本の毎分処理は同じ元Spreadsheetをそれぞれ読み、summaryを重複生成している。まず社員版Apps Script UIの現在の利用実態を確認し、未使用ならtrigger整理を検討する。
2. API専用triggerは同期Web認可とは別にaccess policyを生成しているが、現行APIコード内にそのcacheを読む経路が見当たらない。隠れた利用者がないことを確認してから、この生成だけを省ける可能性がある。
3. snapshot生成を共有する場合も、一般版へ公開するのは匿名summaryだけの独立namespaceとし、社員詳細、権限情報、内部revisionを混入させない。
4. 更新間隔、稼働時間帯、TTL、実行アカウント、外部schedulerの変更は鮮度・可用性・権限に影響するため、今回実装しない。

## 7. 実trigger検証へ進む条件

- 同じ実行者の利用枠について、管理画面または運用側で許容余力を確認する。
- stagingの1分trigger作成を改めて明示承認する。
- 10周期以上について、trigger開始・終了、成功・失敗・skip、cache書込間隔、hit/miss、revision切替、失敗fallbackを記録する。
- 本番Spreadsheetを編集せず、stagingダミーデータだけでrevision変化を作る。
- 10周期の結果が良好でも、Production/mainへの反映は別承認とする。
