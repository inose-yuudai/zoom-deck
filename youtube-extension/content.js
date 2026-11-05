// YouTube / YouTube Music のページで動く部分
// - 再生状態（曲名・アーティスト・再生中か・再生位置）を 1 秒ごとに Zoom Deck へ送る
// - Zoom Deck からの操作（再生/一時停止・次へ・前へ）を受け取って実行する
// 拡張機能の再読み込みなどで新しいスクリプトが入ったら、古い方は止まる（DOM イベントで引き継ぐ）
document.dispatchEvent(new CustomEvent('zoomdeck-yt-start'));

const isMusic = location.host === 'music.youtube.com';

function video() {
  return document.querySelector(isMusic ? 'video' : 'video.html5-main-video') ?? document.querySelector('video');
}

function currentState() {
  const v = video();
  const md = navigator.mediaSession?.metadata;
  const art = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : '';
  return {
    site: isMusic ? 'YouTube Music' : 'YouTube',
    title: md?.title || document.title.replace(/ - YouTube( Music)?$/, ''),
    artist: md?.artist || '',
    artwork: art,
    hasMedia: Boolean(v && (v.readyState > 0 || !v.paused)),
    playing: Boolean(v && !v.paused && !v.ended),
    currentTime: v?.currentTime ?? 0,
    duration: Number.isFinite(v?.duration) ? v.duration : 0,
    muted: v?.muted ?? false,
  };
}

function click(selector) {
  const el = document.querySelector(selector);
  if (el) el.click();
  return Boolean(el);
}

function run(command) {
  const v = video();
  switch (command.type) {
    case 'toggle':
      if (v?.paused) run({ type: 'play' });
      else run({ type: 'pause' });
      break;
    case 'play':
      // プレーヤーのボタンを押すと YouTube 側の表示とも揃う
      if (!(v?.paused && click(isMusic ? '#play-pause-button' : '.ytp-play-button'))) v?.play();
      break;
    case 'pause':
      if (!(v && !v.paused && click(isMusic ? '#play-pause-button' : '.ytp-play-button'))) v?.pause();
      break;
    case 'next':
      click(isMusic ? 'ytmusic-player-bar .next-button' : '.ytp-next-button');
      break;
    case 'prev':
      if (isMusic) click('ytmusic-player-bar .previous-button');
      else if (v && v.currentTime > 3) v.currentTime = 0;
      else click('.ytp-prev-button') || history.back();
      break;
    case 'seek':
      if (v) v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + Number(command.delta || 0)));
      break;
  }
  setTimeout(report, 300);
}

const alive = () => !stopped && Boolean(chrome.runtime?.id); // 拡張機能が再読み込みされると id が消える

function stop() {
  stopped = true;
  clearInterval(timer);
}

function report() {
  if (!alive()) { stop(); return; }
  chrome.runtime.sendMessage({ type: 'state', state: currentState() }).catch(() => {});
}

let stopped = false;
const timer = setInterval(report, 1000);
document.addEventListener('zoomdeck-yt-start', stop, { once: true });
report();

// 操作の受け取り（サーバー側で待たせるロングポーリング）。タイマーではないので、裏のタブでも遅れにくい
async function pollLoop() {
  while (alive()) {
    try {
      const command = await chrome.runtime.sendMessage({ type: 'poll' });
      if (command && !command.retryLater) run(command);
      // 裏のタブではタイマーが間引かれるので、通信が返ってくるたびにも状態を送る
      report();
    } catch {
      // サーバーが止まっていた等：少し待ってつなぎ直す
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
pollLoop();
