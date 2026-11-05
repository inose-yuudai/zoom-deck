// ボタン盤（Zoom Deck）のサーバー側
// - OBS と常時接続して、ミュート・表示切り替え・仮想カメラなどを操作する
// - Avatar Cam のページへ表情やモデルの切り替えを送る（Server-Sent Events）
import fs from 'node:fs';
import { connect } from './obs/obs-ws.mjs';
import { recreateMusicInputs } from './obs/music.mjs';
import { sendYouTube, youTubeState, youTubeIsPlaying } from './youtube.mjs';
import { getMediaSettings, setMediaSettings, mediaPath } from './media.mjs';
import { soundFile } from './sounds.mjs';
import { setBackground, getBgSettings, removeBackground, showHiddenBackgrounds, CURRENT as BG_FILE } from './bg.mjs';

const SCENE = 'Zoom';
const MIC = 'マイク（ノイズ除去）';
const AVATAR = 'アバター（Avatar Cam ウィンドウ）';
const REAL_CAM = '実カメラ';
const BRB_ITEMS = ['離席中（背景）', '離席中（文字）'];
const CM = 'CM（動画）';
const BG = '背景（画像）';
const BG_VIDEO = '背景（動画）';
const KEY_FILTER = 'グリーンバック除去';
const INPUTS = 1 << 3; // モニターの種類の変更・入力の削除を知るため
const MEDIA_INPUTS = 1 << 8;
const INPUT_VOLUME_METERS = 1 << 16;

// ---------------------------------------------------------------- OBS 接続
let obs = null;
let connecting = null;
const peaks = {}; // 入力名 → 直近のピーク（0〜1）

function onEvent(type, data) {
  if (type === 'MediaInputPlaybackEnded' && data.inputName === CM) {
    stopCm().catch(() => {});
    return;
  }
  if (type === 'InputAudioMonitorTypeChanged') {
    monitorOn.set(data.inputName, data.monitorType !== MONITOR_OFF);
    return;
  }
  if (type === 'InputRemoved') {
    monitorOn.delete(data.inputName);
    return;
  }
  if (type !== 'InputVolumeMeters') return;
  for (const input of data.inputs) {
    const peak = Math.max(0, ...input.inputLevelsMul.map((ch) => ch[1] ?? 0));
    // 表示用にゆっくり減衰させる
    peaks[input.inputName] = Math.max(peak, (peaks[input.inputName] ?? 0) * 0.85);
  }
}

async function getObs() {
  if (process.env.ZOOMDECK_NO_OBS) throw new Error('OBS につながない設定です（テスト用）');
  if (obs) return obs;
  connecting ??= connect({
    eventSubscriptions: INPUT_VOLUME_METERS | MEDIA_INPUTS | INPUTS,
    onEvent,
    onClose: () => { obs = null; foreign = undefined; monitorOn.clear(); },
  }).then((c) => {
    obs = c;
    return c;
  }).finally(() => { connecting = null; });
  return connecting;
}

// OBS が Zoom 用の設定（シーンコレクション）のときだけ触る。
// 別の用途（例：Switch 配信）で使われているときは、Zoom Deck からは何も変えない（ボタンも効かない）。
// 確かめるのは 3 秒に 1 回まで。Zoom 用に戻ったら、背景・効果音の部品をそろえ直す
const COLLECTION = 'Zoom（音楽+アバター）';
let foreign;          // undefined: まだ確かめていない / null: Zoom 用 / 文字列: 使われているコレクション名
let collectionCheckedAt = 0;
async function zoomObs() {
  const o = await getObs();
  if (foreign === undefined || Date.now() - collectionCheckedAt > 3000) {
    collectionCheckedAt = Date.now();
    const { currentSceneCollectionName: name } = await o.call('GetSceneCollectionList');
    const was = foreign;
    foreign = name === COLLECTION ? null : name;
    if (foreign === null && was !== null) {
      monitorOn.clear(); // コレクションが変わると入力も変わる
      applyBg().catch(() => {});
      removeOldRealCam().catch(() => {});
      ensureSePool().catch(() => {});
    }
  }
  if (foreign) throw Object.assign(new Error(`OBS は別の用途（${foreign}）で使われています`), { foreign });
  return o;
}

