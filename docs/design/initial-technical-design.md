# azkey-card-generator 初期技術選定・基本設計

- 文書状態: Initial Proposal
- 対象リリース: MVP
- 最終更新: 2026-09-09

> [!IMPORTANT]
> 本書は実装前の初期案であり、技術構成や挙動を確約するものではありません。検証や実装を
> 通じて変更される可能性があります。実装と本書に差異がある場合は実装を正とし、差異が
> 判明した箇所は実装を妨げない範囲で追って文書へ反映します。

## 1. 結論

MVP の暫定技術構成は、Node.js の小さな単一 Web アプリケーションとして仮決定する。
Python は採用候補から外す。実際の資源使用量は実装後に計測し、採用判断を見直せるものとする。

| 領域 | 採用候補 | 方針 |
| --- | --- | --- |
| 実行環境・言語 | Node.js + TypeScript | サーバーと画面補助コードで言語を統一 |
| Web | Fastify | 必要な機能だけを追加できる低オーバーヘッドな HTTP サーバー |
| HTML | EJS | サーバーサイドレンダリング |
| ブラウザ | HTML + CSS + 最小限の Vanilla JavaScript | SPA やクライアント hydration を導入しない |
| 画像生成 | SVG テンプレート + Sharp | 合成、リサイズ、角丸、SVG の PNG 化に使用 |
| 外部 HTTP | Node.js 標準 `fetch` | 追加クライアントを避け、タイムアウトとリダイレクトを明示制御 |
| パッケージ管理 | npm + lockfile | 再現可能な依存解決 |
| テスト | Node.js test runner | 単体、HTTP 結合、ゴールデン画像テスト |
| 静的検査 | TypeScript + ESLint | 型検査、lint |
| 配布 | OCI コンテナ | フォントを含む実行環境を固定 |
| 一時保存 | ローカル一時ディレクトリ | 保持期間は運用設定で指定 |

実装開始時に、互換性とサポート状況を確認したバージョンを lockfile で固定し、更新ツールに
よる定期更新を行う。この文書では、未検証のバージョン範囲を確約しない。

### 1.1 仮決定記録

| 項目 | 内容 |
| --- | --- |
| 状態 | 仮決定 |
| 決定日 | 2026-09-09 |
| Web 構成 | Fastify + TypeScript + EJS |
| 画像生成 | SVG テンプレート + Sharp |
| 判断理由 | サーバー処理を中心に、SPA やフルスタック UI フレームワークを導入せず構成できるため |
| 型の境界 | Fastify とテンプレートへ渡すデータは TypeScript で型検査する。EJS ファイル内は型検査されない |
| 再検討条件 | 画面・クライアント状態の増加、テンプレート内の型安全性の必要性、実行環境での資源使用量 |

本記録も初期案の一部であり、実装と異なる場合は実装を正とする。

## 2. 選定理由

### 2.1 Node.js + Fastify

- 入力、生成、結果表示に限定された経路で、API スキーマ生成や SPA 用バックエンドを必要としない。
- Fastify は小規模なアプリでも必要なルート、入力検証、ログ、静的ファイル配信を段階的に
  追加できる。
- Next.js のようなフルスタックフレームワーク、クライアント側ランタイム、hydration は
  使用しない。Node.js プロセスと必要な依存だけで構成する。
- Fastify と Sharp の資源使用量はデプロイ候補環境で計測する。Node.js が重いかどうかは
  フレームワーク名だけで判断せず、生成時のメモリを含む実測で判断する。
- アプリケーションサービスを Fastify の状態から分離し、将来別ランタイムや別 UI へ移す
  場合も中核処理を再利用できるようにする。

### 2.2 SVG テンプレート + Sharp

- カードの背景、図形、テキストを SVG テンプレートで表し、Sharp で PNG に変換する。
- アバターのデコード、EXIF 方向補正、切り抜き、縮小、透過合成、PNG 出力を Sharp で扱う。
- 仮デザインの位置・色・余白を SVG と設定値へ集約し、正式デザインへ差し替えやすくする。
- 画像の最大バイト数だけでなく、デコード後の最大ピクセル数も検査する。
- 表示の再現性を保つため、OS のフォント探索には依存せずフォントファイルを同梱する。

### 2.3 サーバーサイド HTML

