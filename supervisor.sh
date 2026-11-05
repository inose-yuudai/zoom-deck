#!/bin/zsh
# Zoom Deck の見張り役（launch.sh が起動。1 つだけ動く）
# - サーバー（node server.mjs）が落ちたら数秒で起動し直す
# - 全体ショートカット（zoom-deck-hotkeys）が落ちたら起動し直す
# 「すべて終了」（stop.sh）が STOP の印を置くと終わる
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"
PORT=18787
LOG="$HOME/Library/Logs/ZoomDeck.log"
STOP="$HOME/Library/Application Support/AvatarCam/stop.flag"
PIDFILE="$HOME/Library/Application Support/AvatarCam/supervisor.pid"

# 二重に動かない
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then exit 0; fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
rm -f "$STOP"

up() { curl -s -m 2 "http://localhost:$PORT/api/models" | grep -q '^\['; }

fails=0
while [[ ! -f "$STOP" ]]; do
  if ! up; then
    if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
      : # 別のアプリが同じ番号を使っている（または起動途中）。待つ
    else
      echo "=== $(date '+%F %T') 見張り役：サーバーを起動し直します" >>"$LOG"
      nohup node server.mjs >>"$LOG" 2>&1 &
      sleep 2
      fails=$((fails + 1))
      # 何度も落ちるときは少し間をあける
      (( fails > 5 )) && sleep 20
    fi
  else
    fails=0
  fi
  if [[ -x bin/zoom-deck-hotkeys ]] && ! pgrep -qf "/bin/zoom-deck-hotkeys$"; then
    ./hotkeys.command >/dev/null 2>&1
  fi
  sleep 3
done
echo "=== $(date '+%F %T') 見張り役を終了" >>"$LOG"
