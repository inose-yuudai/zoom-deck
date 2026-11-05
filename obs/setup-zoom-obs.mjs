// OBS に「Zoom 用」のプロファイルとシーンコレクションを作る（何度実行しても同じ結果になる）
//
//   マイク ─ RNNoise ノイズ除去 ─ ノイズゲート ─┐
//   音楽アプリの音（Music / Chrome / Spotify）──┴─ モニター出力 → BlackHole 2ch → Zoom のマイク
//   Avatar Cam のウィンドウ ─ OBS 仮想カメラ → Zoom のカメラ
//
// 使い方: OBS を起動した状態で  node setup-zoom-obs.mjs
//   --only-if-zoom  OBS が Zoom 用のシーンコレクションのときだけ設定する（別の用途で使用中なら何も変えない）
import { connect } from './obs-ws.mjs';

const PROFILE = 'Zoom';
const COLLECTION = 'Zoom（音楽+アバター）';
const SCENE = 'Zoom';
const REAL_CAM = '実カメラ';
const BRB_BG = '離席中（背景）';
const BRB_TEXT = '離席中（文字）';
const MIC = 'マイク（ノイズ除去）';
const AVATAR = 'アバター（Avatar Cam ウィンドウ）';
const MUSIC_APPS = [
  ['音楽: ミュージック', 'com.apple.Music'],
  ['音楽: Chrome', 'com.google.Chrome'],
  ['音楽: Safari', 'com.apple.Safari'],
  ['音楽: Spotify', 'com.spotify.client'],
];
const MUSIC_DB = -8; // 声より少し小さめ
const MONITOR_DEVICE_NAME = /BlackHole 2ch/i;
const MIC_EXCLUDE = /BlackHole|Zoom|Parrot|VB-?Cable|Virtual|仮想|Loopback|Teams|Aggregate|機器セット/i;

const obs = await connect();
const log = (...a) => console.log('・', ...a);

if (process.argv.includes('--only-if-zoom')) {
  const { currentSceneCollectionName } = await obs.call('GetSceneCollectionList');
  if (currentSceneCollectionName !== COLLECTION) {
    console.log(`OBS は別の用途（${currentSceneCollectionName}）で使用中なので、設定を変えずに終わります`);
    obs.close();
    process.exit(0);
  }
}

async function exists(fn) {
  try { await fn(); return true; } catch { return false; }
}

// ---- プロファイル（出力解像度・モニター出力先）
const { profiles } = await obs.call('GetProfileList');
if (!profiles.includes(PROFILE)) {
  await obs.call('CreateProfile', { profileName: PROFILE });
  log(`プロファイル「${PROFILE}」を作成`);
} else {
  await obs.call('SetCurrentProfile', { profileName: PROFILE });
}
// 仮想カメラ等の出力中は解像度を変えられないので、その場合はそのまま
await obs.call('SetVideoSettings', {
  baseWidth: 1280, baseHeight: 720, outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1,
}).catch(() => {});

// ---- シーンコレクション
const { sceneCollections } = await obs.call('GetSceneCollectionList');
if (!sceneCollections.includes(COLLECTION)) {
  await obs.call('CreateSceneCollection', { sceneCollectionName: COLLECTION });
  log(`シーンコレクション「${COLLECTION}」を作成`);
} else {
  await obs.call('SetCurrentSceneCollection', { sceneCollectionName: COLLECTION });
}
await new Promise((r) => setTimeout(r, 1500));

const { scenes } = await obs.call('GetSceneList');
if (!scenes.some((s) => s.sceneName === SCENE)) {
  if (scenes.length === 1) await obs.call('SetSceneName', { sceneName: scenes[0].sceneName, newSceneName: SCENE });
  else await obs.call('CreateScene', { sceneName: SCENE });
}
await obs.call('SetCurrentProgramScene', { sceneName: SCENE });

// 既にあれば設定を重ねて true を返さない（keep: true なら既存の設定に触らない）。作ったときは true
async function ensureInput(inputName, inputKind, inputSettings, sceneItemEnabled = true, { keep = false } = {}) {
  if (await exists(() => obs.call('GetInputSettings', { inputName }))) {
    if (!keep) await obs.call('SetInputSettings', { inputName, inputSettings, overlay: true });
    return false;
  } else {
    await obs.call('CreateInput', { sceneName: SCENE, inputName, inputKind, inputSettings, sceneItemEnabled });
    log(`ソース「${inputName}」を作成`);
    return true;
  }
}
const RELINK = process.argv.includes('--relink');
const settingsOf = async (inputName) => (await obs.call('GetInputSettings', { inputName })).inputSettings;

