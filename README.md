# azkey-card-generator

azkey（Misskey フォーク）の公開ユーザー情報から、社員証風のカード画像を生成する
小規模な Web アプリケーションです。

## ドキュメント

- [初期設計ドキュメント](docs/design/README.md)
- [初期プロダクト要件](docs/design/initial-requirements.md)
- [初期技術選定・基本設計](docs/design/initial-technical-design.md)

画像生成からPNGダウンロードまでの最小フローを実装しています。プロフィール情報は Misskey の
`/api/users/show` から取得し、既定の接続先は `azkey.azuki.blue` です。別のインスタンスを使う場合は
`MISSKEY_BASE_URL`（例: `http://127.0.0.1:4100`）で上書きできます。アバターの追加許可オリジンは
`MISSKEY_AVATAR_ALLOWED_ORIGINS` にカンマ区切りで指定します。
表面カードの実装座標と文字フィッティングは[表面カードレイアウト](docs/design/front-layout.md)
に記載しています。

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

ローカルのMisskey応答を確認するには、別のターミナルで `npm run mock:misskey` を実行し、
`MISSKEY_BASE_URL=http://127.0.0.1:4100 npm run dev` として起動します。モックには `alice` のプロフィールと
固定PNGアバターが用意されています。

ライブラリとして利用する場合は、接続先を明示してユーザー情報とアバターを取得できます。

```ts
const client = new MisskeyClient({ baseUrl: 'https://azkey.azuki.blue' });
const user = await client.getUserInfo('@alice');
const avatar = await client.getAvatar(user);
```

カードレンダラーは任意のアバター入力を受け取りますが、現在のMisskeyプロフィール取得経路では
取得したアバターをレンダラーへまだ渡していません。

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
