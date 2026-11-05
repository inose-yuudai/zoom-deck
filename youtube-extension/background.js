// YouTube のタブ（content.js）とローカルの Zoom Deck サーバーの中継役。
// https のページから http://127.0.0.1 へ直接つなぐと Chrome にブロックされるため、拡張機能の裏側で通信する。
const SERVER = 'http://127.0.0.1:18787';

// 拡張機能を入れた（更新した）とき、すでに開いている YouTube タブにも読み込む
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://music.youtube.com/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (tabId == null) return false;

  if (msg.type === 'state') {
    fetch(`${SERVER}/api/yt/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, ...msg.state }),
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'poll') {
    // サーバーは操作が来るまで最大 20 秒待ってから返す（ロングポーリング）
    fetch(`${SERVER}/api/yt/poll?tabId=${tabId}`)
      .then((r) => r.json())
      .then((res) => sendResponse(res.command ?? null))
      .catch(() => setTimeout(() => sendResponse({ retryLater: true }), 3000));
    return true; // 非同期で返す
  }
  return false;
});