async function ensureFilter(sourceName, filterName, filterKind, filterSettings) {
  if (await exists(() => obs.call('GetSourceFilter', { sourceName, filterName }))) {
    await obs.call('SetSourceFilterSettings', { sourceName, filterName, filterSettings, overlay: true });
  } else {
    await obs.call('CreateSourceFilter', { sourceName, filterName, filterKind, filterSettings });
    log(`フィルタ「${filterName}」を追加`);
  }
}

// ---- 不要な既定の音声（デスクトップ音声 / 既定マイク）は無効化：Zoom の音が戻ってこないように
const special = await obs.call('GetSpecialInputs');
for (const name of Object.values(special)) {
  if (name) await obs.call('SetInputMute', { inputName: name, inputMuted: true }).catch(() => {});
}

// ---- マイク（実マイクを明示指定。BlackHole などの仮想デバイスは除外）
await ensureInput(MIC, 'coreaudio_input_capture', { device_id: 'default' }, true, { keep: true });
const micSet = (await settingsOf(MIC)).device_id;
if (!micSet || micSet === 'default') {
const micItems = (await obs.call('GetInputPropertiesListPropertyItems', { inputName: MIC, propertyName: 'device_id' })).propertyItems;
const realMics = micItems.filter((i) => i.itemValue !== 'default' && !MIC_EXCLUDE.test(i.itemName));
const mic = realMics.find((i) => /MacBook|内蔵|Built-?in/i.test(i.itemName)) ?? realMics[0];
if (mic) {
  await obs.call('SetInputSettings', { inputName: MIC, inputSettings: { device_id: mic.itemValue }, overlay: true });
  log(`マイク: ${mic.itemName}`);
}
} else {
  log('マイク: 設定済み');
}
await ensureFilter(MIC, 'ノイズ除去（RNNoise）', 'noise_suppress_filter_v2', { method: 'rnnoise' });
await ensureFilter(MIC, 'ノイズゲート', 'noise_gate_filter', {
  open_threshold: -40, close_threshold: -50, attack_time: 10, hold_time: 250, release_time: 150,
});
await obs.call('SetInputAudioMonitorType', { inputName: MIC, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' });

// ---- 音楽アプリの音（アプリ単位で取るので Zoom の相手の声は混ざらない）
for (const [name, bundle] of MUSIC_APPS) {
  await ensureInput(name, 'sck_audio_capture', { type: 1, application: bundle });
  await obs.call('SetInputAudioMonitorType', { inputName: name, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' });
  await obs.call('SetInputVolume', { inputName: name, inputVolumeDb: MUSIC_DB });
}
log(`音楽ソース: ${MUSIC_APPS.map((a) => a[0]).join(' / ')}（${MUSIC_DB} dB）`);

// ---- モニター出力先を BlackHole 2ch に（反映は OBS 再起動後）
let needsRestart = false;
const curName = (await obs.call('GetProfileParameter', { parameterCategory: 'Audio', parameterName: 'MonitoringDeviceName' })).parameterValue;
if (curName && MONITOR_DEVICE_NAME.test(curName)) {
  log(`モニター出力先: ${curName}`);
} else {
  await ensureInput('__tmp_out', 'coreaudio_output_capture', {});
  const outItems = (await obs.call('GetInputPropertiesListPropertyItems', { inputName: '__tmp_out', propertyName: 'device_id' })).propertyItems;
  await obs.call('RemoveInput', { inputName: '__tmp_out' });
  const bh = outItems.find((i) => MONITOR_DEVICE_NAME.test(i.itemName));
  if (!bh) throw new Error('BlackHole 2ch が見つかりません。brew install blackhole-2ch で入れてください');
  await obs.call('SetProfileParameter', { parameterCategory: 'Audio', parameterName: 'MonitoringDeviceName', parameterValue: bh.itemName });
  await obs.call('SetProfileParameter', { parameterCategory: 'Audio', parameterName: 'MonitoringDeviceId', parameterValue: bh.itemValue });
  needsRestart = true;
  log(`モニター出力先: ${bh.itemName}（OBS 再起動で反映）`);
}

// ---- アバター（Avatar Cam のウィンドウをキャプチャ）
await ensureInput(AVATAR, 'screen_capture', { type: 1, show_cursor: false, show_hidden_windows: true }, true, { keep: true });
const avItem = (await obs.call('GetSceneItemId', { sceneName: SCENE, sourceName: AVATAR })).sceneItemId;
const avNow = (await obs.call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: avItem })).sceneItemTransform;
const avLinked = !RELINK && (await settingsOf(AVATAR)).window && avNow.sourceWidth > 0;
const winItems = avLinked ? [] : (await obs.call('GetInputPropertiesListPropertyItems', { inputName: AVATAR, propertyName: 'window' })).propertyItems;
// Chrome for Testing（アバター専用ブラウザ）の窓を優先。同じ名前の窓が複数あるときは、いちばん新しい窓（窓の番号が大きい方）。
// 開き直したあと、閉じた古い窓が見えない形でしばらく残り、一覧に並ぶことがあるため
const newest = (list) => list.reduce((a, b) => (Number(b.itemValue) > Number(a?.itemValue ?? -1) ? b : a), null);
const candidates = winItems.filter((i) => /Avatar Cam/.test(i.itemName));
const win = newest(candidates.filter((i) => /for Testing/.test(i.itemName))) ?? newest(candidates);
if (avLinked) {
  log('アバター: 取り込み済み');
} else if (win) {
  await obs.call('SetInputSettings', { inputName: AVATAR, inputSettings: { type: 1, window: win.itemValue, show_cursor: false, show_hidden_windows: true }, overlay: true });
  log(`アバター: ウィンドウ「${win.itemName}」をキャプチャ`);
  await new Promise((r) => setTimeout(r, 1500));
  const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: SCENE, sourceName: AVATAR });
  const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId });
  // ウィンドウのタイトルバー分を上から切り落とし、16:9 で画面いっぱいに
  const cropTop = t.sourceWidth && t.sourceHeight > (t.sourceWidth * 9) / 16 ? Math.round(t.sourceHeight - (t.sourceWidth * 9) / 16) : 0;
  await obs.call('SetSceneItemTransform', {
    sceneName: SCENE, sceneItemId,
    sceneItemTransform: {
      cropTop, positionX: 0, positionY: 0, alignment: 5,
      boundsType: 'OBS_BOUNDS_SCALE_OUTER', boundsWidth: 1280, boundsHeight: 720, boundsAlignment: 0,
    },
  });
} else {
  log('アバター: Avatar Cam のウィンドウが見つからないため後で選択してください（start-avatar.command で起動してから再実行でも OK）');
}