async function itemId(sourceName) {
  const o = await zoomObs();
  return (await o.call('GetSceneItemId', { sceneName: SCENE, sourceName })).sceneItemId;
}

async function setVisible(sourceName, enabled) {
  const o = await zoomObs();
  await o.call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: await itemId(sourceName), sceneItemEnabled: enabled });
}

async function isVisible(sourceName) {
  const o = await zoomObs();
  return (await o.call('GetSceneItemEnabled', { sceneName: SCENE, sceneItemId: await itemId(sourceName) })).sceneItemEnabled;
}

let musicNames = [];
async function musicInputs() {
  const o = await zoomObs();
  musicNames = (await o.call('GetInputList', { inputKind: 'sck_audio_capture' })).inputs.map((i) => i.inputName);
  return musicNames;
}

// モニター出力（= BlackHole → Zoom）に流しているかを覚えておく（入力の名前 → true / false）。
// OBS 33 では「モニターのみ」を指定しても、読み返すと「モニターと出力」になる（どちらも Zoom へ流れる）ので、種類ではなく流す・流さないで比べる。
// モニターの種類の読み書きは OBS の記録に「古い書き方」の警告を出すので、知っている状態と同じなら OBS に問い合わせない。
// OBS の画面で変えられたときは、イベント（InputAudioMonitorTypeChanged）で知る
const MONITOR_OFF = 'OBS_MONITORING_TYPE_NONE';
const MONITOR_ON = 'OBS_MONITORING_TYPE_MONITOR_ONLY';
const monitorOn = new Map();

// ミュートの切り替え。OBS ではミュートしても「モニター出力」（= BlackHole → Zoom）には音が流れ続けるため、
// ミュート中はモニター出力も切る。解除で元に戻す。
async function setMuted(inputName, muted) {
  const o = await zoomObs();
  await o.call('SetInputMute', { inputName, inputMuted: muted });
  await o.call('SetInputAudioMonitorType', { inputName, monitorType: muted ? MONITOR_OFF : MONITOR_ON });
  monitorOn.set(inputName, !muted);
}

// OBS の画面で直接ミュートされた場合なども、モニター出力をミュートの状態にそろえる
async function syncMonitor(inputName, muted) {
  if (monitorOn.get(inputName) === !muted) return;
  const o = await zoomObs();
  const { monitorType } = await o.call('GetInputAudioMonitorType', { inputName });
  if ((monitorType !== MONITOR_OFF) === muted) {
    await o.call('SetInputAudioMonitorType', { inputName, monitorType: muted ? MONITOR_OFF : MONITOR_ON });
  }
  monitorOn.set(inputName, !muted);
}

const toDb = (mul) => (mul > 0 ? Math.max(-60, 20 * Math.log10(mul)) : -60);

// ---------------------------------------------------------------- Avatar Cam ページとの連携
const avatarClients = new Set();
let avatarStatus = {};

export function setAvatarStatus(statusByPage) {
  // 一番新しく報告してきたページを「現在のアバター」とみなす
  const latest = Object.values(statusByPage).sort((a, b) => (a.time < b.time ? 1 : -1))[0];
  avatarStatus = latest ?? {};
}

// アバター窓は 1 つだけにする：アプリ窓（?win=app）同士では、後から開いた窓が残り、古い窓には「閉じて」を送る
// （最小化されて止まった窓が残っていても、開き直せば自動で片付く。born はページを開いた時刻）
let avatarBornMax = 0;
const CLOSE_MSG = `data: ${JSON.stringify({ type: 'close' })}\n\n`;

export function handleEvents(req, res) {
  const q = new URL(req.url, 'http://localhost').searchParams;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  res.born = q.get('win') === 'app' ? Number(q.get('born')) || 0 : 0;
  avatarClients.add(res);
  if (res.born && res.born < avatarBornMax) res.write(CLOSE_MSG);
  else if (res.born) {
    avatarBornMax = res.born;
    for (const c of avatarClients) if (c !== res && c.born && c.born < res.born) c.write(CLOSE_MSG);
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); avatarClients.delete(res); });
}

function sendToAvatar(command) {
  for (const res of avatarClients) res.write(`data: ${JSON.stringify(command)}\n\n`);
  return avatarClients.size;
}