画面遷移とクライアント状態がほぼなく、フォーム POST 後の結果ページだけで要件を満たす。
EJS と通常の HTTP フォームを基準にすれば、JavaScript は送信中表示や二重送信防止の
漸進的な改善に限定できる。フロントエンド専用のパッケージ管理やビルドは不要とする。

EJS テンプレート自体は TypeScript の型検査対象ではない。テンプレートへ渡す view model を
TypeScript の型として定義し、`satisfies` などでレンダリング呼び出し側を検査する。テンプレート
内の変数名の誤りは、HTTP 結合テストで検出する。

### 2.4 SSG を主構成にしない理由

SSG は入力画面や説明ページの事前生成には使えるが、リクエストごとの Azkey API 呼び出し、
画像生成、一時保存、期限判定を実行できない。これらを実現するには、次のいずれかが別途必要になる。

- 静的サイトとは別の API サーバー
- サーバーレス関数と共有オブジェクトストレージ
- ブラウザ内の画像生成

別 API を置く案は配布物と構成要素が増える。ブラウザ内生成はアバターの CORS、フォント差、
出力再現性、一時的なサーバー保存という要件と相性がよくない。そのため専用 SSG は導入せず、
Fastify が静的アセットと動的処理の両方を配信する。将来、説明ページが増えた場合は、静的部分
だけを SSG へ分離することを再検討する。

### 2.5 nginx の位置づけ

nginx は静的ファイル配信、TLS 終端、リバースプロキシ、レスポンスバッファリング、アクセス制御
などを担当できる。ただし、通常の nginx はアプリケーションランタイムではなく、Azkey API の
結果とアバターから画像を合成する処理は別途必要になる。

nginx には JavaScript を実行する njs / QuickJS モジュールがあるが、Node.js とは異なり、
Node.js API や通常のパッケージ解決を提供しない。Sharp をそのまま利用できず、CPU を長く使う
処理は nginx のワーカーをブロックする。この用途の画像生成を njs や nginx のネイティブモジュール
として実装することは、保守性と障害分離の面で初期案には採用しない。

デプロイ環境に ingress やロードバランサーがある場合、専用 nginx は必須としない。ベアメタルや
VM で TLS 終端、リクエスト制限、静的ファイルキャッシュが必要な場合は、Fastify の前段へ任意で
配置する。

### 2.6 Fastify を使う利点

Node.js 標準の `node:http` だけでも実装は可能だが、Fastify から次の共通機能を得られる。

- ルートごとの入力検証とレスポンススキーマ
- リクエストライフサイクルの hook と一貫したエラー処理
- リクエスト ID を含む構造化ログ
- 静的ファイル、フォーム、テンプレート、レート制限などを必要なものだけ追加する plugin 構成
- 実ポートを開かずに HTTP ハンドラーを検証できる `inject`
- `Buffer`、stream、任意の `Content-Type` を返せる通常の Node.js サーバーとしての扱いやすさ

ページコンポーネント、クライアントルーター、hydration、SSG、画像生成などは Fastify 自身の
責務ではない。そのため UI 機能は少ないが、今回のようなサーバー処理中心の小規模アプリでは、
必要な仕組みと不要な仕組みの境界を明確にしやすい。

## 3. 採用しない選択肢

| 選択肢 | 動的処理 | UI・ビルドの特徴 | このプロジェクトでの判断 |
| --- | --- | --- | --- |
| Fastify + EJS | Node.js 上で Sharp、一時保存、API を直接扱える | SSR HTML と最小限のブラウザ JS。必要な plugin だけ追加 | 仮決定。サーバー処理中心で構成が直接的 |
| Next.js | Route Handler で実装可能 | React、App Router、Server/Client Components、キャッシュ規則を採用 | React UI や画面遷移が増える場合に有力。現状は機能範囲が広い |
| Nuxt | Nitro の server route で実装可能 | Vue、universal/client/hybrid rendering、ファイルベース規約を採用 | Vue UI や複数画面が必要になる場合に有力。現状は機能範囲が広い |
| Astro SSG | ビルド時に確定できない生成要求は処理できない | 静的 HTML と islands が中心 | 単体では要件を満たさない |
| Astro + server adapter | Server Endpoint で実装可能 | 静的ページと on-demand route を共存でき、ブラウザ JS を抑えやすい | 有力な次点。コンテンツページが増える場合に再検討 |
| nginx | 通常構成では画像生成を実行しない | 静的配信とリバースプロキシに特化 | 必要なら前段で利用。アプリ本体の代替にはしない |
| nginx + njs / QuickJS | 限定的なサーバー処理は可能だが Sharp を直接使えない | Node.js とは異なる API と実行モデル | 画像処理の実装・保守負担が大きいため不採用 |
| Node.js `node:http` | 実装可能 | 最小構成だが検証、ログ、hook、エラー処理を自前化 | Fastify の薄い共通機能を使う方が保守しやすい |
| Python + Flask / FastAPI | 実装可能 | Python の画像処理資産を利用できる | 現時点のプロジェクト方針として避ける |
| Go | 実装可能 | 単一バイナリ化しやすいが、SVG・フォント・画像処理を別途選定 | Node.js の実測が運用条件を満たさない場合に再検討 |
| ブラウザ Canvas | ブラウザ内で生成可能 | CORS、フォント差、端末差の影響を受ける | サーバーでの一時保存・出力再現性と合わない |