// ---- ボタン盤（Deck）用：実カメラと「離席中」画面（最初は非表示）
// 実カメラは OBS では開かない（アバター画面が実写モードで描く）。古い「実カメラ」ソースがあれば削除
await obs.call('RemoveInput', { inputName: REAL_CAM }).catch(() => {});
await ensureInput(BRB_BG, 'color_source_v3', { color: 0xff3a2f2a, width: 1280, height: 720 }, false);
await ensureInput(BRB_TEXT, 'text_ft2_source_v2', {
  text: 'ただいま離席中です', font: { face: 'Hiragino Sans', size: 72, style: 'W6', flags: 0 }, color1: 0xffffffff, color2: 0xffffffff,
}, false);

const itemId = async (sourceName) => (await obs.call('GetSceneItemId', { sceneName: SCENE, sourceName })).sceneItemId;
const fill = { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_OUTER', boundsWidth: 1280, boundsHeight: 720, boundsAlignment: 0 };
await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: await itemId(BRB_BG), sceneItemTransform: fill });
await obs.call('SetSceneItemTransform', {
  sceneName: SCENE, sceneItemId: await itemId(BRB_TEXT),
  sceneItemTransform: { positionX: 640, positionY: 360, alignment: 0, boundsType: 'OBS_BOUNDS_NONE' },
});
// 重なり順：実カメラ（一番下）→ アバター → 離席中（一番上）
const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: SCENE });
const top = sceneItems.length - 1;
// 背景（Deck で選ぶ）は実カメラよりさらに下
if (await exists(() => obs.call('GetInputSettings', { inputName: '背景（画像）' }))) {
  await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: await itemId('背景（画像）'), sceneItemIndex: 0 });
}
await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: await itemId(BRB_BG), sceneItemIndex: top });
await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: await itemId(BRB_TEXT), sceneItemIndex: top });
// CM（動画）は Deck が初回再生時に作る。あれば一番上に
if (await exists(() => obs.call('GetInputSettings', { inputName: 'CM（動画）' }))) {
  await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: await itemId('CM（動画）'), sceneItemIndex: top });
}

console.log(`\n完了${needsRestart ? '。モニター出力先を反映するため OBS を再起動してください' : ''}`);
obs.close();
