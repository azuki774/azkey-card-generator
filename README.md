# azkey-card-generator

azkey（Misskey フォーク）の公開ユーザー情報から、社員証風のカード画像を生成する
小規模な Web アプリケーションです。

## ドキュメント

- [初期設計ドキュメント](docs/design/README.md)
- [初期プロダクト要件](docs/design/initial-requirements.md)
- [初期技術選定・基本設計](docs/design/initial-technical-design.md)

画像生成からPNGダウンロードまでの最小フローを実装しています。プロフィール情報は現在
仮データ（`Sample User`、ノート数0）で、azkeyへのアクセスは後続タスクで差し替えます。
正式なカードレイアウトやアバター処理も後続タスクの対象です。

## 開発

Node.js 24 以上を用意し、依存関係をインストールしてからテスト・ビルドを実行します。

```sh
npm install
npm test
npm run build
npm start
```

開発時は `npm run dev` で TypeScript の変更を監視できます。サーバーは `PORT`（既定値
`3000`）で待ち受けます。トップページで `@username` を送信すると、`POST /cards` が表面・裏面の
PNGを生成し、base64を含むJSONとして返します。ブラウザはこれをBlob URLへ変換し、同じ画面で
両面のプレビューと個別ダウンロードを提供します。

生成画像はサーバーへ保存せず、再読み込みやページ移動で破棄されます。画像レンダリングにはSharpと
`assets/card-templates/default` の仮素材を使い、コンテナではNoto Sans CJKを読み込みます。
フォントの出所・ライセンス・コンテナ内の通知配置は
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載しています。

## コンテナ

```sh
docker build -t azkey-card-generator .
docker run --rm -p 3000:3000 azkey-card-generator
```

GitHub Actions は `master` への push を 7 文字の短縮コミット SHA で、形式が
`X.Y.Z` または `X.Y.Z-rc.1` などの SemVer prerelease タグを同じタグ名で
GitHub Container Registry へ公開します。`v` プレフィックスや build metadata は対象外です。
