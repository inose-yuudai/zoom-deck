// 背景（OBS 側で合成する背景）— 画像と動画
// - Zoom に登録してあるバーチャル背景（画像・動画。読み取りのみ）と、Deck からアップロードしたものを一覧にする
// - 画像は backgrounds/current.png に変換して OBS の「背景（画像）」で、動画は元ファイルのまま「背景（動画）」でループ表示
//   （Zoom のバーチャル背景は「人の形」以外を全部置き換えるため、離席画面や CM が隠れてしまう。
//     背景を OBS で合成すれば、離席画面や CM は背景の上に全面で出せる）
// - 削除：アップロードしたものはファイルを消す。Zoom の背景は Zoom 側を消さず、一覧から非表示にするだけ
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BG_DIR = path.join(ROOT, 'backgrounds');
const UPLOAD_DIR = path.join(BG_DIR, 'uploaded');
export const CURRENT = path.join(BG_DIR, 'current.png');
const SETTINGS = path.join(BG_DIR, 'settings.json');
const ZOOM = path.join(os.homedir(), 'Library/Application Support/zoom.us/data');
const SOURCES = { up: UPLOAD_DIR, zoom: path.join(ZOOM, 'VirtualBkgnd_Custom'), zoomv: path.join(ZOOM, 'VirtualBkgnd_Video') };
const UPLOAD_EXT = /\.(png|jpe?g|webp|mp4|m4v|mov|webm)$/i;
const CACHE_DIR = path.join(BG_DIR, 'cache');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// 動画の縦の解像度（Spotlight の情報。分からなければ 0）
function videoHeight(file) {
  return new Promise((resolve) => {
    execFile('/usr/bin/mdls', ['-raw', '-name', 'kMDItemPixelHeight', file], (err, out) => resolve(Number(out) || 0));
  });
}

// 背景動画は OBS の出力（1280×720）より大きいと再生が重いので、720p 版を作って使う。
// 作るのは ffmpeg（macOS 標準の avconvert は、動画によって色が緑になり絵の左上しか入らない物を作ることがあった）。
// ffmpeg が無いときだけ avconvert を使う。どちらで作ったかで保存名を分ける（avconvert で作った古い物は使わない）
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p));
async function lightVideo(src) {
  const st = fs.statSync(src);
  const tool = FFMPEG ? 'ffmpeg' : 'avconvert';
  const key = crypto.createHash('sha1').update(`${src}:${st.size}:${st.mtimeMs}${FFMPEG ? ':ffmpeg' : ''}`).digest('hex').slice(0, 16);
  const out = path.join(CACHE_DIR, `${key}.mp4`);
  if (fs.existsSync(out)) return out;
  const h = await videoHeight(src);
  if (h && h <= 720) return src;
  if (!FFMPEG && !fs.existsSync('/usr/bin/avconvert')) return src;
  const tmp = path.join(CACHE_DIR, `.${key}-${Date.now()}.mp4`);
  const [cmd, args] = FFMPEG
    ? [FFMPEG, ['-y', '-v', 'error', '-i', src,
        '-vf', 'scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', tmp]]
    : ['/usr/bin/avconvert', ['--preset', 'Preset1280x720', '--source', src, '--output', tmp, '--replace']];
  console.log(`背景動画の 720p 版を作ります（${tool}）: ${path.basename(src)}`);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 300000 }, (err) => {
      if (err || !fs.existsSync(tmp)) { fs.rmSync(tmp, { force: true }); resolve(src); return; }
      fs.renameSync(tmp, out);
      resolve(out);
    });
  });
}

export function getBgSettings() {
  try {
    return { current: null, type: null, path: null, hidden: [], ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) };
  } catch {
    return { current: null, type: null, path: null, hidden: [] };
  }
}
function saveBgSettings(patch) {
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...getBgSettings(), ...patch }, null, 2));
}

// 中身の先頭で種類を判定（Zoom の背景ファイルには拡張子が無い）
function sniff(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b.toString('ascii', 4, 8) === 'ftyp') return b.toString('ascii', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
    if (b.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  } catch { /* 読めない */ }
  return null;
}
export const bgMime = (file) => sniff(file) ?? 'application/octet-stream';

export function listBackgrounds() {
  const { hidden } = getBgSettings();
  const out = [];
  for (const [src, dir] of Object.entries(SOURCES)) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      const mime = st.isFile() && sniff(p);
      if (!mime) continue;
      const id = `${src}/${name}`;
      if (hidden.includes(id)) continue;
      out.push({
        id,
        type: mime.startsWith('video/') ? 'video' : 'image',
        label: src === 'up' ? name.replace(/\.[^.]+$/, '') : 'Zoom の背景',
        removable: src === 'up' ? 'delete' : 'hide',
        mtime: st.mtimeMs,
        url: `/bg/${id}`,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// id（up/… zoom/… zoomv/…）から実ファイルを得る。フォルダの外は拒否
export function bgFile(id) {
  const m = String(id ?? '').match(/^(up|zoom|zoomv)\/([^/]+)$/);
  if (!m || m[2].startsWith('.')) return null;
  const p = path.join(SOURCES[m[1]], m[2]);
  return fs.existsSync(p) && sniff(p) ? p : null;
}

// 背景を選ぶ。画像は 1280×720 の PNG に変換、動画は元ファイルをそのまま使う
export function setBackground(id) {
  return new Promise((resolve, reject) => {
    if (!id) {
      saveBgSettings({ current: null, type: null, path: null });
      resolve(null);
      return;
    }
    const src = bgFile(id);
    if (!src) { reject(new Error('背景が見つかりません')); return; }
    if (sniff(src).startsWith('video/')) {
      lightVideo(src).then((file) => {
        saveBgSettings({ current: id, type: 'video', path: file });
        resolve({ type: 'video', path: file });
      });
      return;
    }
    const tmp = path.join(BG_DIR, `.current-${Date.now()}.png`);
    execFile('/usr/bin/sips', ['-s', 'format', 'png', src, '--out', tmp], (err) => {
      if (err) { reject(new Error('画像を変換できませんでした')); return; }
      fs.renameSync(tmp, CURRENT);
      saveBgSettings({ current: id, type: 'image', path: CURRENT });
      resolve({ type: 'image', path: CURRENT });
    });
  });
}

// 削除：アップロードしたものは消す／Zoom のものは一覧から隠す
export function removeBackground(id) {
  const file = bgFile(id);
  if (!file) throw new Error('背景が見つかりません');
  const s = getBgSettings();
  if (id.startsWith('up/')) fs.rmSync(file);
  else saveBgSettings({ hidden: [...new Set([...s.hidden, id])] });
  return s.current === id; // 使用中のものを消したら true（呼び出し側で背景なしにする）
}

export function showHiddenBackgrounds() {
  saveBgSettings({ hidden: [] });
}

export function saveBgUpload(req, name) {
  return new Promise((resolve, reject) => {
    const base = path.basename(String(name || 'background.png')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
    if (!UPLOAD_EXT.test(base)) { reject(new Error('画像（png / jpg / webp）か動画（mp4 / mov / webm）を選んでください')); return; }
    const dest = path.join(UPLOAD_DIR, base);
    const tmp = path.join(UPLOAD_DIR, `.upload-${Date.now()}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 ** 3) { req.destroy(); out.destroy(); fs.rmSync(tmp, { force: true }); reject(new Error('1GB までにしてください')); }
    });
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, dest); resolve({ id: `up/${base}` }); });
    out.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
  });
}