Next.js、Nuxt、Astro のいずれも、サーバー実行モードを使えば要件を実現できる。「できるか」
ではなく、現時点で必要のない UI レンダリング規約やビルド機構まで採用する価値があるかで判断する。
この仮決定では Fastify を選ぶが、画面・コンテンツ・クライアント状態が増える場合は再評価する。

## 4. システム構成

```mermaid
flowchart LR
    B[Browser] -->|GET /, POST /cards| W[Fastify Web]
    W --> A[Application Service]
    A --> C[Azkey API Client]
    C --> Z[Azkey API]
    A --> F[Safe Avatar Fetcher]
    F --> M[Azkey media / allowed CDN]
    A --> R[Card Renderer / SVG + Sharp]
    R --> S[Temporary Store]
    W -->|preview / download| S
```

同一プロセス内でも責務を分け、Web フレームワークへの依存を外周へ閉じ込める。

### 4.1 コンポーネント責務

| コンポーネント | 責務 |
| --- | --- |
| Web | 入力受付、HTTP ステータス、HTML/画像レスポンス、リクエスト ID |
| Application Service | ユースケース進行、エラー分類、モデル変換 |
| Azkey API Client | `users/show` 相当の呼び出し、応答検証、Azkey 差分の吸収 |
| Safe Avatar Fetcher | URL/IP/MIME/サイズ検証、制限付きダウンロード |
| Card Renderer | 入力モデルから決定的に PNG バイト列を生成 |
| Temporary Store | ランダム ID で保存、読取、期限判定、削除 |

Web 層から API の生 JSON をテンプレートやレンダラーへ直接渡さず、次のような内部モデルへ
変換する。

```text
CardProfile
  displayName: string
  handle: string
  notesCount: number
  avatar: decoded image | default avatar
  generatedAt: timezone-aware date
```

## 5. HTTP インターフェース

| Method | Path | 用途 | 成功時 |
| --- | --- | --- | --- |
| GET | `/` | 入力フォーム | 200 HTML |
| POST | `/cards` | 入力検証、取得、生成、保存 | 303 で結果へ |
| GET | `/cards/{artifact_id}` | プレビューと期限表示 | 200 HTML |
| GET | `/cards/{artifact_id}/image` | ブラウザ内プレビュー | 200 image/png |
| GET | `/cards/{artifact_id}/download` | 添付ファイルとして取得 | 200 image/png |
| GET | `/healthz` | プロセス生存確認 | 200 text/plain |
| GET | `/readyz` | 設定・一時領域の利用可否 | 200 / 503 |

- POST 後は Post/Redirect/Get とし、更新操作による再生成を避ける。
- 期限切れは結果ページ・画像とも 410、未知の ID は 404 とする。
- 画像レスポンスは `Cache-Control: private, no-store` を初期値とする。
- `artifact_id` は暗号学的に安全で、推測が現実的に困難な URL-safe の乱数にする。
- ダウンロード名は固定接頭辞と安全に正規化した名前を使い、ヘッダー注入を防ぐ。

## 6. 外部 API と画像取得

### 6.1 Azkey API

