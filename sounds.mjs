// 効果音ライブラリ（avatar-cam/sounds/<フォルダ>/<効果音>）
// - フォルダの作成・名前変更・削除、効果音の追加・名前変更・移動・削除
// - フォルダの並び順は sounds/order.json に保存
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SOUNDS_DIR = path.join(ROOT, 'sounds');
const ORDER_FILE = path.join(SOUNDS_DIR, 'order.json');
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|aif|aiff|ogg|flac)$/i;
const MAX_UPLOAD = 50 * 1024 ** 2;

fs.mkdirSync(SOUNDS_DIR, { recursive: true });

// 名前のチェック（フォルダの外に出る名前や制御文字は使えない）
function cleanName(name) {
  const n = String(name ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 60);
  if (!n || n.startsWith('.') || n === '..') throw new Error('使えない名前です');
  return n;
}
function folderPath(folder) {
  const p = path.join(SOUNDS_DIR, cleanName(folder));
  if (path.dirname(p) !== SOUNDS_DIR) throw new Error('使えない名前です');
  return p;
}
// "フォルダ/ファイル名.wav" から実ファイル
export function soundFile(rel) {
  const m = String(rel ?? '').match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  try {
    const p = path.join(folderPath(m[1]), m[2]);
    return !m[2].startsWith('.') && AUDIO_EXT.test(m[2]) && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

function readOrder() {
  try { return JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')).folders ?? []; } catch { return []; }
}
function writeOrder(folders) { fs.writeFileSync(ORDER_FILE, JSON.stringify({ folders }, null, 2)); }

export function listSounds() {
  const dirs = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  const order = readOrder();
  dirs.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b, 'ja'));
  return dirs.map((folder) => ({
    folder,
    sounds: fs.readdirSync(path.join(SOUNDS_DIR, folder))
      .filter((f) => AUDIO_EXT.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'ja'))
      .map((file) => ({ name: file.replace(AUDIO_EXT, ''), path: `${folder}/${file}`, url: `/se/${encodeURIComponent(folder)}/${encodeURIComponent(file)}` })),
  }));
}

// ---------------------------------------------------------------- フォルダ
export function createFolder(name) {
  const p = folderPath(name);
  if (fs.existsSync(p)) throw new Error('同じ名前のフォルダがあります');
  fs.mkdirSync(p);
  writeOrder([...readOrder(), path.basename(p)]);
}
export function renameFolder(from, to) {
  const a = folderPath(from), b = folderPath(to);
  if (!fs.existsSync(a)) throw new Error('フォルダが見つかりません');
  if (fs.existsSync(b)) throw new Error('同じ名前のフォルダがあります');
  fs.renameSync(a, b);
  writeOrder(readOrder().map((f) => (f === path.basename(a) ? path.basename(b) : f)));
}
export function deleteFolder(name) {
  const p = folderPath(name);
  if (!fs.existsSync(p)) throw new Error('フォルダが見つかりません');
  fs.rmSync(p, { recursive: true });
  writeOrder(readOrder().filter((f) => f !== path.basename(p)));
}

// ---------------------------------------------------------------- 効果音
export function renameSound(rel, newName) {
  const src = soundFile(rel);
  if (!src) throw new Error('効果音が見つかりません');
  const dest = path.join(path.dirname(src), cleanName(newName) + path.extname(src));
  if (fs.existsSync(dest)) throw new Error('同じ名前の効果音があります');
  fs.renameSync(src, dest);
}
export function moveSound(rel, folder) {
  const src = soundFile(rel);
  if (!src) throw new Error('効果音が見つかりません');
  const dir = folderPath(folder);
  if (!fs.existsSync(dir)) throw new Error('フォルダが見つかりません');
  const dest = path.join(dir, path.basename(src));
  if (fs.existsSync(dest)) throw new Error('移動先に同じ名前の効果音があります');
  fs.renameSync(src, dest);
}
export function deleteSound(rel) {
  const src = soundFile(rel);
  if (!src) throw new Error('効果音が見つかりません');
  fs.rmSync(src);
}

export function saveSoundUpload(req, folder, name) {
  return new Promise((resolve, reject) => {
    let dir, base;
    try {
      dir = folderPath(folder);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir);
      base = path.basename(String(name || ''));
      if (!AUDIO_EXT.test(base)) throw new Error('音声ファイル（wav / mp3 / m4a など）を選んでください');
      const ext = path.extname(base);
      base = cleanName(base.slice(0, -ext.length)) + ext.toLowerCase();
    } catch (e) { reject(e); return; }
    let dest = path.join(dir, base);
    for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${path.parse(base).name} (${i})${path.extname(base)}`);
    const tmp = path.join(dir, `.upload-${Date.now()}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rmSync(tmp, { force: true }); reject(new Error('50MB までにしてください')); }
    });
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, dest); resolve({ path: `${path.basename(dir)}/${path.basename(dest)}` }); });
    out.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
  });
}
