// YouTube / YouTube Music 連携（Chrome 拡張「Zoom Deck × YouTube」との中継）
// - 拡張機能から届く再生状態をタブごとに覚える
// - Deck からの操作を「いま使っているプレーヤーのタブ」に渡す（拡張機能はロングポーリングで待っている）

const tabs = new Map(); // tabId → 最新の状態
const queues = new Map(); // tabId → まだ渡していない操作
const waiters = new Map(); // tabId → 待機中のレスポンス
const ALIVE_MS = 90_000; // 裏のタブは報告が間引かれることがあるので長めに見る

function reply(res, command) {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ command }));
}

export function updateYouTube(body) {
  const prev = tabs.get(body.tabId);
  const now = Date.now();
  tabs.set(body.tabId, {
    ...body,
    seen: now,
    lastPlaying: body.playing ? now : prev?.lastPlaying ?? 0,
  });
}

export function pollYouTube(tabId, res) {
  const queue = queues.get(tabId);
  if (queue?.length) return reply(res, queue.shift());
  const old = waiters.get(tabId);
  if (old) reply(old, null);
  waiters.set(tabId, res);
  const timer = setTimeout(() => {
    if (waiters.get(tabId) === res) {
      waiters.delete(tabId);
      reply(res, null);
    }
  }, 6_000); // 操作が無くても 6 秒ごとに返し、そのたびに拡張機能が状態を送り直す
  res.on('close', () => {
    clearTimeout(timer);
    if (waiters.get(tabId) === res) waiters.delete(tabId);
  });
}

// いま操作対象にするタブ：再生中のもの → 最後に再生していたもの → 最後に報告してきたもの
function currentTab() {
  const now = Date.now();
  // 裏のタブでは動画がまだ読み込まれていないことがあるので、再生中なら対象に含める
  const alive = [...tabs.values()].filter((t) => now - t.seen < ALIVE_MS && (t.hasMedia || t.playing));
  if (!alive.length) return null;
  return alive.sort((a, b) => Number(b.playing) - Number(a.playing) || b.lastPlaying - a.lastPlaying || b.seen - a.seen)[0];
}

export function sendYouTube(command) {
  const tab = currentTab();
  if (!tab) return false;
  const waiter = waiters.get(tab.tabId);
  if (waiter) {
    waiters.delete(tab.tabId);
    reply(waiter, command);
  } else {
    const q = queues.get(tab.tabId) ?? [];
    q.push(command);
    queues.set(tab.tabId, q.slice(-5));
  }
  return true;
}

export function youTubeState() {
  const tab = currentTab();
  if (!tab) return { online: false };
  const { site, title, artist, artwork, playing, currentTime, duration, seen, muted } = tab;
  // 最後の報告からの経過分だけ再生位置を進めて見せる
  const position = playing ? Math.min(duration || Infinity, currentTime + (Date.now() - seen) / 1000) : currentTime;
  return { online: true, site, title, artist, artwork, playing, position, duration, muted: Boolean(muted) };
}

export function youTubeIsPlaying() {
  return currentTab()?.playing ?? false;
}

// 確認用：届いているタブの一覧
export function youTubeDebug() {
  const now = Date.now();
  return [...tabs.values()].map((t) => ({ tabId: t.tabId, site: t.site, title: t.title, hasMedia: t.hasMedia, playing: t.playing, ageSec: Math.round((now - t.seen) / 1000) }));
}