MVP は必須環境変数 `AZKEY_BASE_URL` で指定されたオリジンの `/api/users/show` 相当へ
JSON の POST を行う。例えば `AZKEY_BASE_URL=https://azkey.example.com` なら、接続先は
`https://azkey.example.com/api/users/show` になる。画面入力は `@username` に限定し、
検証後に先頭の `@` を1つ除去して `username` として送る。`host` と内部 `userId` は送らない。
必要な応答項目は `username`、`name`、`host`、`avatarUrl`、`notesCount` とする。

- 認証トークンなしで公開情報を取得できる構成を第一候補とする。
- トークンが必要な Azkey 環境では環境変数または secret mount から注入し、ログへ出さない。
- 接続、読み取り、全体に個別のタイムアウトを設定する。
- 応答 JSON を実行時スキーマで検証し、欠損可能項目に既定動作を定める。
- 404相当、レート制限、5xx、タイムアウト、形式不正を内部エラー型へ変換する。
- 上流への自動再試行を行う場合は、安全に再試行できる障害に限定し、回数とバックオフは
  対象環境での検証後に設定する。

### 6.2 アバター取得

API が返した URL であっても信頼済みとは扱わない。

- 許可 scheme は HTTPS を既定とし、開発環境のみ明示設定で HTTP を許可する。
- ホストは Azkey のオリジンと設定済み CDN allowlist に限定する。
- DNS 解決結果が loopback、private、link-local、multicast、reserved の場合は拒否する。
- リダイレクトは既定で拒否する。許可する場合も各遷移先を同じ規則で再検証する。
- 圧縮後の受信上限、Content-Type、デコード後ピクセル数を検査する。
- SVG は受け付けず、MVP は PNG/JPEG/WebP のラスター画像だけをデコードする。
- 失敗時はカード生成全体を失敗させず、既定アバターへフォールバックする。

## 7. 一時保存と削除

### 7.1 MVP 実装

- 専用ディレクトリ配下に `<artifact_id>.png` と最小限のメタデータを保存する。
- ファイルは一時名へ書き、同一ファイルシステム内の rename で公開して部分読取を防ぐ。
- 保存時刻または期限をメタデータとして保持し、期限判定をファイル名に依存させない。
- バックグラウンド清掃を定期実行し、起動時にも期限切れを削除する。
- 取得時にも期限を検査するため、清掃間隔中の期限切れを公開しない。
- 容量上限を設け、超過時は期限切れと古い生成物を優先削除する。

### 7.2 スケール時の境界

`ArtifactStore` をインターフェース化する。複数レプリカが必要になった時点で、共有
オブジェクトストレージと TTL ライフサイクルへ置き換える。ローカル保存のまま複数
レプリカにはせず、sticky session を正しさの前提にしない。

## 8. 設定

| 環境変数（案） | 必須 | 内容 |
| --- | --- | --- |
| `AZKEY_BASE_URL` | yes | 唯一の接続先オリジン。例: `https://azkey.example.com` |
| `AZKEY_API_TOKEN` | no | 必要な環境のみ secret として注入 |
| `AVATAR_ALLOWED_HOSTS` | yes | カンマ区切りのメディア許可ホスト |
| `ARTIFACT_DIR` | no | 生成物ディレクトリ。既定 `/tmp/azkey-cards` |
| `ARTIFACT_TTL_SECONDS` | yes | 生成物の保持期間。運用要件に基づいて指定 |
| `ARTIFACT_MAX_BYTES` | no | 一時領域のアプリ上限 |
| `DISPLAY_TIMEZONE` | yes | 画像へ表示する時刻のタイムゾーン |
| `RATE_LIMIT_PER_MINUTE` | yes | 運用要件に基づくレート制限値 |
| `LOG_LEVEL` | no | 既定 `INFO` |

環境変数名と既定値は実装時に設定クラスとサンプル env ファイルで一元管理する。
`AZKEY_BASE_URL` は起動時に検証し、ユーザー情報、クエリ、フラグメント、`/api` を含む値は
拒否する。未設定または不正なら、誤った接続先でサービスを開始せず起動失敗とする。

## 9. 推奨ディレクトリ構成

```text
src/
  app.ts                 # application factory
  config.ts
  web/
    routes.ts
    templates/
    static/
  domain/
    models.ts
    errors.ts
  services/
    generate-card.ts
  adapters/
    azkey-client.ts
    avatar-fetcher.ts
    sharp-renderer.ts
    local-artifact-store.ts
assets/
  fonts/
  images/
tests/
  unit/
  integration/
  golden/
```

