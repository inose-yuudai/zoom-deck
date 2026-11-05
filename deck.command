#!/bin/zsh
# Zoom Deck（ボタン盤）を開く（ダブルクリックで実行可）
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
  --app="http://localhost:$PORT/deck.html?win=app" \
  --window-size=520,860 \
  --no-first-run \
  --test-type \
  --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling

# 全体ショートカット（⌃⌥M など）も起動
./hotkeys.command >/dev/null

echo "Zoom Deck: http://localhost:$PORT/deck.html（⌃⌥ ショートカット有効）"
