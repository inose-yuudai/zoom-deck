#!/bin/zsh
# Zoom Deck をまとめて起動する（アプリ「Zoom Deck」・Deck の「OBS を起動」から呼ばれる）
#   見張り役（サーバー・ショートカット）→ OBS → アバター画面 → OBS の取り込み設定・音楽の付け直し → 仮想カメラ → ボタン盤
# すでに全部動いていれば、ボタン盤を開き直すだけ（すぐ終わる）。何度押しても大丈夫。
# 他のアプリを AppleScript で操作しない（「〜を制御しようとしています」の許可待ちで止まらないように）。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"
PORT=18787
LOG="$HOME/Library/Logs/ZoomDeck.log"
SUPPORT="$HOME/Library/Application Support/AvatarCam"
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') 起動"

# 通知は待たずに出す（通知が詰まっても起動は止めない）
notify() { osascript -e "display notification \"$1\" with title \"Zoom Deck\"" >/dev/null 2>&1 &! }
up() { curl -s -m 2 "http://localhost:$PORT/api/models" | grep -q '^\['; }
# JSON から値を 1 つ取り出す（例: json avatar.online）
json() { node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const v=process.argv[1].split('.').reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??'')}catch{console.log('')}})" "$1"; }
# 時間制限つきで実行（OBS が応答しないなどで止まったままにならないように）
limit() { local sec=$1; shift; perl -e 'alarm shift; exec @ARGV or exit 127' "$sec" "$@"; }
# アバター画面が動いていて、最小化もされていないか
avatar_ok() {
  local st; st=$(curl -s -m 3 "http://localhost:$PORT/api/deck/state")
  [[ "$(echo "$st" | json avatar.online)" == "true" && "$(echo "$st" | json avatar.hidden)" != "true" ]]
}

# 見張り役が動いているか（PID の記録で確かめる）／起動
SUP_PID="$SUPPORT/supervisor.pid"
sup_running() { [[ -f "$SUP_PID" ]] && kill -0 "$(cat "$SUP_PID")" 2>/dev/null; }
start_sup() { sup_running || { rm -f "$SUPPORT/stop.flag"; nohup ./supervisor.sh >/dev/null 2>&1 & }; }

