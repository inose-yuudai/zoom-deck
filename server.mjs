// Avatar Cam ローカルサーバー（依存なし）
// - public/ を配信
// - models.json に書いたローカルのモデル（VRM / Live2D）を /m/<番号>/... で配信
// - 127.0.0.1 のみで待ち受け
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getState, getLevels, runAction, handleEvents, setAvatarStatus, getView } from './deck.mjs';
import { updateYouTube, pollYouTube, youTubeDebug } from './youtube.mjs';
import { MEDIA_DIR, listMedia, saveUpload, deleteMedia, getMediaSettings, setMediaSettings } from './media.mjs';
import { listBackgrounds, bgFile, bgMime, saveBgUpload, getBgSettings } from './bg.mjs';
import { listSounds, soundFile, saveSoundUpload, createFolder, renameFolder, deleteFolder, renameSound, moveSound, deleteSound } from './sounds.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 18787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.moc3': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

// 配布版は Live2D を切ってある（NO_LIVE2D の印。理由は README）
const LIVE2D = !fs.existsSync(path.join(ROOT, 'NO_LIVE2D'));

// models フォルダの中のモデル：.vrm と、Live2D（フォルダの中の .model3.json）。名前はファイル名
function scanModels() {
  const dir = path.join(ROOT, 'models');
  const found = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
    const p = path.join(dir, e.name);
    if (e.isFile() && /\.vrm$/i.test(e.name)) {
      found.push({ name: e.name.replace(/\.vrm$/i, ''), type: 'vrm', path: p });
    } else if (e.isDirectory() && LIVE2D) {
      const stack = [p];
      while (stack.length) {
        const d = stack.pop();
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          if (f.isDirectory()) stack.push(path.join(d, f.name));
          else if (/\.model3\.json$/i.test(f.name)) found.push({ name: f.name.replace(/\.model3\.json$/i, ''), type: 'live2d', path: path.join(d, f.name) });
        }
      }
    }
  }
  return found;
}

function loadModels() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('models.json を読めませんでした:', e.message);
  }
  // 自分のモデルを先に並べる（models.json のサンプルは後ろ）
  return [...scanModels(), ...list.filter((m) => (LIVE2D || m.type !== 'live2d') && (m.url || (m.path && fs.existsSync(m.path))))];
}

// ---- モデルのプレビュー画像
// models.json の "preview"（画像の絶対パス、または https の URL）を使う。
// 無い VRM はファイルに入っているサムネイルを取り出す（VRM1: VRMC_vrm.meta.thumbnailImage / VRM0: VRM.meta.texture）。
// VRM は大きいので、GLB の JSON 部分と画像の部分だけを読む。結果はファイルの更新時刻ごとに覚えておく。
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const thumbCache = new Map();

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, offset);
  return buf;
}

function vrmThumbnail(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);
  let result = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, 20);
    if (head.toString('latin1', 0, 4) === 'glTF' && head.readUInt32LE(16) === 0x4e4f534a) { // JSON チャンク
      const jsonLen = head.readUInt32LE(12);
      const json = JSON.parse(readAt(fd, 20, jsonLen).toString('utf8'));
      const binStart = 20 + jsonLen + 8; // BIN チャンクの中身の先頭
      let img = json.extensions?.VRMC_vrm?.meta?.thumbnailImage;
      if (img == null) {
        const tex = json.extensions?.VRM?.meta?.texture;
        if (tex != null && tex >= 0) img = json.textures?.[tex]?.source;
      }
      const image = img != null ? json.images?.[img] : null;
      const view = image?.bufferView != null ? json.bufferViews?.[image.bufferView] : null;
      if (view && (view.buffer ?? 0) === 0 && view.byteLength > 0 && view.byteLength < 20 * 1024 ** 2) {
        result = { mime: image.mimeType || 'image/png', buf: readAt(fd, binStart + (view.byteOffset ?? 0), view.byteLength) };
      }
    }
  } catch (e) {
    console.error('VRM のサムネイルを読めませんでした:', path.basename(file), e.message);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  thumbCache.set(key, result);
  return result;
}

