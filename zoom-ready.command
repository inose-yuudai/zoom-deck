#!/bin/zsh
# Zoom 前の準備（ダブルクリックで実行可）
#   1. Avatar Cam を起動（起動済みならそのまま）
#   2. OBS の設定を確認・アバター窓を取り込み直す
#   3. 音楽ソースを「今起動している音楽アプリ」に付け直す
#   4. 音量を 6 秒間計測して表示
#   5. ボタン盤（Zoom Deck）を開く
# 先に OBS と音楽アプリを起動しておくこと。
cd "$(dirname "$0")"

if ! pgrep -qf "AvatarCam/(cft-profile|chrome)"; then
  ./start-avatar.command
  sleep 8
fi

cd obs
# OBS が別の用途（Switch 配信など）で使われているときは触らない。切り替えはアプリ「Zoom Deck」から（確認が出る）
COLL=$(node --input-type=module -e "import { connect } from './obs-ws.mjs'; const o = await connect(); console.log((await o.call('GetSceneCollectionList')).currentSceneCollectionName); o.close();" 2>/dev/null) \
  || { echo "OBS に接続できません。OBS を起動してから実行してください"; exit 1; }
if [[ "$COLL" != "Zoom（音楽+アバター）" ]]; then
  echo "OBS は別の用途（$COLL）で使われているので、何も変えずに終わります。Zoom 用に切り替えるときは、アプリ「Zoom Deck」を押してください（確認が出ます）"
  exit 0
fi
node setup-zoom-obs.mjs || { echo "OBS に接続できません。OBS を起動してから実行してください"; exit 1; }
node refresh-music.mjs
echo
echo "音楽を流しながら確認します…"
node check-levels.mjs 6
echo
cd ..
./deck.command >/dev/null
echo "ボタン盤（Zoom Deck）を開きました。「仮想カメラ」ボタンで配信を始めてください。"
