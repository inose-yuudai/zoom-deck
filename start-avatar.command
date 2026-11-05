#!/bin/zsh
# Avatar Cam を起動する（ダブルクリックで実行可）
# - ローカルサーバーを起動
# - アバター専用ブラウザを「アプリ窓」で開く
#   （裏に隠れても描画が止まらないよう、バックグラウンド時の省電力を無効化）
#
# アバター専用ブラウザは「Chrome for Testing」を優先して使う。
# 普段の Chrome と別アプリ扱いになるので、OBS の「音楽: Chrome」が普段の Chrome の音を確実に拾える
# （同じ Chrome を 2 つ起動すると、OBS は新しく起動した方＝アバター窓の音に繋がってしまう）。
cd "$(dirname "$0")"
PORT=18787
SUPPORT="$HOME/Library/Application Support/AvatarCam"

if ! curl -s -o /dev/null "http://localhost:$PORT/api/models"; then
  nohup node server.mjs > "${TMPDIR:-/tmp}/avatar-cam.log" 2>&1 &
  for i in {1..20}; do
    curl -s -o /dev/null "http://localhost:$PORT/api/models" && break
    sleep 0.3
  done
fi

BROWSER=$(find "$SUPPORT/browsers/chrome" -maxdepth 3 -name "Google Chrome for Testing.app" 2>/dev/null | sort | tail -1)
if [[ -n "$BROWSER" ]]; then
  PROFILE="$SUPPORT/cft-profile"
else
  BROWSER="Google Chrome"
  PROFILE="$SUPPORT/chrome"
fi

open -na "$BROWSER" --args \
  --user-data-dir="$PROFILE" \
  --app="http://localhost:$PORT/?win=app" \
  --window-size=640,388 \
  --no-first-run \
  --test-type \
  --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling

echo "Avatar Cam: http://localhost:$PORT/（$(basename "$BROWSER")）"