// 波形表示用の軽い問い合わせ（OBS には問い合わせず、届いているメーター値だけ返す）
export function getLevels() {
  getObs().catch(() => {});
  return {
    mic: toDb(peaks[MIC] ?? 0),
    music: toDb(Math.max(0, ...musicNames.map((n) => peaks[n] ?? 0))),
  };
}

// ---------------------------------------------------------------- CM（動画）
let cmPlaying = null; // 再生中の動画ファイル名
let ytPausedByCm = false;

async function ensureCmInput() {
  const o = await zoomObs();
  try {
    await o.call('GetInputSettings', { inputName: CM });
  } catch {
    await o.call('CreateInput', {
      sceneName: SCENE, inputName: CM, inputKind: 'ffmpeg_source', sceneItemEnabled: false,
      inputSettings: { is_local_file: true, looping: false, restart_on_activate: true, close_when_inactive: true },
    });
    await o.call('SetInputAudioMonitorType', { inputName: CM, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' });
    const id = await itemId(CM);
    const { sceneItems } = await o.call('GetSceneItemList', { sceneName: SCENE });
    await o.call('SetSceneItemTransform', {
      sceneName: SCENE, sceneItemId: id,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1280, boundsHeight: 720, boundsAlignment: 0 },
    });
    await o.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: id, sceneItemIndex: sceneItems.length - 1 });
  }
}

