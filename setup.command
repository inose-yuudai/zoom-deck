#!/bin/zsh
# Zoom Deck のセットアップ（ダブルクリックか、ターミナルから実行）。何度実行しても大丈夫です。入っている物は飛ばします。
#   1. 足りない物を入れる（Node・ffmpeg・OBS・BlackHole 2ch、アバター用のブラウザ）
#   2. OBS の WebSocket をオンにする（今あるパスワードはそのまま。無ければ作る）
#   3. アプリ「Zoom Deck」を作る
# 今ある OBS の設定は消しません。OBS には次の起動のときに「Zoom」という設定が足されます。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"
SUPPORT="$HOME/Library/Application Support/AvatarCam"
OBS_WS_CONFIG="$HOME/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json"
PUPPETEER_BROWSERS="@puppeteer/browsers@3.2.6"

step() { print -P "\n%B▶ $1%b"; }
stop_here() { print -P "\n%F{red}$1%f"; exit 1; }

[[ "$(uname)" == "Darwin" ]] || stop_here "Zoom Deck は Mac 専用です。"

step "足りない物を確かめます"
command -v brew >/dev/null || stop_here "Homebrew が必要です。https://brew.sh の手順で入れてから、もう一度実行してください。"

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if (( node_major < 22 )); then
  echo "Node を入れます"
  brew install node || stop_here "Node を入れられませんでした。"
fi
if ! command -v ffmpeg >/dev/null; then
  echo "ffmpeg を入れます"
  brew install ffmpeg || stop_here "ffmpeg を入れられませんでした。"
fi
if [[ ! -d /Applications/OBS.app ]]; then
  echo "OBS を入れます"
  brew install --cask obs || stop_here "OBS を入れられませんでした。"
fi
if [[ ! -d /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver ]]; then
  echo "BlackHole 2ch を入れます（Mac のパスワードを聞かれます）"
  brew install --cask blackhole-2ch || stop_here "BlackHole 2ch を入れられませんでした。"
  NEED_RESTART=1
fi
xcode-select -p >/dev/null 2>&1 || echo "（Xcode のコマンドライン ツールが無いので、全体ショートカットは使えません。入れるときは xcode-select --install）"

step "OBS の WebSocket を確かめます"
ws_state=$(OBS_WS_CONFIG="$OBS_WS_CONFIG" node -e '
  const fs = require("fs"), path = require("path"), crypto = require("crypto");
  const file = process.env.OBS_WS_CONFIG;
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (c.server_enabled && c.server_port && (!c.auth_required || c.server_password)) { console.log("ok"); process.exit(0); }
  console.log("write");
  if (process.argv[1] === "running") process.exit(0);
  const next = { alerts_enabled: false, first_load: false, ...c, server_enabled: true, server_port: c.server_port || 4455, auth_required: true,
    server_password: c.server_password || crypto.randomBytes(18).toString("base64url") };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
' "$(pgrep -qx OBS && echo running)")
if [[ "$ws_state" == "write" ]] && pgrep -qx OBS; then
  stop_here "OBS を一度閉じてから、もう一度実行してください（OBS が開いていると設定を書き込めません）。"
fi
echo "WebSocket はオンです（パスワードはこの Mac の OBS の設定の中にだけあります）"

step "アバター用のブラウザを確かめます"
if ! find "$SUPPORT/browsers/chrome" -maxdepth 3 -name "Google Chrome for Testing.app" 2>/dev/null | grep -q .; then
  echo "Google 公式の Chrome for Testing を入れます（約 360MB。いつもの Chrome とは別のアプリで、いつもの Chrome には触りません）"
  mkdir -p "$SUPPORT/browsers"
  npx --yes "$PUPPETEER_BROWSERS" install chrome@stable --path "$SUPPORT/browsers" || stop_here "ブラウザを入れられませんでした。ネットの接続を確かめて、もう一度実行してください。"
fi

step "アプリ「Zoom Deck」を作ります"
./install.command || stop_here "インストールできませんでした。"
"$SUPPORT/app/hotkeys.command" build || true

step "できました"
cat <<EOF
次にすること（くわしくは README.md）:
  1. /アプリケーション の「Zoom Deck」を開く
     初めての OBS で「自動構成ウィザード」が出たら「キャンセル」。マイク・画面収録・カメラの許可を聞かれたら許可します
  2. OBS の「仮想カメラ開始」で確認が出たら、システム設定 → 一般 → ログイン項目と機能拡張 → カメラ機能拡張 で OBS をオンにします
  3. Zoom の設定：マイク「BlackHole 2ch」／カメラ「OBS Virtual Camera」／スピーカーはいつもの物
EOF
[[ -n "$NEED_RESTART" ]] && print -P "\n%BBlackHole 2ch を入れたので、Zoom のマイクの一覧に出ないときは Mac を再起動してください。%b"
exit 0