// 表示用に 256px へ縮めた画像（cache/previews に保存して使い回す）。元の画像は 2048px・1MB 以上のことがあるため
const PREVIEW_CACHE = path.join(ROOT, 'cache', 'previews');
function smallPreview(m) {
  if (!m) return null;
  let src = null, thumb = null;
  if (typeof m.preview === 'string' && IMAGE_EXT.test(m.preview) && fs.existsSync(m.preview)) src = m.preview;
  else if (m.type === 'vrm' && m.path) { thumb = vrmThumbnail(m.path); if (!thumb) return null; src = m.path; }
  else return null;
  const st = fs.statSync(src);
  const out = path.join(PREVIEW_CACHE, `${createHash('sha1').update(`${src}:${st.mtimeMs}:${st.size}`).digest('hex')}.png`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(PREVIEW_CACHE, { recursive: true });
  let input = src;
  if (thumb) { input = `${out}.src`; fs.writeFileSync(input, thumb.buf); }
  try {
    execFileSync('/usr/bin/sips', ['-Z', '256', '-s', 'format', 'png', input, '--out', out], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // 縮められなかったときは元の画像をそのまま使う
    fs.copyFileSync(input, out);
  } finally {
    if (thumb) fs.rmSync(input, { force: true });
  }
  return out;
}

// ブラウザに渡すプレビューの URL（無ければ null）。?v= は画像が変わったときに読み直させるため
function previewUrl(m, i) {
  if (typeof m.preview === 'string' && /^https?:\/\//.test(m.preview)) return m.preview;
  if (typeof m.preview === 'string' && IMAGE_EXT.test(m.preview)) {
    try { return `/preview/${i}?v=${Math.round(fs.statSync(m.preview).mtimeMs)}`; } catch { /* 無ければ下へ */ }
  }
  if (m.type === 'vrm' && m.path && vrmThumbnail(m.path)) return `/preview/${i}?v=${Math.round(fs.statSync(m.path).mtimeMs)}`;
  return null;
}

// 返すのは URL だけ（ローカルの絶対パスはブラウザに渡さない）
function publicList(models) {
  return models.map((m, i) => ({
    name: m.name,
    type: m.type,
    url: m.url || `/m/${i}/${encodeURIComponent(path.basename(m.path))}`,
    preview: previewUrl(m, i),
  }));
}

function sendFile(res, file, req, mime = null) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    // 動画のシーク用に Range リクエストに対応
    const range = req?.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': mime || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': mime || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// base ディレクトリの外に出るパスは拒否
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

const statusByPage = {};
let lastDeckSeen = 0; // ボタン盤のページが最後に状態を取りに来た時刻
let deckBornMax = 0; // 一番新しく開いたボタン盤の窓（これより古い窓には「閉じて」と返す）

// 同じフォルダのスクリプトを切り離して実行（サーバーが止まっても続く）
function runDetached(cmd, args = []) {
  spawn(cmd, args, { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } }).unref();
}

// よそのサイトからの操作を断る。このサーバーは 127.0.0.1 だけで待っているが、同じ Mac のブラウザで開いた別のサイトからは届いてしまう
// （マイクの切り替えや終了を勝手にされないように）。Host が自分でないもの（DNS リバインディング）と、Origin が自分でないものは受けない。
// 拡張機能（YouTube 連携）は /api/yt/ だけ。Origin が無いのは、全体ショートカットの道具などブラウザ以外の呼び出し
function allowedRequest(req, pathname) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (host !== 'localhost' && host !== '127.0.0.1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (pathname.startsWith('/api/yt/') && origin.startsWith('chrome-extension://')) return true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  if (!allowedRequest(req, pathname)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (pathname === '/api/status') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const st = JSON.parse(body);
          statusByPage[st.page || '/'] = st;
          setAvatarStatus(statusByPage);
        } catch { /* 無視 */ }
        res.writeHead(204).end();
      });
    } else {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(statusByPage, null, 2));
    }
    return;
  }

  // ---- 効果音ライブラリ
  if (pathname === '/api/se' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ folders: listSounds(), volumeDb: getMediaSettings().seVolumeDb ?? -6 }));
    return;
  }
  if (pathname === '/api/se/upload' && req.method === 'POST') {
    saveSoundUpload(req, url.searchParams.get('folder'), url.searchParams.get('name'))
      .then((r) => { res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(r)); })
      .catch((e) => { if (!res.headersSent) res.writeHead(400, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }
  if (pathname === '/api/se/op' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        const ops = {
          createFolder: () => createFolder(d.name),
          renameFolder: () => renameFolder(d.from, d.to),
          deleteFolder: () => deleteFolder(d.name),
          renameSound: () => renameSound(d.path, d.name),
          moveSound: () => moveSound(d.path, d.folder),
          deleteSound: () => deleteSound(d.path),
        };
        if (!ops[d.op]) throw new Error('不明な操作です');
        ops[d.op]();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const sm = pathname.match(/^\/se\/([^/]+)\/([^/]+)$/);
  if (sm) {
    const file = soundFile(`${sm[1]}/${sm[2]}`);
    if (!file) { res.writeHead(404).end('not found'); return; }
    sendFile(res, file, req);
    return;
  }

  // ---- 背景画像
  if (pathname === '/api/bg' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ items: listBackgrounds(), current: getBgSettings().current, hiddenCount: getBgSettings().hidden.length }));
    return;
  }
  if (pathname === '/api/bg/upload' && req.method === 'POST') {
    saveBgUpload(req, url.searchParams.get('name'))
      .then((r) => { res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(r)); })
      .catch((e) => { if (!res.headersSent) res.writeHead(400, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }
  const bm = pathname.match(/^\/bg\/((?:up|zoom|zoomv)\/[^/]+)$/);
  if (bm) {
    const file = bgFile(bm[1]);
    if (!file) { res.writeHead(404).end('not found'); return; }
    sendFile(res, file, req, bgMime(file));
    return;
  }

  // ---- CM・動画ライブラリ
  if (pathname === '/api/media' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ files: listMedia(), settings: getMediaSettings() }));
    return;
  }
  if (pathname === '/api/media/upload' && req.method === 'POST') {
    saveUpload(req, url.searchParams.get('name'))
      .then((r) => { res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(r)); })
      .catch((e) => { if (!res.headersSent) res.writeHead(400, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }
  if ((pathname === '/api/media/delete' || pathname === '/api/media/settings') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        let result;
        if (pathname === '/api/media/delete') { deleteMedia(data.name); result = { ok: true }; }
        else result = setMediaSettings(data);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const mm = pathname.match(/^\/media\/([^/]+)$/);
  if (mm) {
    const file = safeJoin(MEDIA_DIR, mm[1]);
    if (!file || path.basename(file).startsWith('.')) { res.writeHead(403).end('forbidden'); return; }
    sendFile(res, file, req);
    return;
  }

  // ---- YouTube 連携（Chrome 拡張から）
  // 拡張機能に通信先の許可が無い場合（ポート変更直後など）でも届くよう、拡張機能からの通信は CORS で受け付ける
  if (pathname.startsWith('/api/yt/')) {
    const origin = req.headers.origin || '';
    if (origin.startsWith('chrome-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }
  }
  if (pathname === '/api/yt/state' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try { updateYouTube(JSON.parse(body)); } catch { /* 無視 */ }
      res.writeHead(204).end();
    });
    return;
  }
  if (pathname === '/api/yt/debug') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(youTubeDebug(), null, 2));
    return;
  }
  if (pathname === '/api/yt/poll') {
    pollYouTube(Number(url.searchParams.get('tabId')), res);
    return;
  }

  // ---- ボタン盤（Zoom Deck）
  if (pathname === '/api/events') {
    handleEvents(req, res);
    return;
  }
  if (pathname === '/api/view') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getView()));
    return;
  }
  if (pathname === '/api/deck/levels') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getLevels()));
    return;
  }
  if (pathname === '/api/deck/seen') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ deckSec: lastDeckSeen ? (Date.now() - lastDeckSeen) / 1000 : null }));
    return;
  }
  if (pathname === '/api/launch' && req.method === 'POST') {
    // Deck の「OBS を起動」：アプリと同じ起動処理（二重起動は launch.sh 側で防ぐ）
    runDetached('/bin/zsh', ['./launch.sh']);
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end('{"ok":true}');
    return;
  }
  if (pathname === '/api/avatar/open' && req.method === 'POST') {
    // アバター画面を開き直し、少し待ってから OBS にその窓を取り込ませる
    // OBS が別の用途（Switch 配信など）で使われているときは、OBS の設定は変えない
    runDetached('/bin/zsh', ['-c', './start-avatar.command; sleep 8; node obs/setup-zoom-obs.mjs --relink --only-if-zoom']);
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end('{"ok":true}');
    return;
  }
  if (pathname === '/api/shutdown' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end('{"ok":true}');
    runAction({ action: 'shutdown' }).catch(() => {}).finally(() => {
      runDetached('/bin/zsh', ['./stop.sh']);
      // stop.sh が OBS の終了待ちで時間がかかっても、サーバーは自分で確実に止まる
      setTimeout(() => process.exit(0), 1500);
    });
    return;
  }
  if (pathname === '/api/deck/state') {
    if (url.searchParams.get('from') === 'deck') {
      lastDeckSeen = Date.now();
      const born = url.searchParams.get('win') === 'app' ? Number(url.searchParams.get('born')) || 0 : 0;
      if (born && born < deckBornMax) {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
        res.end('{"close":true}');
        return;
      }
      if (born) deckBornMax = born;
    }
    getState().then((st) => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(st));
    });
    return;
  }
  if (pathname === '/api/deck/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const result = await runAction(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/models') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(publicList(loadModels())));
    return;
  }

  const pv = pathname.match(/^\/preview\/(\d+)$/);
  if (pv) {
    const small = smallPreview(loadModels()[Number(pv[1])]);
    if (!small) {
      res.writeHead(404).end('not found');
      return;
    }
    sendFile(res, small);
    return;
  }

  const m = pathname.match(/^\/m\/(\d+)\/(.+)$/);
  if (m) {
    const model = loadModels()[Number(m[1])];
    if (!model || !model.path) {
      res.writeHead(404).end('not found');
      return;
    }
    const file = safeJoin(path.dirname(model.path), m[2]);
    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }
    sendFile(res, file);
    return;
  }

  const file = safeJoin(PUBLIC, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!file) {
    res.writeHead(403).end('forbidden');
    return;
  }
  sendFile(res, file);
}

// ---- 落ちにくくする：想定外のエラーでもサーバーは止めない（記録だけ残す）
const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] リクエスト処理のエラー:`, e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': MIME['.json'] });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'サーバー内部のエラー' }));
  }
});
process.on('uncaughtException', (e) => console.error(`[${new Date().toISOString()}] 想定外のエラー（続行）:`, e));
process.on('unhandledRejection', (e) => console.error(`[${new Date().toISOString()}] 想定外のエラー（続行）:`, e));

server.on('error', (e) => {
  // 同じ番号でもう動いている（見張り役と起動が重なった等）なら、こちらは静かに終わる
  if (e.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中のため、このサーバーは終了します`);
    process.exit(0);
  }
  console.error(e);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Avatar Cam: http://localhost:${PORT}/`);
});
