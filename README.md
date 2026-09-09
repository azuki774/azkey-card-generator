# azkey-card-generator

Azkey（Misskey フォーク）の公開ユーザー情報から、社員証風のカード画像を生成する
小規模な Web アプリケーションです。

## ドキュメント

- [初期設計ドキュメント](docs/design/README.md)
- [初期プロダクト要件](docs/design/initial-requirements.md)
- [初期技術選定・基本設計](docs/design/initial-technical-design.md)

現在は要件定義・技術選定の段階です。設計文書は初期案であり、実装と異なる場合は
実装を正とします。実装時に確認が必要な項目は、各文書の「未決事項」にまとめています。

## 開発

Node.js 24 以上を用意し、依存関係をインストールしてからテスト・ビルドを実行します。

```sh
npm install
npm test
npm run build
npm start
```

開発時は `npm run dev` で TypeScript の変更を監視できます。サーバーは `PORT`（既定値
`3000`）で待ち受け、`GET /` は `azkey-card-generator is running` を返します。

## コンテナ

```sh
docker build -t azkey-card-generator .
docker run --rm -p 3000:3000 azkey-card-generator
```

GitHub Actions は `master` への push を 7 文字の短縮コミット SHA で、形式が
`X.Y.Z` のタグを同じ SemVer タグで GitHub Container Registry へ公開します。
