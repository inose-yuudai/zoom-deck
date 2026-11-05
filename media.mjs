// CM・動画のライブラリ（avatar-cam/media/ フォルダ）
// - Deck からアップロード・削除・一覧
// - 離席中に流す動画や離席メッセージなどの設定を保存
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = path.join(ROOT, 'media');
const SETTINGS_FILE = path.join(MEDIA_DIR, 'settings.json');
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i;
const MAX_UPLOAD = 2 * 1024 ** 3; // 2GB

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const DEFAULT_SETTINGS = { brbVideo: null, brbMessage: 'すぐ戻ります！', pauseYouTubeOnCm: true, seVolumeDb: -6 };

export function getMediaSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setMediaSettings(patch) {
  const next = { ...getMediaSettings() };
  if ('brbVideo' in patch) next.brbVideo = patch.brbVideo && mediaPath(patch.brbVideo) ? patch.brbVideo : null;
  if ('brbMessage' in patch) next.brbMessage = String(patch.brbMessage).slice(0, 60);
  if ('pauseYouTubeOnCm' in patch) next.pauseYouTubeOnCm = Boolean(patch.pauseYouTubeOnCm);
  if ('seVolumeDb' in patch) next.seVolumeDb = Math.max(-40, Math.min(0, Number(patch.seVolumeDb) || 0));
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function listMedia() {
  return fs.readdirSync(MEDIA_DIR)
    .filter((n) => VIDEO_EXT.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(MEDIA_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs, url: `/media/${encodeURIComponent(name)}` };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// フォルダの外を指す名前や動画以外は受け付けない
export function mediaPath(name) {
  const base = path.basename(String(name ?? ''));
  if (!base || base !== name || !VIDEO_EXT.test(base)) return null;
  const p = path.join(MEDIA_DIR, base);
  return fs.existsSync(p) ? p : null;
}

function safeName(name) {
  let base = path.basename(String(name || 'video.mp4')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  if (!VIDEO_EXT.test(base)) throw new Error('動画ファイル（mp4 / mov / webm / m4v / mkv）を選んでください');
  const { name: stem, ext } = path.parse(base);
  for (let i = 2; fs.existsSync(path.join(MEDIA_DIR, base)); i++) base = `${stem} (${i})${ext}`;
  return base;
}

export function saveUpload(req, name) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = safeName(name); } catch (e) { reject(e); return; }
    const tmp = path.join(MEDIA_DIR, `.upload-${Date.now()}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        out.destroy();
        fs.rmSync(tmp, { force: true });
        reject(new Error('2GB を超える動画はアップロードできません'));
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (size === 0) { fs.rmSync(tmp, { force: true }); reject(new Error('空のファイルです')); return; }
      fs.renameSync(tmp, path.join(MEDIA_DIR, base));
      resolve({ name: base, size });
    });
    out.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
  });
}

export function deleteMedia(name) {
  const p = mediaPath(name);
  if (!p) throw new Error('動画が見つかりません');
  fs.rmSync(p);
  if (getMediaSettings().brbVideo === name) setMediaSettings({ brbVideo: null });
}
