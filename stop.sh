#!/bin/zsh
# Zoom Deck をすべて終了する（Deck の「すべて終了」から呼ばれる）
# 他のアプリを AppleScript で操作しない（「〜を制御しようとしています」の許可待ちで止まらないように）。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"

# 見張り役を先に止める（止めた物を起動し直さないように）
touch "$HOME/Library/Application Support/AvatarCam/stop.flag"
SUP_PID="$HOME/Library/Application Support/AvatarCam/supervisor.pid"
[[ -f "$SUP_PID" ]] && kill "$(cat "$SUP_PID")" 2>/dev/null
sleep 0.5

./hotkeys.command stop
pkill -f "AvatarCam/cft-profile"
pkill -f "AvatarCam/chrome"

# OBS：Zoom 用の設定で使っているときだけ、仮想カメラを止めてから終了の合図（SIGTERM）を送る
# （OBS 30 以降は SIGTERM で普通に終了する。仮想カメラが動いていると「終了しますか？」の確認で止まるので先に止める）
# 別の用途（Switch 配信など）で使われているとき・配信中・録画中は、OBS には触らない
if pgrep -qx OBS; then
  OBS_USE=$(perl -e 'alarm shift; exec @ARGV or exit 127' 5 node --input-type=module -e "
    import { connect } from './obs/obs-ws.mjs';
    const o = await connect();
    const c = (await o.call('GetSceneCollectionList')).currentSceneCollectionName;
    const busy = (await o.call('GetStreamStatus')).outputActive || (await o.call('GetRecordStatus')).outputActive;
    if (c !== 'Zoom（音楽+アバター）' || busy) console.log('other');
    else { if ((await o.call('GetVirtualCamStatus')).outputActive) await o.call('StopVirtualCam'); console.log('zoom'); }
    o.close();" 2>/dev/null)
  if [[ "$OBS_USE" == "zoom" ]]; then
    pkill -TERM -x OBS
  else
    echo "OBS は別の用途で使用中（または確かめられなかった）ので終了しません" >> "$HOME/Library/Logs/ZoomDeck.log"
  fi
fi

# サーバー：18787 番で待っている自分のサーバーだけを止める（他のアプリの server.mjs には触らない）
for pid in $(lsof -ti tcp:18787 -sTCP:LISTEN 2>/dev/null); do
  ps -p "$pid" -o command= | grep -q "server.mjs" && kill "$pid"
done
osascript -e 'display notification "すべて終了しました" with title "Zoom Deck"' >/dev/null 2>&1 &!
