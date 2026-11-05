#!/bin/zsh
# このフォルダの内容を、アプリ「Zoom Deck」が使う場所にインストール（更新）する
#   ~/Library/Application Support/AvatarCam/app      … 本体
#   ~/Library/Application Support/AvatarCam/youtube-extension … Chrome 拡張
#   /Applications/Zoom Deck.app                       … 起動アプリ
# アップロード済みの動画（media/）・背景（backgrounds/）・効果音（sounds/）・モデルの登録（models.json）は上書き・削除しない。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/AvatarCam/app"
mkdir -p "$DEST/media"

# 使っている人のデータは、上書き・削除しない
#   media/（動画）backgrounds/（背景）sounds/（効果音）models/（モデル）view.json、models.json（モデルの登録）
EXCLUDES=(--exclude 'media/' --exclude 'backgrounds/' --exclude 'sounds/' --exclude 'models/' --exclude 'view.json' --exclude 'models.json'
          --exclude '*.before-*' --exclude 'bin/' --exclude 'cache/' --exclude 'dist/' --exclude '.git/' --exclude '.gitignore' --exclude '.DS_Store')

# インストール先の方が新しく変更されているファイルがあれば止める（他のセッションが直接直した内容を消さないため）
NEWER=()
for f in ${(f)"$(rsync -anc -8 --out-format='%n' $EXCLUDES "$DEST/" "$SRC/" 2>/dev/null | grep -v '/$')"}; do
  [[ -f "$SRC/$f" && "$DEST/$f" -nt "$SRC/$f" ]] && NEWER+=("$f")
  [[ ! -e "$SRC/$f" ]] && NEWER+=("$f（インストール先にだけある）")
done
if (( ${#NEWER} )) && [[ "$FORCE" != 1 ]]; then
  echo "インストール先の方が新しいファイルがあるので止めました（上書きすると消えます）："
  printf '  %s\n' $NEWER
  echo "その変更をこのフォルダに取り込んでから、もう一度実行してください（消してよいときは FORCE=1 ./install.command）"
  exit 1
fi

rsync -a --delete $EXCLUDES "$SRC/" "$DEST/"
# モデルの登録は最初の 1 回だけ（配布版は models.example.json から）
[[ -f "$DEST/models.json" ]] || cp "$SRC/models.json" "$DEST/models.json" 2>/dev/null || cp "$SRC/models.example.json" "$DEST/models.json"
mkdir -p "$DEST/backgrounds" "$DEST/models"
[[ -d "$SRC/media" ]] && rsync -a --ignore-existing "$SRC/media/" "$DEST/media/"
# 効果音：最初に入れたものだけ配る（名前変更・削除したものは戻さない）
if [[ -d "$SRC/sounds" && ! -d "$DEST/sounds" ]]; then rsync -a "$SRC/sounds/" "$DEST/sounds/"; fi
rsync -a "$SRC/youtube-extension/" "$HOME/Library/Application Support/AvatarCam/youtube-extension/"

# 起動アプリを作る（アイコン付き）
"$DEST/app-build/build-app.sh" "$DEST"

echo "インストールしました: $DEST"
echo "アプリ: ${ZOOMDECK_APP_PATH:-/Applications/Zoom Deck.app}"