小規模な間は抽象化を増やしすぎず、外部 HTTP、時刻、乱数、一時保存、画像生成という
副作用の境界だけを差し替え可能にする。

## 10. テスト戦略

- **単体テスト**: 入力正規化、表示名 fallback、数値整形、文字収容、期限判定、URL/IP 検証。
- **HTTP 結合テスト**: Fastify の `inject` と `fetch` のテスト差し替えを使い、正常系と
  エラー変換を確認。
- **ゴールデン画像**: 固定フォント、固定時刻、固定アバターで代表 PNG を生成し、差分を検査。
  OS/圧縮差を避けるため、必要に応じてピクセル差と許容値で比較する。
- **契約テスト**: 機密情報を除去した Azkey レスポンス fixture でデシリアライズを確認。
- **セキュリティテスト**: private IP、リダイレクト、巨大レスポンス、画像爆弾、壊れた画像、
  パストラバーサル、ヘッダー注入を確認。
- **コンテナ smoke test**: 非 root、read-only rootfs、一時領域のみ書込可能な条件で生成する。

## 11. デプロイ方針

- multi-stage build の OCI イメージを作り、アプリ、固定依存、必要なフォントだけを含める。
- 非 root ユーザー、read-only root filesystem、専用 tmpfs/ephemeral volume で実行する。
- Node.js プロセスの並列度は CPU と画像生成時のメモリ実測から決める。プロセスごとの
  メモリ使用量を見込み、過剰な並列化をしない。
- HTTP のボディ上限、同時接続数、レート制限はアプリだけでなくリバースプロキシでも設ける。
- MVP はローカル一時領域を共有できる実行構成とし、更新時に既存生成物が失われ得ることを許容する。
- graceful shutdown の猶予を生成処理の最大時間より長く取る。

## 12. 実装順序

1. `AZKEY_BASE_URL` の対象環境で API 互換性を確認し、匿名化した API fixture を確定する。
2. Node.js / TypeScript プロジェクト、品質ツール、コンテナ、CI の最小構成を作る。
3. 内部モデル、Azkey クライアント、制限付きアバター取得を実装する。
4. 固定データからレンダラーを実装し、ゴールデン画像を確定する。
5. 一時保存、TTL、清掃を実装する。
6. SSR フォーム、結果、エラー画面を接続する。
7. レート制限、ログ、メトリクス、ヘルスチェックを追加する。
8. セキュリティ・ブラウザ・コンテナ smoke test 後に MVP を公開する。

## 13. 技術的な未決事項

- 対象 Azkey の正確な API エンドポイント、認証要否、エラー形式、アバター配信元。
- `AZKEY_BASE_URL` 未設定・不正時にプロセスを起動失敗させる際の運用プラットフォーム側の扱い。
- レート制限を単一プロセス内に置くか、リバースプロキシ側だけで強制するか。
- Prometheus メトリクスを MVP に含めるか、プラットフォームのアクセスログから始めるか。
- ゴールデン画像のピクセル完全一致を採用できる実行環境を CI で固定できるか。
- Noto Sans JP 等の採用フォントと、その配布物に必要なライセンス表記。
- Node.js + Fastify + Sharp の実測資源使用量がデプロイ環境の条件に適合するか。

## 14. 参考資料

- [Fastify documentation](https://fastify.dev/docs/latest/)
- [Fastify technical principles](https://fastify.dev/docs/latest/Reference/Principles/)
- [Sharp documentation](https://sharp.pixelplumbing.com/)
- [Sharp compositing](https://sharp.pixelplumbing.com/api-composite/)
- [nginx JavaScript module](https://nginx.org/en/docs/njs/)
- [nginx njs execution model](https://nginx.org/en/docs/njs/integration.html)
- [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)
- [Next.js Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Nuxt rendering modes](https://nuxt.com/docs/4.x/guide/concepts/rendering)
- [Nuxt server directory](https://nuxt.com/docs/4.x/directory-structure/server)
- [Astro on-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/)
- [Astro server endpoints](https://docs.astro.build/en/guides/endpoints/)
- [Misskey API](https://misskey-hub.net/ja/docs/for-developers/api/)
- [Misskey API endpoint documentation notice](https://misskey-hub.net/ja/docs/for-developers/api/endpoints/)
