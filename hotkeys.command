#!/bin/zsh
# Zoom Deck の全体ショートカット（⌃⌥M など）を起動する。ダブルクリックで実行可
#   ./hotkeys.command        起動（起動済みなら何もしない）
#   ./hotkeys.command stop   停止
#   ./hotkeys.command build  作るだけ（起動しない）
cd "$(dirname "$0")"
BIN="bin/zoom-deck-hotkeys"

if [[ "$1" == "stop" ]]; then
  pkill -f "/$BIN\$" && echo "ショートカットを停止しました" || echo "起動していません"
  exit 0
fi

if [[ "$1" != "build" ]] && pgrep -qf "/$BIN\$"; then
  echo "ショートカットは起動済みです"
  exit 0
fi

# 実行ファイルが無い／ソースの方が新しいときはビルドする
if [[ ! -x "$BIN" || hotkeys/ZoomDeckHotkeys.swift -nt "$BIN" ]]; then
  # コマンドライン ツールが無いと swiftc が入れる案内を出すので、呼ばない
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "全体ショートカットは使えません（Xcode のコマンドライン ツールがありません）"
    exit 0
  fi
  mkdir -p bin
  swiftc -O hotkeys/ZoomDeckHotkeys.swift -o "$BIN" || { echo "ビルドに失敗しました"; exit 1; }
fi
[[ "$1" == "build" ]] && exit 0

# 絶対パスで起動（見張り役・停止が「…/bin/zoom-deck-hotkeys」で見分けるため）
nohup "$PWD/$BIN" > "${TMPDIR:-/tmp}/zoom-deck-hotkeys.log" 2>&1 &
sleep 0.5
cat "${TMPDIR:-/tmp}/zoom-deck-hotkeys.log"
