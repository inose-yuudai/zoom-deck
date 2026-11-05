#!/bin/zsh
# /Applications/Zoom Deck.app を作る（launch.sh を裏で実行するだけの軽いアプリ + 自作アイコン）
#   build-app.sh <本体フォルダ>
# AppleScript のアプレットは立ち上がりに数秒かかり「押しても反応しない」ように感じるため、
# 中身はシェルスクリプト 1 本だけにしている（押して 1 秒以内に launch.sh が動く）。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -e
APPDIR="${1:?本体フォルダを指定してください}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${ZOOMDECK_APP_PATH:-/Applications/Zoom Deck.app}" # 変えるのはテストのときだけ
WORK="$(mktemp -d)"

# アイコン（AppIcon.icns があればそれを使う。無いときだけ MakeIcon.swift で描く）
if [[ -f "$HERE/AppIcon.icns" ]]; then
  cp "$HERE/AppIcon.icns" "$WORK/AppIcon.icns"
else
  swift "$HERE/MakeIcon.swift" "$WORK/icon.png" >/dev/null
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# 実行ファイル：launch.sh を切り離して起動し、すぐ終わる
{
  echo '#!/bin/zsh'
  echo "nohup \"$APPDIR/launch.sh\" >/dev/null 2>&1 </dev/null &"
  echo 'exit 0'
} > "$APP/Contents/MacOS/ZoomDeck"
chmod +x "$APP/Contents/MacOS/ZoomDeck"

# LSUIElement: Dock にアイコンを出さない（すぐ終わるため。反応は通知とボタン盤の表示で返す）
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Zoom Deck</string>
  <key>CFBundleDisplayName</key><string>Zoom Deck</string>
  <key>CFBundleIdentifier</key><string>local.zoomdeck.launcher</string>
  <key>CFBundleExecutable</key><string>ZoomDeck</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep -s - "$APP" 2>/dev/null || true
touch "$APP"
[[ -n "$ZOOMDECK_APP_PATH" ]] || /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
rm -rf "$WORK"
echo "作成しました: $APP"