# 0. すでに全部そろっていれば、ボタン盤を開き直して終わり
#    新しい窓が一番前に開き、古い窓（最小化・別のデスクトップにあるものも）は自動で閉じる
if up; then
  if [[ "$(curl -s -m 3 "http://localhost:$PORT/api/deck/state" | json obs)" == "true" ]] && avatar_ok; then
    start_sup
    ./deck.command >/dev/null
    echo "すでに起動済み：ボタン盤を開き直しました"
    exit 0
  fi
fi

# 二重起動を防ぐ（同時に走ると OBS への問い合わせが重なって OBS が落ちることがある）
LOCK="${TMPDIR:-/tmp}/zoom-deck-launch.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  OWNER=$(cat "$LOCK/pid" 2>/dev/null)
  AGE=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [[ -n "$OWNER" ]] && kill -0 "$OWNER" 2>/dev/null && (( AGE < 180 )); then
    echo "起動処理が実行中のため中止"
    notify "起動中です。少しお待ちください…"
    exit 0
  fi
  # 前回の起動が途中で止まった（プロセスが無い・3 分以上かかっている）ので取り直す
  if [[ -n "$OWNER" ]] && kill -0 "$OWNER" 2>/dev/null; then
    echo "前回の起動処理が止まっていたので終了させます（PID $OWNER）"
    pkill -P "$OWNER" 2>/dev/null; kill "$OWNER" 2>/dev/null
  fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT
notify "起動しています…（OBS・アバター・ボタン盤）"

# 1. 見張り役（サーバーとショートカットが落ちても自動で立ち上げ直す）
start_sup
for i in {1..40}; do up && break; sleep 0.3; done
if ! up; then
  if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    notify "ポート $PORT を別のアプリが使っています。そのアプリを止めてから起動してください"
  else
    notify "サーバーを起動できませんでした（記録: ~/Library/Logs/ZoomDeck.log）"
  fi
  exit 1
fi

# 2. OBS（前回異常終了していてもセーフモードの確認で止まらないよう、印を消してから起動）
STARTED_OBS=0
if ! pgrep -qx OBS; then
  notify "OBS を起動しています…"
  rm -f "$HOME/Library/Application Support/obs-studio/.sentinel/"run_*(N)
  open -a /Applications/OBS.app
  STARTED_OBS=1
fi
OBS_NOW=$(limit 75 node --input-type=module -e "
  import { waitForObs } from './obs/obs-ws.mjs';
  const o = await waitForObs(60000);
  const p = await o.call('GetProfileList'), c = await o.call('GetSceneCollectionList');
  const s = await o.call('GetStreamStatus'), r = await o.call('GetRecordStatus');
  console.log(JSON.stringify({ profile: p.currentProfileName, collection: c.currentSceneCollectionName, busy: s.outputActive ? '配信中' : r.outputActive ? '録画中' : '' }));
  o.close();") \
  || { notify "OBS に接続できませんでした。OBS の画面に確認が出ていないか見てください"; exit 1; }

# 2.5 OBS が Zoom 以外の設定で使われているときは、切り替えてよいか毎回聞く（Switch 配信などを勝手に変えない）
#     Zoom Deck が今 OBS を起動したときは、誰も使っていないので聞かずに切り替える
OBS_PROFILE=$(echo "$OBS_NOW" | json profile); OBS_COLL=$(echo "$OBS_NOW" | json collection); OBS_BUSY=$(echo "$OBS_NOW" | json busy)
if [[ "$OBS_PROFILE" != "Zoom" || "$OBS_COLL" != "Zoom（音楽+アバター）" ]] && [[ $STARTED_OBS == 0 || -n "$OBS_BUSY" ]]; then
  echo "OBS は別の設定で使用中：$OBS_PROFILE / $OBS_COLL ${OBS_BUSY}"
  MSG="OBS は今、別の設定で使われています。\n\nプロファイル：$OBS_PROFILE\nシーンコレクション：$OBS_COLL${OBS_BUSY:+\n\n⚠️ ${OBS_BUSY}です。切り替えると、その画面と音が変わります。}\n\nZoom 用に切り替えますか？"
  DEFAULT="Zoom 用に切り替える"; [[ -n "$OBS_BUSY" ]] && DEFAULT="やめる"
  ANSWER=$(osascript -e 'on run argv' -e 'activate' \
    -e 'set r to display dialog (item 1 of argv) with title "Zoom Deck" buttons {"やめる", "Zoom 用に切り替える"} default button (item 2 of argv) with icon caution giving up after 120' \
    -e 'if gave up of r then return "やめる"' -e 'return button returned of r' -e 'end run' "$(printf "$MSG")" "$DEFAULT" 2>/dev/null)
  if [[ "$ANSWER" != "Zoom 用に切り替える" ]]; then
    echo "切り替えずに中止（OBS はそのまま）"
    notify "OBS はそのままにしました（Zoom 用には切り替えていません）"
    ./deck.command >/dev/null
    exit 0
  fi
  echo "Zoom 用に切り替えます"
fi

# 3. アバター画面（無い・最小化されて止まっているときは開き直す。古い窓は自動で閉じる）
RELINK=()
if ! avatar_ok; then
  notify "アバター画面を開いています…"
  ./start-avatar.command
  sleep 9
  RELINK=(--relink) # 新しい窓を開いたときだけ、OBS に窓を探し直させる
fi

# 4. OBS にアバター窓を取り込み、音楽アプリに付け直す
limit 90 node obs/setup-zoom-obs.mjs $RELINK || echo "OBS の取り込み設定が時間内に終わりませんでした"
limit 60 node obs/refresh-music.mjs || echo "音楽の付け直しが時間内に終わりませんでした"

# 5. 仮想カメラ開始
limit 20 node --input-type=module -e "import { connect } from './obs/obs-ws.mjs'; const o = await connect(); if (!(await o.call('GetVirtualCamStatus')).outputActive) await o.call('StartVirtualCam'); o.close();"

# 6. 全体ショートカット（見張り役も面倒を見る）
./hotkeys.command

# 7. ボタン盤（新しい窓を前に開く。古い窓は自動で閉じる）
./deck.command

notify "準備完了！ Zoom のカメラ: OBS Virtual Camera ／ マイク: BlackHole 2ch"
echo "=== 完了"
