# Vercel社員専用版のセキュリティ設計

既存Apps Script社員画面はバックアップとして変更せず、Vercel版を独立した認証境界で実装します。

## 認証・認可フロー

1. `/api/auth/login` がGoogle OpenID Connect Authorization Code Flow + PKCEを開始
2. `/api/auth/callback` がRedisに保存したstate、ブラウザー結び付けCookie、PKCE、nonceを検証
3. Google ID tokenの署名、issuer、audience、expiration、nonce、email、`email_verified`をVercel Functionで検証
4. Vercelが署名済みリクエストでAPI専用Apps Scriptへ社員メールを送信
5. Apps ScriptがHMAC、timestamp、nonce再利用を検証した後、Spreadsheet共有権限を再取得して社員権限を再確認
6. 認可成功後にだけ最大7日のopaque session IDを発行し、Redisへsession本体を保存
7. `/api/calendar` と `/api/day-details` は毎回GAS側の社員権限確認を通過した場合だけデータを返す

Google OAuth scopeは `openid email profile` だけです。Google access token、refresh token、ID token、社員メール、署名鍵をブラウザーへ保存・送信しません。

## セッション

- Cookie名: `__Host-danpro_session`
- 属性: `HttpOnly; Secure; SameSite=Lax; Path=/`、Domain属性なし
- Cookieの内容: 32byte乱数由来のopaque IDだけ
- session本体: Upstash Redis
- 絶対有効期限: 7日
- ログイン成功ごとに新しいsession IDを生成
- logout、権限取消検出、期限切れでserver-side sessionを削除

OAuth state、PKCE、nonceもRedisへ10分だけ保存し、stateは一度取得すると削除します。OAuthブラウザー結び付けCookieは `__Host-danpro_oauth` です。

## Apps Script API分離と署名

`gas-internal-api/` は、既存社員UIとは別のstandalone Apps Script projectへpushするAPI専用コードです。既存社員UI deploymentのアクセス設定や実行ユーザーは変更しません。

Apps Scriptの `SpreadsheetApp.openById()` は `spreadsheets` scopeを必須とするため、API専用manifestも同scopeを使用します。実装は読み取りメソッドだけを使用し、Spreadsheet書き込みメソッドが存在しないことを回帰テストで固定します。

署名のcanonical formは次の改行区切りです。

```text
v1
timestamp
nonce
action
normalizedEmail
SHA-256(JSON request body)
```

Vercelは `INTERNAL_GAS_SIGNING_SECRET` でHMAC-SHA256署名します。Apps Scriptは署名とbody hash、±120秒のtimestamp、180秒保持するnonceの未使用を確認します。nonce確認はScript Lock内で行います。secret自体はrequestへ含めません。

Spreadsheet共有権限から作る許可メール値は、Apps Script Script Propertiesだけに置く `ACCESS_POLICY_HMAC_SECRET` を使ったHMAC-SHA256です。メール自体をScript Cacheやログへ保存しません。`anyone`共有は社員権限へ昇格させません。

## キャッシュとブラウザー保存

- Vercel社員API: `Cache-Control: private, no-store, max-age=0`
- Vercel CDN共有キャッシュ: 使用禁止
- localStorage: `date / count / level / symbol / levels / updatedAt`だけ
- localStorage表示: `/api/auth/session` が現在の社員権限を確認した後だけ
- 客先名、商品名、工程詳細、period: ブラウザーmemory cacheだけ
- logout、401、403: localStorage表示キャッシュとmemory詳細キャッシュを削除
- Apps Script Script Cache: HMAC認証・社員認可境界の内側で集計と詳細に利用可能

## Security HeadersとCSRF

`vercel.json` は厳格なCSP、HSTS、`nosniff`、`no-referrer`、Permissions-Policy、`DENY`、COOP/CORPを全経路へ設定します。inline script/style、`unsafe-inline`、`unsafe-eval`は使用しません。

logoutはPOSTだけを受け付け、Origin、Host、forwarded protocolを本番originと照合します。OAuth callbackはstateとブラウザー結び付けを必須にします。

## Rate limit

Redis上の固定時間窓カウンターで、ログイン開始、callback、session確認、logout、calendar、day-detailsを個別に制限します。識別子はSHA-256化してキーに使用し、社員メールやsession IDそのものをrate-limitキーへ保存しません。

## Threat model

| 脅威 | 主な対策 | 残存リスク |
| --- | --- | --- |
| URL漏洩 | 未認証APIは401、GAS直GETは拒否、署名POSTだけ受付 | URL自体は秘密として扱わない |
| 複数Googleアカウント | `prompt=select_account`、検証済みID tokenのemailだけ使用 | 誤アカウント選択時は403 |
| session cookie盗難 | HttpOnly/Secure/SameSite、opaque ID、7日絶対期限、logout失効 | 有効期間中の端末・ブラウザー侵害は残る |
| CSRF | OAuth state＋ブラウザー結び付け、logout POST＋Origin/Host検証 | 同一originでのXSSをCSPとtextContentで抑制 |
| XSS | 外部JS/CSS、厳格CSP、詳細表示はtextContent | 将来HTML挿入を追加する場合は再レビュー必須 |
| replay attack | requestごとのnonce、±120秒timestamp、GAS Lock＋nonce cache | GAS Cache障害時はfail-closed |
| GAS API URL漏洩 | URLだけでは取得不可、HMAC必須、GET拒否 | 署名鍵漏洩時は鍵rotationが必要 |
| GAS署名鍵漏洩 | Vercel envとScript Propertiesだけ、ログ禁止 | 両環境侵害時は即時rotationが必要 |
| 元社員のsession残存 | sessionと権限を分離、各社員APIで共有権限を再取得 | Google側権限反映遅延はGoogle API表示状態に依存 |
| Vercel CDN誤キャッシュ | 全社員APIをprivate/no-store、テストでs-maxage不在を確認 | 将来header変更時は回帰テスト必須 |

コード内にHIGH/CRITICALの未解決事項はありません。ただし本番外部設定と実接続テストは未完了なので、それらが終わるまでProduction Deployは禁止です。

## 本番化前の環境変数

Vercel Production:

- `APP_ORIGIN`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `INTERNAL_GAS_API_URL`
- `INTERNAL_GAS_SIGNING_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Apps Script Script Properties:

- `INTERNAL_GAS_SIGNING_SECRET`（Vercelと同じ値）
- `ACCESS_POLICY_HMAC_SECRET`（Apps Scriptだけの別値）

## 本番化前の手動作業

1. Vercel MarketplaceでUpstash RedisのFree planを選び、`danpro-calendar-internal`へ接続する
2. Google Cloud ConsoleでWeb application OAuth clientを作成する
3. Authorized redirect URIに `https://danpro-calendar-internal.vercel.app/api/auth/callback` を登録する
4. OAuth consent screenは社内利用条件に合わせてInternalまたは許可ユーザー限定で設定する
5. 新規Apps Script projectで2つのScript Propertiesを設定する
6. API専用Webアプリを「実行ユーザー: 自分」で新規deploymentする
7. deployment URLとOAuth値をVercel環境変数へ設定する
8. GitHub repositoryをVercel projectへ接続する
9. Previewで実社員、非社員、共有解除、logoutを実接続テストする
10. 問題がないことを確認してからProduction Deployする

Upstash integration、Google OAuth client、API専用Apps Script deployment、Production Deployはこの実装作業では作成・公開しません。
