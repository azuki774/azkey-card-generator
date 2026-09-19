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

## 役職表示

役職表示は `CARD_ROLES_FILE` を指定した場合だけ有効です。未指定なら対応表は空で、
役職欄も空欄になります。指定するファイルは、UTF-8 CSV の各レコードを 1 レコードずつ
Base64 化し、改行で並べたファイルです。ヘッダーも 1 レコードとして先頭に置きます。
空行は無視しますが、Base64 の途中で折り返したり、復元したレコードに改行を含めたりは
できません。CSV のヘッダーは厳密に次の形式にします。

```csv
username,役職名
alice,開発リード
bob,"研究,開発"
```

`username` は内部 ID ではなく、単一のローカル Misskey サーバーの username を `@` なしで
記載します。大文字小文字は区別されません。リモートユーザー形式や先頭 `@` は使用できません。
アカウント名を再利用すると新しいアカウントにも同じ役職が表示されるため注意してください。
Base64 は秘匿化ではありません。ファイル変更後は次回起動時に読み込まれるため、反映には再起動が必要です。

編集する平文 CSV は追跡対象外にしてください。`roles:encode` は CSV 全体を先に検証し、
各レコードを正しく CSV エスケープしてから Base64 化します。

```sh
# 行単位で Base64 を復元して編集（roles.csv は .gitignore 済み）
: > roles.csv
while IFS= read -r encoded || [ -n "$encoded" ]; do
  encoded=$(printf '%s' "$encoded" | tr -d '\r\t ')
  [ -z "$encoded" ] && continue
  if [ -s roles.csv ]; then printf '\n' >> roles.csv; fi
  printf '%s' "$encoded" | base64 --decode >> roles.csv
done < config/roles.csv.b64
# 編集後に検証・変換
npm run roles:encode -- roles.csv config/roles.csv.b64
rm roles.csv
npm run roles:validate -- config/roles.csv.b64
```

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

Misskeyから取得したアバターを表面カードに表示します。アバターが未設定の場合や取得に失敗した場合は、
代替画像でカードを生成します。裏面にはノート数・フォロー数・フォロワー数・登録日を表示します。
表面・裏面の右下には、発行日（`YYYY-MM-DD`）とカード UUID をラベルなしで表示します。

生成画像はサーバーへ保存せず、再読み込みやページ移動で破棄されます。画像レンダリングにはSharpと
`assets/card-templates/default` の仮素材を使い、コンテナではNoto Sans CJKを読み込みます。
フォントの出所・ライセンス・コンテナ内の通知配置は
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に記載しています。

## コンテナ

```sh
docker build -t azkey-card-generator .
docker run --rm -p 3000:3000 azkey-card-generator
# 役職表示を有効にする場合
docker run --rm -p 3000:3000 \
  -e CARD_ROLES_FILE=/app/config/roles.csv.b64 \
  azkey-card-generator
```

コンテナにも `config/roles.csv.b64` を含めていますが、環境変数を
指定しない限り読み込まれません。

GitHub Actions は `master` への push を 7 文字の短縮コミット SHA で、形式が
`X.Y.Z` または `X.Y.Z-rc.1` などの SemVer prerelease タグを同じタグ名で
GitHub Container Registry へ公開します。`v` プレフィックスや build metadata は対象外です。