export async function playCm(name) {
  const file = mediaPath(name);
  if (!file) throw new Error('動画が見つかりません');
  await ensureCmInput();
  const o = await zoomObs();
  await o.call('SetInputSettings', { inputName: CM, inputSettings: { is_local_file: true, local_file: file, looping: false }, overlay: true });
  await setVisible(CM, true);
  await o.call('TriggerMediaInputAction', { inputName: CM, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
  cmPlaying = name;
  // CM 中は YouTube を止め、終わったら再開する
  if (getMediaSettings().pauseYouTubeOnCm && youTubeIsPlaying()) {
    ytPausedByCm = sendYouTube({ type: 'pause' });
  }
}

export async function stopCm() {
  if (!cmPlaying) return;
  cmPlaying = null;
  const o = await zoomObs();
  await setVisible(CM, false);
  await o.call('TriggerMediaInputAction', { inputName: CM, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => {});
  if (ytPausedByCm) {
    ytPausedByCm = false;
    sendYouTube({ type: 'play' });
  }
}

// ---------------------------------------------------------------- 背景（OBS で合成）
// アバター窓のグリーンバックを抜き、その下に背景（画像 or 動画）を敷く。離席画面・CM は一番上なので隠れない。
const FILL = { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_OUTER', boundsWidth: 1280, boundsHeight: 720, boundsAlignment: 0 };

async function ensureInputAtBottom(inputName, inputKind, inputSettings) {
  const o = await zoomObs();
  try {
    await o.call('GetInputSettings', { inputName });
  } catch {
    await o.call('CreateInput', { sceneName: SCENE, inputName, inputKind, sceneItemEnabled: false, inputSettings });
    await o.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: await itemId(inputName), sceneItemTransform: FILL });
  }
}

async function ensureBg() {
  const o = await zoomObs();
  await ensureInputAtBottom(BG, 'image_source', { file: BG_FILE });
  await ensureInputAtBottom(BG_VIDEO, 'ffmpeg_source', { is_local_file: true, looping: true, restart_on_activate: false, close_when_inactive: false, hw_decode: true });
  // 背景動画の音は出さない
  await o.call('SetInputMute', { inputName: BG_VIDEO, inputMuted: true });
  await o.call('SetInputAudioMonitorType', { inputName: BG_VIDEO, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  try {
    await o.call('GetSourceFilter', { sourceName: AVATAR, filterName: KEY_FILTER });
  } catch {
    await o.call('CreateSourceFilter', {
      sourceName: AVATAR, filterName: KEY_FILTER, filterKind: 'chroma_key_filter_v2',
      filterSettings: { key_color_type: 'green', similarity: 420, smoothness: 70, spill: 120 },
    });
  }
}

async function applyBg() {
  await ensureBg();
  const o = await zoomObs();
  const bg = getBgSettings();
  const on = Boolean(bg.current);
  const video = on && bg.type === 'video';
  if (on && !video) {
    // 同じパスのまま中身を差し替えたので、一度外して読み込み直させる
    await o.call('SetInputSettings', { inputName: BG, inputSettings: { file: '' }, overlay: true });
    await o.call('SetInputSettings', { inputName: BG, inputSettings: { file: BG_FILE }, overlay: true });
  }
  if (video) {
    await o.call('SetInputSettings', { inputName: BG_VIDEO, inputSettings: { is_local_file: true, local_file: bg.path, looping: true }, overlay: true });
  }
  // 背景はいつも一番下（実カメラはその上に全面で出す）
  for (const name of [BG_VIDEO, BG]) {
    await o.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: await itemId(name), sceneItemIndex: 0 });
  }
  await setVisible(BG, on && !video);
  await setVisible(BG_VIDEO, video);
  if (video) await o.call('TriggerMediaInputAction', { inputName: BG_VIDEO, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }).catch(() => {});
  await o.call('SetSourceFilterEnabled', { sourceName: AVATAR, filterName: KEY_FILTER, filterEnabled: on });
}

// ---------------------------------------------------------------- 効果音（OBS で鳴らして Zoom に届ける）
// 3 つの再生器を順番に使うので、続けて鳴らしても前の音が途切れない
const SE_POOL = ['効果音 1', '効果音 2', '効果音 3'];
let seNext = 0;
async function ensureSePool() {
  const o = await zoomObs();
  for (const inputName of SE_POOL) {
    try {
      await o.call('GetInputSettings', { inputName });
    } catch {
      await o.call('CreateInput', {
        sceneName: SCENE, inputName, inputKind: 'ffmpeg_source',
        inputSettings: { is_local_file: true, looping: false, restart_on_activate: false, close_when_inactive: false },
      });
      await o.call('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' });
      await o.call('SetInputVolume', { inputName, inputVolumeDb: getMediaSettings().seVolumeDb ?? -6 });
    }
  }
}
export async function playSe(rel) {
  const file = soundFile(rel);
  if (!file) throw new Error('効果音が見つかりません');
  await ensureSePool();
  const o = await zoomObs();
  const inputName = SE_POOL[seNext];
  seNext = (seNext + 1) % SE_POOL.length;
  await o.call('SetInputSettings', { inputName, inputSettings: { local_file: file }, overlay: true });
  await o.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' });
}
async function stopSe() {
  const o = await zoomObs();
  for (const inputName of SE_POOL) {
    await o.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 離席中
let brbOn = false;
let brbSince = 0;
let micBeforeBrb = null;

// ---------------------------------------------------------------- 表示（アバター／実写）
// 実写もアバター画面の中で描く（背景ありなら人物を切り抜く）。カメラはアバター画面だけが使い、OBS では開かない。
const VIEW_FILE = new URL('./view.json', import.meta.url);
const savedView = (() => { try { return JSON.parse(fs.readFileSync(VIEW_FILE, 'utf8')); } catch { return {}; } })();
let viewMode = savedView.view ?? 'avatar';
let pumpkins = Boolean(savedView.pumpkins); // アバターの周りにカボチャを浮かせる（VRM のときだけ）
function saveView() {
  try { fs.writeFileSync(VIEW_FILE, JSON.stringify({ view: viewMode, pumpkins })); } catch { /* 保存できなくても動く */ }
}

export function getView() {
  return { view: viewMode, cutout: Boolean(getBgSettings().current), pumpkins };
}
function notifyView() {
  sendToAvatar({ type: 'view', ...getView() });
}
async function setView(next) {
  viewMode = next === 'camera' ? 'camera' : 'avatar';
  saveView();
  await setVisible(AVATAR, true);
  notifyView();
}
// 以前の「実カメラ」ソース（OBS がカメラを開いたままになり重い）は削除する
async function removeOldRealCam() {
  const o = await zoomObs();
  await o.call('RemoveInput', { inputName: REAL_CAM }).catch(() => {});
}

async function setBrb(on, withCm = false) {
  const o = await zoomObs();
  const settings = getMediaSettings();
  const avatarOnline = avatarStatus.time && Date.now() - Date.parse(avatarStatus.time) < 5000;
  brbOn = on;
  if (on) brbSince = Date.now();
  if (on) {
    micBeforeBrb = (await o.call('GetInputMute', { inputName: MIC })).inputMuted;
    await setMuted(MIC, true);
    if (avatarOnline) {
      // かわいい離席画面はアバター画面側で描く（実写モード中でも離席中はアニメーション）
      await setVisible(AVATAR, true);
      sendToAvatar({ type: 'brb', on: true, message: settings.brbMessage });
    } else {
      for (const name of BRB_ITEMS) await setVisible(name, true);
    }
    // 「CM を流して離席」のときだけ、離席 CM を先に流す（終わると離席アニメーションが見える）
    if (withCm && settings.brbVideo && mediaPath(settings.brbVideo)) await playCm(settings.brbVideo);
  } else {
    await stopCm();
    sendToAvatar({ type: 'brb', on: false });
    for (const name of BRB_ITEMS) await setVisible(name, false);
    if (micBeforeBrb !== null) await setMuted(MIC, micBeforeBrb);
    micBeforeBrb = null;
  }
}

// ---------------------------------------------------------------- 状態

let lastSync = 0;
export async function getState() {
  const avatarAge = avatarStatus.time ? (Date.now() - Date.parse(avatarStatus.time)) / 1000 : Infinity;
  const avatar = {
    online: avatarAge < 5,
    hidden: Boolean(avatarStatus.hidden), // 窓が最小化されている（映像が止まる）
    tracking: avatarStatus.tracking ?? null,
    model: avatarStatus.model ?? null,
    expressions: avatarStatus.expressions ?? [],
    expression: avatarStatus.expression ?? -1,
  };
  try {
    const o = await zoomObs();
    const music = await musicInputs();
    const musicMuted = await Promise.all(music.map((inputName) => o.call('GetInputMute', { inputName }).then((r) => r.inputMuted)));
    const musicVolume = music.length ? (await o.call('GetInputVolume', { inputName: music[0] })).inputVolumeDb : -8;
    const [mic, vcam] = await Promise.all([
      o.call('GetInputMute', { inputName: MIC }),
      o.call('GetVirtualCamStatus'),
    ]);
    // ミュートとモニター出力のずれを直す（漏れ防止）。5 秒に 1 回（ずれが無ければ OBS には問い合わせない）
    if (Date.now() - lastSync > 5000) {
      lastSync = Date.now();
      await syncMonitor(MIC, mic.inputMuted);
      await Promise.all(music.map((name, i) => syncMonitor(name, musicMuted[i])));
    }
    let cm = null;
    if (cmPlaying) {
      const ms = await o.call('GetMediaInputStatus', { inputName: CM }).catch(() => null);
      cm = { name: cmPlaying, position: (ms?.mediaCursor ?? 0) / 1000, duration: (ms?.mediaDuration ?? 0) / 1000 };
    }
    return {
      obs: true,
      mic: { muted: mic.inputMuted, levelDb: toDb(peaks[MIC] ?? 0) },
      music: {
        muted: musicMuted.length > 0 && musicMuted.every(Boolean),
        partial: musicMuted.some(Boolean) && !musicMuted.every(Boolean), // 一部のアプリだけミュート（その音は Zoom に届かない）
        mutedNames: music.filter((_, i) => musicMuted[i]),
        volumeDb: musicVolume,
        levelDb: toDb(Math.max(0, ...music.map((n) => peaks[n] ?? 0))),
      },
      vcam: vcam.outputActive,
      view: viewMode,
      pumpkins,
      bg: getBgSettings().current,
      bgType: getBgSettings().type,
      brb: brbOn,
      brbSec: brbOn ? Math.floor((Date.now() - brbSince) / 1000) : 0,
      brbCm: getMediaSettings().brbVideo,
      cm,
      avatar,
      youtube: youTubeState(),
    };
  } catch (e) {
    return { obs: false, obsOther: e.foreign ?? null, error: e.message, avatar, pumpkins, youtube: youTubeState() };
  }
}

// ---------------------------------------------------------------- 操作
// 付け直しはミュートを引き継ぐ。一部だけミュートのままだと「再接続」しても届かないので、全部オンにそろえる
// （全部ミュートは「Zoom へ音楽」を止めている状態なので、そのまま）
let refreshingMusic = null;
async function refreshMusic(o) {
  await recreateMusicInputs(o, SCENE);
  const names = await musicInputs();
  const muted = await Promise.all(names.map((inputName) => o.call('GetInputMute', { inputName }).then((r) => r.inputMuted)));
  if (muted.some(Boolean) && !muted.every(Boolean)) await Promise.all(names.map((inputName) => setMuted(inputName, false)));
}

export async function runAction(body) {
  // カボチャはアバター画面だけの演出なので、OBS が無くても切り替えられる
  if (body.action === 'pumpkin') {
    pumpkins = typeof body.on === 'boolean' ? body.on : !pumpkins;
    saveView();
    notifyView();
    return { ok: true, pumpkins };
  }
  const o = await zoomObs();
  switch (body.action) {
    case 'mic':
      await setMuted(MIC, !(await o.call('GetInputMute', { inputName: MIC })).inputMuted);
      break;
    case 'music': {
      const names = await musicInputs();
      const muted = await Promise.all(names.map((inputName) => o.call('GetInputMute', { inputName }).then((r) => r.inputMuted)));
      // on の指定があればそのとおり。無ければ切り替え：全部オンなら全部ミュート、一部でもミュートなら全部オンにそろえる
      const next = typeof body.on === 'boolean' ? !body.on : !muted.some(Boolean);
      await Promise.all(names.map((inputName) => setMuted(inputName, next)));
      break;
    }
    case 'musicVolume': {
      const db = Math.max(-40, Math.min(0, Number(body.db)));
      await Promise.all((await musicInputs()).map((inputName) => o.call('SetInputVolume', { inputName, inputVolumeDb: db })));
      break;
    }
    case 'view':
      await setView(body.view);
      break;
    case 'brb': // 離席中のときに押すと、どちらのボタンでも「戻る」
      await setBrb(brbOn ? false : (body.on ?? true), Boolean(body.withCm));
      break;
    case 'bg': // 背景を選ぶ（null で背景なし＝グリーンバックのまま）
      await setBackground(body.id || null);
      await applyBg();
      notifyView(); // 実写モードの切り抜きのオン・オフも変わる
      break;
    case 'bgRemove': // 背景を一覧から消す（使用中なら背景なしに）
      if (removeBackground(String(body.id))) {
        await setBackground(null);
        await applyBg();
        notifyView();
      }
      break;
    case 'bgShowHidden':
      showHiddenBackgrounds();
      break;
    case 'sePlay':
      await playSe(String(body.path));
      break;
    case 'seStop':
      await stopSe();
      break;
    case 'seVolume': {
      const db = Math.max(-40, Math.min(0, Number(body.db)));
      setMediaSettings({ seVolumeDb: db });
      await ensureSePool();
      for (const inputName of SE_POOL) await o.call('SetInputVolume', { inputName, inputVolumeDb: db });
      break;
    }
    case 'cmPlay':
      await playCm(String(body.name));
      break;
    case 'cmStop':
      await stopCm();
      break;
    case 'vcam':
      await o.call('ToggleVirtualCam');
      break;
    case 'shutdown': // 「すべて終了」：離席・CM・仮想カメラを止めてから終了処理へ
      if (brbOn) await setBrb(false);
      await stopCm();
      if ((await o.call('GetVirtualCamStatus')).outputActive) await o.call('StopVirtualCam');
      break;
    case 'refreshMusic':
      // OBS のアプリ音声取り込みを、今起動しているアプリに付け直す（obs/music.mjs）。続けて押しても 1 回にまとめる
      refreshingMusic ??= refreshMusic(o).finally(() => { refreshingMusic = null; });
      await refreshingMusic;
      break;
    case 'yt':
      if (!sendYouTube({ type: body.command, delta: body.delta })) throw new Error('YouTube のタブが見つかりません（拡張機能を確認）');
      return { ok: true };
    case 'expression':
      return { delivered: sendToAvatar({ type: 'expression', index: Number(body.index) }) };
    case 'model':
      return { delivered: sendToAvatar({ type: 'model', url: String(body.url) }) };
    default:
      throw new Error(`不明な操作: ${body.action}`);
  }
  return { ok: true };
}
