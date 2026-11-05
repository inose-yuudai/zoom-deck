// Avatar Cam: Web カメラの顔トラッキングで VRM（3D）/ Live2D を動かす
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { FaceLandmarker, FilesetResolver, ImageSegmenter } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
// 実写モードの人物切り抜き（横長のカメラ向けの軽いモデル）
const SEG_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';
// 負荷を抑える：描画は OBS と同じ 30fps、顔の検出は 20fps まで
const RENDER_FPS = 30;
const DETECT_FPS = 20;

const FALLBACK_MODELS = [
  { name: 'サンプル: VRM1 Twist（pixiv）', type: 'vrm', url: 'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm' },
];

const BG_COLORS = { green: '#00ff00', blue: '#0047bb', white: '#ffffff', gray: '#808080' };
const VIEW_DEFAULTS = { vrm: { zoom: 1, x: 0, y: 0 }, live2d: { zoom: 2.4, x: 0, y: 0 } };
const VRM_EXPRESSIONS = ['happy', 'angry', 'sad', 'surprised', 'relaxed'];
// パーフェクトシンク（ARKit の 52 表情）。MediaPipe の顔ブレンドシェイプも同じ名前で出てくる
const ARKIT_52 = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthPressLeft', 'mouthPressRight',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];
// まばたき・口の開閉は速く追う（ほかは設定の「なめらかさ」どおり）
const PS_FAST = /^(eyeBlink|jawOpen|mouthClose|mouthFunnel|mouthPucker)/;
// 無表情でも MediaPipe が少し値を出しがちな形。その人の無表情の値を少しずつ覚えて差し引く
const PS_NOISY = /^(eyeSquint|mouthShrug|mouthPress|mouthRoll|mouthDimple|mouthStretch|mouthFrown|mouthUpperUp|mouthLowerDown|mouthClose|browDown|cheekSquint|noseSneer)/;

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const remap = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------- 設定
const settings = {
  model: '', camera: '', bg: 'green', bgColor: '#2b2f3a',
  smooth: 0.35, mouth: 1, mirror: false, showPreview: false,
  invYaw: false, invPitch: false, invRoll: false, invEyes: false,
  view: structuredClone(VIEW_DEFAULTS),
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('avatar-cam') || '{}'));
} catch { /* 保存なしでも動く */ }
function save() {
  try { localStorage.setItem('avatar-cam', JSON.stringify(settings)); } catch { /* 無視 */ }
}

const params = new URLSearchParams(location.search);
if (params.has('clean')) document.body.classList.add('clean');
// アプリ窓として開かれたか（start-avatar.command が ?win=app を付ける）。アプリ窓は 1 つだけ残す
const APP_WIN = params.get('win') === 'app';
const BORN = Math.round(performance.timeOrigin);

// 窓の大きさ・位置を覚えておき、開き直したときに戻す（アプリ窓のときだけ。
// 同じブラウザで開くと先に開いた窓の大きさが使われてしまうため、ページ側で直す）
function keepWindowBounds(key, defW, defH) {
  try {
    const b = JSON.parse(localStorage.getItem(key) || 'null');
    if (b && b.w > 200 && b.h > 150) { window.resizeTo(b.w, b.h); window.moveTo(b.x, b.y); }
    else window.resizeTo(defW, defH);
  } catch { /* 無視 */ }
  let last = '';
  setInterval(() => {
    if (document.hidden) return;
    const now = JSON.stringify({ x: screenX, y: screenY, w: outerWidth, h: outerHeight });
    if (now !== last) { last = now; try { localStorage.setItem(key, now); } catch { /* 無視 */ } }
  }, 2000);
}
if (APP_WIN) keepWindowBounds('avatar-window', 640, 388);

// OBS はこの窓を 16:9 として取り込み、はみ出た上の分（タイトルバー）を切り落とす。
// 窓の形が変わったら、幅はそのままで中身が 16:9 になる高さに戻す（横長のままだとタイトルバーが映る）
function keepAspect169() {
  const fix = () => {
    const chrome = window.outerHeight - window.innerHeight;
    const want = Math.round((window.innerWidth * 9) / 16);
    if (chrome >= 0 && Math.abs(window.innerHeight - want) > 2) window.resizeTo(window.outerWidth, want + chrome);
  };
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(fix, 500); });
  setTimeout(fix, 300); // 前回の大きさに戻したあとで
}
if (APP_WIN) keepAspect169();

// 新しい窓に置き換わったので閉じる（閉じられないときはカメラ・描画を止めた空のページに移る）
function closeSelf() {
  window.close();
  setTimeout(() => location.replace('/closed.html'), 400);
}

function status(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

// ---------------------------------------------------------------- 離席中モード
const brb = { on: false, since: 0 };
const FLOATIES = ['♡', '☆', '♪', '✿', '☁', '♡', '✦', '♪'];

function setupBrbOnce() {
  if (setupBrbOnce.done) return;
  setupBrbOnce.done = true;
  const back = $('brbBack');
  for (let i = 0; i < 22; i++) {
    const el = document.createElement('span');
    el.className = 'floaty';
    el.textContent = FLOATIES[i % FLOATIES.length];
    el.style.left = `${Math.random() * 100}vw`;
    el.style.fontSize = `${18 + Math.random() * 26}px`;
    el.style.color = ['#ff9cc2', '#a5c8ff', '#c3a9ff', '#ffd27a'][i % 4];
    el.style.animationDuration = `${9 + Math.random() * 9}s`;
    el.style.animationDelay = `${-Math.random() * 16}s`;
    back.append(el);
  }
}

function setBrb(on, message) {
  setupBrbOnce();
  brb.on = on;
  if (on) brb.since = Date.now();
  document.body.classList.toggle('brb', on);
  const title = $('brbTitle');
  title.innerHTML = '';
  [...'ただいま離席中'].forEach((ch, i) => {
    const sp = document.createElement('span');
    sp.textContent = ch;
    sp.style.animationDelay = `${i * 0.12}s`;
    title.append(sp);
  });
  if (message) $('brbMsg').textContent = message;
  applyViewVisibility();
  if (on && mode === 'vrm' && vrm?.expressionManager?.getExpression('relaxed')) vrmExpr = 'relaxed';
  if (!on && vrmExpr === 'relaxed') vrmExpr = null;
}

function updateBrbTimer() {
  if (!brb.on) return;
  const t = Math.floor((Date.now() - brb.since) / 1000);
  $('brbTime').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- 顔の状態（平滑化済み）
const face = {
  yaw: 0, pitch: 0, roll: 0,
  blinkL: 0, blinkR: 0, jaw: 0, smile: 0, pucker: 0, funnel: 0,
  lookX: 0, lookY: 0, brow: 0, bodyX: 0, bodyY: 0,
};
const target = { ...face };
// パーフェクトシンク用：ARKit 名 → このモデルの表情名（52 表情を持たないモデルは null）
let psMap = null;
const psTarget = {};
const psFace = {};
const psBase = {}; // 無表情のときの値（PS_NOISY の形だけ）
let psEyeLook = false; // 目の向きも 52 表情で動かすか
let lastSeen = -Infinity;
let tracking = { fps: 0, frames: 0, t0: performance.now() };

// 顔が見えない間の自動まばたき
const autoBlink = { next: 2, t: -1 };
function autoBlinkValue(time) {
  if (autoBlink.t < 0 && time > autoBlink.next) autoBlink.t = time;
  if (autoBlink.t >= 0) {
    const p = (time - autoBlink.t) / 0.16;
    if (p >= 1) {
      autoBlink.t = -1;
      autoBlink.next = time + 2 + Math.random() * 4;
      return 0;
    }
    return Math.sin(p * Math.PI);
  }
  return 0;
}

// ---------------------------------------------------------------- MediaPipe 顔トラッキング
const video = $('preview');
let landmarker = null;
let stream = null;
let lastVideoTime = -1;
const tmpMat = new THREE.Matrix4();
const tmpEuler = new THREE.Euler();

async function initLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MP_MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

async function listCameras() {
  const sel = $('camera');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  sel.innerHTML = '';
  for (const d of devices) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `カメラ ${sel.length + 1}`;
    sel.append(o);
  }
  // 仮想カメラ（OBS 等）を自分で読むと映像がループするので、実カメラを優先
  const isVirtual = (d) => /virtual|obs|仮想/i.test(d.label);
  const saved = devices.find((d) => d.deviceId === settings.camera);
  const pick = saved || devices.find((d) => !isVirtual(d)) || devices[0];
  if (pick) sel.value = pick.deviceId;
  return pick?.deviceId;
}

async function startCamera(deviceId) {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: 640, height: 480, frameRate: 30 },
  });
  video.srcObject = stream;
  await video.play();
  // カメラが途切れたら（ほかのアプリ・機器の抜き差しなど）自動でつなぎ直す
  for (const t of stream.getVideoTracks()) {
    t.onended = () => scheduleCameraRestart('カメラが途切れました');
    t.onmute = () => scheduleCameraRestart('カメラの映像が止まりました', 3000);
    t.onunmute = () => clearTimeout(restartTimer);
  }
}

// ---------------------------------------------------------------- カメラの見張り
// ディスプレイの抜き差し等で、カメラが「動いているのに真っ暗」になることがある。
// 真っ暗が続いたり、映像が届かなくなったりしたらカメラを開き直す。
let restartTimer = 0;
let lastRestart = 0;
let darkCount = 0;
function scheduleCameraRestart(reason, delay = 800) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (testCanvas || Date.now() - lastRestart < 10000) return;
    lastRestart = Date.now();
    console.warn('カメラを開き直します:', reason);
    try {
      const id = stream?.getVideoTracks()[0]?.getSettings().deviceId || settings.camera || undefined;
      try { await startCamera(id); } catch { await startCamera(undefined); }
      darkCount = 0;
    } catch (e) {
      status(`カメラを開けません: ${e.message}`, true);
    }
  }, delay);
}
setInterval(() => {
  if (testCanvas || !stream || document.hidden) return;
  const live = stream.getVideoTracks().some((t) => t.readyState === 'live');
  if (!live) { scheduleCameraRestart('カメラが止まっています'); return; }
  const luma = videoLuma();
  // 真っ暗（明るさ 0〜1）が 6 秒続いたら開き直す。暗い部屋でも 0 にはならないので誤作動しにくい
  darkCount = luma !== null && luma <= 1 ? darkCount + 1 : 0;
  if (darkCount >= 3) { darkCount = 0; scheduleCameraRestart('カメラの映像が真っ暗です', 0); }
}, 2000);
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  const live = stream?.getVideoTracks().some((t) => t.readyState === 'live');
  if (!live) scheduleCameraRestart('カメラの接続が変わりました');
});

function blendshapeMap(result) {
  const out = {};
  for (const c of result.faceBlendshapes?.[0]?.categories ?? []) out[c.categoryName] = c.score;
  return out;
}

// ---------------------------------------------------------------- パーフェクトシンク
// モデルが ARKit の 52 表情（jawOpen など。先頭が大文字の名前でもよい）を持っていれば、その名前の対応表を返す
function perfectSyncMap(em) {
  if (!em) return null;
  const map = {};
  for (const n of ARKIT_52) {
    const name = [n, n[0].toUpperCase() + n.slice(1)].find((x) => em.getExpression(x));
    if (name) map[n] = name;
  }
  return Object.keys(map).length >= 40 ? map : null;
}

const swapSide = (n) => n.replace(/Left$|Right$/, (s) => (s === 'Left' ? 'Right' : 'Left'));
const swapInOut = (n) => n.replace(/In|Out/, (s) => (s === 'In' ? 'Out' : 'In'));

// MediaPipe の値は ARKit より控えめなので、形ごとに 0〜1 へ広げる
function psGain(n, v) {
  if (n.startsWith('eyeBlink')) return remap(v, 0.25, 0.65);
  if (n === 'jawOpen') return clamp(remap(v, 0.04, 0.45) * settings.mouth, 0, 1);
  if (n.startsWith('mouthSmile')) return remap(v, 0.1, 0.7);
  if (n === 'mouthPucker') return remap(v, 0.2, 0.8);
  if (n === 'mouthFunnel') return remap(v, 0.1, 0.5);
  if (n.startsWith('eyeWide')) return remap(v, 0.05, 0.5);
  if (n.startsWith('eyeSquint')) return remap(v, 0.1, 0.8);
  return remap(v, 0.05, 0.7);
}

// 顔の検出結果 → 52 表情の目標値（鏡像・左右反転の設定は今までの目・顔の向きと同じ扱い）
function setPerfectSyncTarget(bs) {
  for (const n of ARKIT_52) {
    let src = n;
    if (settings.mirror) src = swapSide(src);
    if (settings.invEyes && /^eye(Blink|Squint|Wide)/.test(n)) src = swapSide(src);
    if (settings.invYaw && /^eyeLook(In|Out)/.test(n)) src = swapInOut(src);
    let v = bs[src] ?? 0;
    if (PS_NOISY.test(n)) {
      // 下がるときはすぐ、上がるときはゆっくり（約 0.01/秒）追って、無表情の値とみなす
      const b = psBase[n] ?? v;
      psBase[n] = Math.min(0.5, v < b ? lerp(b, v, 0.2) : b + 0.0005);
      v = Math.max(0, v - psBase[n]);
    }
    psTarget[n] = psGain(n, v);
  }
}

// 離席中・顔が見えないとき：まばたきと笑顔だけ、ほかの形は 0
function setPerfectSyncIdle() {
  for (const n of ARKIT_52) psTarget[n] = 0;
  psTarget.eyeBlinkLeft = target.blinkL;
  psTarget.eyeBlinkRight = target.blinkR;
  psTarget.mouthSmileLeft = psTarget.mouthSmileRight = target.smile * 0.5;
}

// 動作確認用: ?test=1 でカメラの代わりに顔写真を傾けて入力する
let testCanvas = null;
let testRoll = 0;
function initTestSource() {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg';
  testCanvas = document.createElement('canvas');
  testCanvas.width = 640;
  testCanvas.height = 480;
  const ctx = testCanvas.getContext('2d');
  testCanvas.draw = (time) => {
    if (!img.complete || !img.naturalWidth) return false;
    testRoll = Math.sin(time * 0.8) * 0.35; // 画像の回転（時計回りが正）
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 640, 480);
    ctx.save();
    ctx.translate(320, 240);
    ctx.rotate(testRoll);
    const s = 480 / img.naturalHeight;
    ctx.drawImage(img, (-img.naturalWidth * s) / 2, -240, img.naturalWidth * s, 480);
    ctx.restore();
    return true;
  };
}

let lastDetect = 0;
function detect(now) {
  if (!landmarker) return;
  if (now - lastDetect < 1000 / DETECT_FPS) return;
  lastDetect = now;
  let source = video;
  if (testCanvas) {
    if (!testCanvas.draw(now / 1000)) return;
    source = testCanvas;
  } else {
    if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
    lastVideoTime = video.currentTime;
  }
  const res = landmarker.detectForVideo(source, now);
  tracking.frames++;
  const m = res.facialTransformationMatrixes?.[0];
  if (!m) return;

  lastSeen = now;
  tmpMat.fromArray(m.data);
  tmpEuler.setFromRotationMatrix(tmpMat, 'YXZ');
  const bs = blendshapeMap(res);
  const g = (k) => bs[k] ?? 0;

  let yaw = tmpEuler.y, pitch = tmpEuler.x, roll = tmpEuler.z;
  let blinkL = g('eyeBlinkLeft'), blinkR = g('eyeBlinkRight');
  let lookX = (g('eyeLookOutLeft') + g('eyeLookInRight') - g('eyeLookInLeft') - g('eyeLookOutRight')) / 2;
  const lookY = (g('eyeLookUpLeft') + g('eyeLookUpRight') - g('eyeLookDownLeft') - g('eyeLookDownRight')) / 2;
  // 頭の位置（cm 単位の平行移動）で体を少し傾ける
  let bodyX = clamp(m.data[12] / 15, -1, 1);
  const bodyY = clamp(m.data[13] / 15, -1, 1);

  if (settings.mirror) { yaw = -yaw; roll = -roll; lookX = -lookX; bodyX = -bodyX; [blinkL, blinkR] = [blinkR, blinkL]; }
  if (settings.invYaw) { yaw = -yaw; lookX = -lookX; bodyX = -bodyX; }
  if (settings.invPitch) pitch = -pitch;
  if (settings.invRoll) roll = -roll;
  if (settings.invEyes) [blinkL, blinkR] = [blinkR, blinkL];

  // まばたきは片目ずつ取りにくいので、差が小さいときは両目を揃える
  const avg = (blinkL + blinkR) / 2;
  if (Math.abs(blinkL - blinkR) < 0.25) blinkL = blinkR = avg;

  Object.assign(target, {
    yaw, pitch, roll, lookX, lookY, bodyX, bodyY,
    blinkL: remap(blinkL, 0.25, 0.65),
    blinkR: remap(blinkR, 0.25, 0.65),
    jaw: clamp(remap(g('jawOpen'), 0.04, 0.45) * settings.mouth, 0, 1),
    smile: remap((g('mouthSmileLeft') + g('mouthSmileRight')) / 2, 0.1, 0.7),
    pucker: remap(g('mouthPucker'), 0.2, 0.8),
    funnel: remap(g('mouthFunnel'), 0.1, 0.5),
    brow: clamp((g('browInnerUp') * 0.6 + (g('browOuterUpLeft') + g('browOuterUpRight')) * 0.4) * 2
      - (g('browDownLeft') + g('browDownRight')) * 1.2, -1, 1),
  });
  if (psMap) setPerfectSyncTarget(bs);
}

function updateFace(now, dt) {
  const time = now / 1000;
  const lost = now - lastSeen > 600;
  if (brb.on) {
    // 離席中：ゆっくり揺れて、目はほとんど閉じた状態
    Object.assign(target, {
      yaw: Math.sin(time * 0.6) * 0.12, pitch: 0.12 + Math.sin(time * 0.9) * 0.04, roll: Math.sin(time * 0.6) * 0.12,
      jaw: 0, smile: 0.35, pucker: 0, funnel: 0, lookX: 0, lookY: -0.3, brow: 0.1, bodyX: Math.sin(time * 0.6) * 0.3, bodyY: 0,
      blinkL: 0.85, blinkR: 0.85,
    });
  } else if (lost) {
    // 顔が外れたら正面に戻してゆっくり呼吸 + 自動まばたき
    Object.assign(target, {
      yaw: Math.sin(time * 0.5) * 0.04, pitch: Math.sin(time * 0.37) * 0.02, roll: 0,
      jaw: 0, smile: 0, pucker: 0, funnel: 0, lookX: 0, lookY: 0, brow: 0, bodyX: 0, bodyY: 0,
    });
    const b = autoBlinkValue(time);
    target.blinkL = target.blinkR = b;
  }
  const k = 1 - Math.pow(1 - settings.smooth, dt * 60);
  const kFast = 1 - Math.pow(1 - Math.min(1, settings.smooth * 1.8), dt * 60);
  for (const key of Object.keys(face)) {
    const fast = key.startsWith('blink') || key === 'jaw';
    face[key] = lerp(face[key], target[key], fast ? kFast : k);
  }
  if (psMap) {
    if (brb.on || lost) setPerfectSyncIdle();
    for (const n of ARKIT_52) psFace[n] = lerp(psFace[n] ?? 0, psTarget[n] ?? 0, PS_FAST.test(n) ? kFast : k);
  }
  return lost;
}

// ---------------------------------------------------------------- 3D（VRM）
const c3d = $('c3d');
const renderer = new THREE.WebGLRenderer({ canvas: c3d, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0);
const scene3 = new THREE.Scene();
const camera3 = new THREE.PerspectiveCamera(25, 1, 0.05, 50);
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(0.5, 1.5, 2);
scene3.add(light, new THREE.AmbientLight(0xffffff, 0.6));

let vrm = null;
let vrmFlip = 1; // VRM0 は正規化ボーンの X/Z 回転が逆向き
let headY = 1.4;
let vrmExpr = null;
let activeExpr = -1; // ボタン盤に知らせる現在の表情番号

function bone(name) {
  return vrm?.humanoid?.getNormalizedBoneNode(name) ?? null;
}

async function loadVRM(url) {
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(url, (e) => {
    if (e.total) status(`読み込み中… ${Math.round((e.loaded / e.total) * 100)}%`);
  });
  const next = gltf.userData.vrm;
  if (!next) throw new Error('VRM ではないファイルです');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  (VRMUtils.combineSkeletons || VRMUtils.removeUnnecessaryJoints)?.(gltf.scene);
  VRMUtils.rotateVRM0(next);
  next.scene.traverse((o) => { o.frustumCulled = false; });

  unloadAll();
  vrm = next;
  vrmFlip = vrm.meta?.metaVersion === '0' ? -1 : 1;
  scene3.add(vrm.scene);

  // T ポーズから腕を下ろす
  const arm = 1.2 * vrmFlip;
  bone('leftUpperArm')?.rotation.set(0, 0, -arm);
  bone('rightUpperArm')?.rotation.set(0, 0, arm);
  bone('leftLowerArm')?.rotation.set(0, 0, -0.15 * vrmFlip);
  bone('rightLowerArm')?.rotation.set(0, 0, 0.15 * vrmFlip);
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);
  const head = bone('head');
  headY = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4;

  if (vrm.lookAt) vrm.lookAt.target = undefined;
  psMap = perfectSyncMap(vrm.expressionManager);
  for (const o of [psTarget, psFace, psBase]) for (const n of Object.keys(o)) delete o[n];
  // 目の向き：視線が表情方式のモデルは 52 表情の eyeLook… で動かし、ボーン方式のモデルは今まで通り視線で動かす
  const applier = vrm.lookAt?.applier;
  psEyeLook = !!psMap && (applier?.constructor?.type === 'expression' || (!!applier && 'expressions' in applier));
  if (psMap) console.info(`パーフェクトシンク: ${Object.keys(psMap).length} 表情（目の向き: ${psEyeLook ? '52 表情' : '視線ボーン'}）`);
  setMode('vrm');
  buildExpressionButtons(VRM_EXPRESSIONS.filter((n) => vrm.expressionManager?.getExpression(n)));
}

function frameVRMCamera() {
  const v = brb.on ? { zoom: settings.view.vrm.zoom * 0.8, x: -0.42, y: settings.view.vrm.y - 0.05 } : settings.view.vrm;
  const dist = 1.6 / v.zoom;
  const ty = headY - 0.05 + v.y * 0.6;
  camera3.position.set(-v.x * 0.6, ty, dist);
  camera3.lookAt(-v.x * 0.6, ty, 0);
}

function applyVRM(dt, time) {
  const flip = vrmFlip;
  const { yaw, pitch, roll } = face;
  bone('head')?.rotation.set(pitch * 0.6 * flip, yaw * 0.6, roll * 0.6 * flip);
  bone('neck')?.rotation.set(pitch * 0.3 * flip, yaw * 0.3, roll * 0.3 * flip);
  const breath = Math.sin(time * 1.6) * 0.015;
  bone('spine')?.rotation.set((pitch * 0.1 + breath) * flip, yaw * 0.15 + face.bodyX * 0.1, (roll * 0.15 - face.bodyX * 0.05) * flip);
  bone('chest')?.rotation.set(breath * flip, 0, 0);

  const em = vrm.expressionManager;
  if (em && psMap) {
    // パーフェクトシンク：顔の細かい動きを 52 表情へそのまま流す。標準の口・まばたきは二重にならないよう 0
    for (const n of ARKIT_52) {
      if (!psMap[n]) continue;
      em.setValue(psMap[n], !psEyeLook && n.startsWith('eyeLook') ? 0 : psFace[n] ?? 0);
    }
    for (const n of ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh']) em.setValue(n, 0);
    for (const n of VRM_EXPRESSIONS) em.setValue(n, n === vrmExpr ? 1 : 0);
  } else if (em) {
    const happy = vrmExpr ? 0 : face.smile * 0.6;
    // 笑顔の表情で目が閉じるモデルが多いので、その分まばたきを弱める
    em.setValue('blinkLeft', clamp(face.blinkL - happy, 0, 1));
    em.setValue('blinkRight', clamp(face.blinkR - happy, 0, 1));
    em.setValue('aa', face.jaw);
    em.setValue('ou', clamp(Math.max(face.pucker, face.funnel) * face.jaw * 1.5, 0, 1));
    em.setValue('ih', clamp(face.smile * face.jaw, 0, 1));
    for (const n of VRM_EXPRESSIONS) em.setValue(n, n === vrmExpr ? 1 : 0);
    if (!vrmExpr) em.setValue('happy', happy);
  }
  if (vrm.lookAt) {
    vrm.lookAt.yaw = psEyeLook ? 0 : face.lookX * 25;
    vrm.lookAt.pitch = psEyeLook ? 0 : face.lookY * 15;
  }
  vrm.update(dt);
}

// ---------------------------------------------------------------- 2D（Live2D）
const c2d = $('c2d');
let pixiApp = null;
let l2d = null;
let l2dExpressions = [];

function ensurePixi() {
  if (pixiApp) return pixiApp;
  if (!window.PIXI?.live2d) throw new Error('Live2D ライブラリを読み込めませんでした（ネット接続を確認）');
  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
  pixiApp = new PIXI.Application({ view: c2d, resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: window.devicePixelRatio });
  return pixiApp;
}

async function loadLive2D(url) {
  const app = ensurePixi();
  const model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false });
  unloadAll();
  l2d = model;
  app.stage.addChild(model);
  model.anchor.set(0.5, 0);
  // まばたき・視線は自前で制御する
  model.internalModel.eyeBlink = undefined;
  model.internalModel.on('afterMotionUpdate', applyLive2D);

  const defs = model.internalModel.motionManager?.expressionManager?.definitions ?? [];
  l2dExpressions = defs.map((d) => d.Name ?? d.name);
  setMode('live2d');
  buildExpressionButtons(l2dExpressions);
}

function layoutLive2D() {
  if (!l2d) return;
  const v = brb.on ? { ...settings.view.live2d, zoom: settings.view.live2d.zoom * 0.8, x: -0.5 } : settings.view.live2d;
  const h = l2d.internalModel.originalHeight || l2d.internalModel.height;
  const s = (window.innerHeight / h) * v.zoom;
  l2d.scale.set(s);
  l2d.position.set(window.innerWidth * (0.5 + v.x * 0.5), window.innerHeight * (0.04 - v.y * 0.6) );
}

function applyLive2D() {
  const core = l2d?.internalModel?.coreModel;
  if (!core) return;
  const set = (id, v) => core.setParameterValueById(id, v);
  const ax = clamp(face.yaw * DEG * 1.2, -30, 30);
  const ay = clamp(-face.pitch * DEG * 1.2, -30, 30);
  const az = clamp(-face.roll * DEG, -30, 30);
  set('ParamAngleX', ax);
  set('ParamAngleY', ay);
  set('ParamAngleZ', az);
  set('ParamBodyAngleX', clamp(ax * 0.3 + face.bodyX * 6, -10, 10));
  set('ParamBodyAngleY', clamp(ay * 0.2, -10, 10));
  set('ParamBodyAngleZ', clamp(az * 0.3, -10, 10));
  set('ParamEyeLOpen', 1 - face.blinkL);
  set('ParamEyeROpen', 1 - face.blinkR);
  set('ParamEyeLSmile', face.smile * (1 - face.blinkL) * 0.6);
  set('ParamEyeRSmile', face.smile * (1 - face.blinkR) * 0.6);
  set('ParamEyeBallX', clamp(face.lookX * 1.5, -1, 1));
  set('ParamEyeBallY', clamp(face.lookY * 1.5, -1, 1));
  set('ParamBrowLY', face.brow);
  set('ParamBrowRY', face.brow);
  set('ParamMouthOpenY', face.jaw);
  set('ParamMouthForm', clamp(face.smile * 1.6 - face.pucker * 0.8 - 0.1, -1, 1));
}

// ---------------------------------------------------------------- モデル切り替え
let mode = 'vrm';
function setMode(next) {
  mode = next;
  applyViewVisibility();
  syncViewSliders();
}

function unloadAll() {
  if (vrm) {
    scene3.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
    vrm = null;
  }
  if (l2d) {
    pixiApp?.stage.removeChild(l2d);
    l2d.destroy();
    l2d = null;
  }
  vrmExpr = null;
  activeExpr = -1;
  psMap = null;
  psEyeLook = false;
}

let loadToken = 0;
async function loadModel(entry) {
  const token = ++loadToken;
  status(`「${entry.name}」を読み込み中…`);
  try {
    if (entry.type === 'live2d') await loadLive2D(entry.url);
    else await loadVRM(entry.url);
    if (token === loadToken) status(`「${entry.name}」を表示中`);
  } catch (e) {
    console.error(e);
    status(`読み込みに失敗しました: ${e.message || e}`, true);
  }
}

function buildExpressionButtons(names) {
  const box = $('expr');
  box.innerHTML = '';
  names.slice(0, 9).forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${i + 1} ${n}`;
    b.onclick = () => setExpression(i);
    box.append(b);
  });
  if (!names.length) box.textContent = '（このモデルには表情がありません）';
  else {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '0 解除';
    b.onclick = () => setExpression(-1);
    box.append(b);
  }
}

function expressionNames() {
  if (mode === 'vrm' && vrm) return VRM_EXPRESSIONS.filter((n) => vrm.expressionManager?.getExpression(n));
  if (l2d) return l2dExpressions.slice(0, 9);
  return [];
}

function setExpression(i) {
  activeExpr = i >= 0 && i < expressionNames().length ? i : -1;
  if (mode === 'vrm' && vrm) {
    const names = VRM_EXPRESSIONS.filter((n) => vrm.expressionManager?.getExpression(n));
    vrmExpr = i >= 0 ? names[i] ?? null : null;
  } else if (l2d) {
    const em = l2d.internalModel.motionManager?.expressionManager;
    if (i < 0) em?.resetExpression();
    else if (l2dExpressions[i]) l2d.expression(l2dExpressions[i]);
  }
}

// ---------------------------------------------------------------- 背景・UI
function applyBackground() {
  const img = $('bgimg');
  img.style.display = settings.bg === 'image' && img.src ? 'block' : 'none';
  const color = settings.bg === 'custom' ? settings.bgColor
    : settings.bg === 'transparent' || settings.bg === 'image' ? 'transparent'
    : BG_COLORS[settings.bg];
  document.documentElement.style.setProperty('--bg', color);
  $('bgColor').style.visibility = settings.bg === 'custom' ? 'visible' : 'hidden';
}

function syncViewSliders() {
  const v = settings.view[mode];
  $('zoom').value = v.zoom;
  $('offX').value = v.x;
  $('offY').value = v.y;
}

// 選んでいるモデルの顔の画像（サーバーが models.json の preview か VRM のサムネイルを配る）
function showModelPreview(m) {
  const img = $('modelPreview');
  if (!img) return;
  img.hidden = !m?.preview;
  if (m?.preview) img.src = m.preview;
  else img.removeAttribute('src');
}

function bindUI(models) {
  const sel = $('model');
  models.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${m.type === 'live2d' ? '[2D] ' : '[3D] '}${m.name}`;
    sel.append(o);
  });
  sel.onchange = () => {
    const m = models[Number(sel.value)];
    settings.model = m.url;
    save();
    showModelPreview(m);
    loadModel(m);
  };

  $('camera').onchange = async (e) => {
    settings.camera = e.target.value;
    save();
    try { await startCamera(settings.camera); } catch (err) { status(`カメラを開けません: ${err.message}`, true); }
  };

  $('bg').value = settings.bg;
  $('bgColor').value = settings.bgColor;
  $('bg').onchange = (e) => { settings.bg = e.target.value; save(); applyBackground(); };
  $('bgColor').oninput = (e) => { settings.bgColor = e.target.value; save(); applyBackground(); };

  for (const [id, key] of [['zoom', 'zoom'], ['offX', 'x'], ['offY', 'y']]) {
    $(id).oninput = (e) => { settings.view[mode][key] = Number(e.target.value); save(); };
  }
  for (const id of ['smooth', 'mouth']) {
    $(id).value = settings[id];
    $(id).oninput = (e) => { settings[id] = Number(e.target.value); save(); };
  }
  for (const id of ['mirror', 'showPreview', 'invYaw', 'invPitch', 'invRoll', 'invEyes']) {
    $(id).checked = settings[id];
    $(id).onchange = (e) => { settings[id] = e.target.checked; save(); applyPreview(); };
  }
  $('reset').onclick = () => { settings.view[mode] = { ...VIEW_DEFAULTS[mode] }; save(); syncViewSliders(); };

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
    else if (/^[0-9]$/.test(e.key)) setExpression(Number(e.key) - 1);
  });

  // マウスが窓の外に出たら／しばらく動かさなければパネルを隠す
  let idleTimer = 0;
  const away = () => document.body.classList.add('away');
  const wake = () => {
    document.body.classList.remove('away');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!$('panel').matches(':hover')) away(); }, 4000);
  };
  document.addEventListener('mousemove', wake);
  document.documentElement.addEventListener('mouseleave', away);
  window.addEventListener('blur', away);
  wake();

  // .vrm / 背景画像のドラッグ＆ドロップ
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (/\.(vrm|glb)$/i.test(file.name)) loadModel({ name: file.name, type: 'vrm', url });
    else if (file.type.startsWith('image/')) {
      $('bgimg').src = url;
      settings.bg = 'image';
      $('bg').value = 'image';
      applyBackground();
    } else status('.vrm か画像ファイルをドロップしてください（Live2D は models.json に登録）', true);
  });
}

function applyPreview() {
  video.style.display = settings.showPreview ? 'block' : 'none';
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  // 描く絵は横 1280px まで（OBS の出力と同じ。窓を大きくしても重くならない）
  const dpr = Math.min(window.devicePixelRatio, 2, 1280 / Math.max(1, w));
  cReal.width = Math.round(w * dpr);
  cReal.height = Math.round(h * dpr);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera3.aspect = w / h;
  camera3.updateProjectionMatrix();
}

// 動作状況をサーバーへ送る（curl localhost:18787/api/status で確認できる）
const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = lumaCanvas.height = 16;
function videoLuma() {
  if (video.readyState < 2) return null;
  const ctx = lumaCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return Math.round(sum / 256);
}

function reportStatus(lost) {
  const body = JSON.stringify({
    page: location.search || '/',
    videoLuma: videoLuma(),
    videoTime: Math.round(video.currentTime * 10) / 10,
    time: new Date().toISOString(),
    model: $('model').selectedOptions[0]?.textContent ?? '',
    expressions: expressionNames(),
    perfectSync: !!psMap,
    brb: brb.on,
    expression: activeExpr,
    camera: $('camera').selectedOptions[0]?.textContent ?? '',
    tracking: view.mode === 'camera' && !brb.on ? 'camera' : !landmarker ? 'starting' : lost ? 'no-face' : 'ok',
    hidden: document.hidden,
    fps: tracking.fps,
    head: { yaw: Math.round(face.yaw * DEG), pitch: Math.round(face.pitch * DEG), roll: Math.round(face.roll * DEG) },
    error: $('status').classList.contains('err') ? $('status').textContent : null,
  });
  fetch('/api/status', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

// ---------------------------------------------------------------- 実写モード（Zoom Deck の「実カメラ」）
// カメラ映像をこの画面に描く。背景を選んでいるときは人物だけを切り抜いてグリーンの上に描き、
// OBS がグリーンを抜いて背景（画像・動画）と合成する。カメラはこの画面だけで使う（OBS では開かない）。
const cReal = $('cReal');
const realCtx = cReal.getContext('2d');
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d');
let maskImg = null;
let segmenter = null;
let segmenterLoading = null;
let lastSegTime = -1;
const view = { mode: 'avatar', cutout: false };

function ensureSegmenter() {
  segmenterLoading ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: SEG_MODEL, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
    });
    try { segmenter = await ImageSegmenter.createFromOptions(fileset, opts('GPU')); }
    catch { segmenter = await ImageSegmenter.createFromOptions(fileset, opts('CPU')); }
  })().catch((e) => { console.error(e); status(`人物の切り抜きを開始できません: ${e.message}`, true); });
  return segmenterLoading;
}

// 映像を画面いっぱいに（はみ出す分は切る）
function coverRect(vw, vh, cw, ch) {
  const k = Math.max(cw / vw, ch / vh);
  return [(cw - vw * k) / 2, (ch - vh * k) / 2, vw * k, vh * k];
}

function drawReal(now) {
  if (video.readyState < 2 || !video.videoWidth) return;
  const W = cReal.width, H = cReal.height;
  const [x, y, w, h] = coverRect(video.videoWidth, video.videoHeight, W, H);
  const ctx = realCtx;
  if (!view.cutout || !segmenter) {
    if (view.cutout) ensureSegmenter();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(video, x, y, w, h);
    return;
  }
  if (video.currentTime === lastSegTime) return; // 新しいコマのときだけ処理
  lastSegTime = video.currentTime;
  segmenter.segmentForVideo(video, now, (res) => {
    const m = res.confidenceMasks?.[0];
    if (!m) return;
    const conf = m.getAsFloat32Array();
    if (maskCanvas.width !== m.width || maskCanvas.height !== m.height) {
      maskCanvas.width = m.width;
      maskCanvas.height = m.height;
      maskImg = maskCtx.createImageData(m.width, m.height);
    }
    const px = maskImg.data;
    for (let i = 0; i < conf.length; i++) {
      // 境界のにじみを抑える（0.3〜0.7 の間だけなだらかに）
      const a = (conf[i] - 0.3) / 0.4;
      px[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : a * 255;
    }
    maskCtx.putImageData(maskImg, 0, 0);
  });
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(video, x, y, w, h);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = 'blur(2px)';
  ctx.drawImage(maskCanvas, x, y, w, h);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function setView(next) {
  view.mode = next.view === 'camera' ? 'camera' : 'avatar';
  view.cutout = Boolean(next.cutout);
  if (view.mode === 'camera' && view.cutout) ensureSegmenter();
  if ('pumpkins' in next) setPumpkins(Boolean(next.pumpkins));
  applyViewVisibility();
}

// 離席中はアバターの離席アニメーションを出す（実写モードでも）
function applyViewVisibility() {
  const camera = view.mode === 'camera' && !brb.on;
  cReal.style.display = camera ? 'block' : 'none';
  c3d.style.display = !camera && mode === 'vrm' ? 'block' : 'none';
  c2d.style.display = !camera && mode === 'live2d' ? 'block' : 'none';
  // 見えていない Live2D は止めて負荷を下げる
  if (pixiApp) camera ? pixiApp.ticker.stop() : pixiApp.ticker.start();
}

// ---------------------------------------------------------------- カボチャ（ボタン盤の「🎃 カボチャ」）
// VRM のアバターのまわりを、ジャック・オー・ランタンが 6 個ゆっくり回る（Live2D・実写のときは 3D を描かないので出ない）。
// 1 周 20 秒、上下に ±2cm ふわふわ、少し傾けて揺れる。顔はいつもカメラの方を向く。
// 前を通るときは胸の高さまで下がって顔を隠さない。後ろを通るときはアバターに隠れる。出す・消すは 0.5 秒で大きさを変える
const PUMPKIN_URL = '/props/pumpkin.glb'; // 原点が中心・いちばん長い辺が 1・顔が +Z
const PUMPKINS = [ // a: 輪の上の位置（ラジアン） d: 直径（m） y: 高さのずれ（m） ph: 揺れの位相
  { a: 0.00, d: 0.110, y: -0.02, ph: 0.0 },
  { a: 1.10, d: 0.085, y: 0.04, ph: 1.7 },
  { a: 2.05, d: 0.120, y: -0.06, ph: 3.1 },
  { a: 3.20, d: 0.090, y: 0.02, ph: 4.4 },
  { a: 4.20, d: 0.105, y: -0.03, ph: 2.3 },
  { a: 5.25, d: 0.080, y: 0.06, ph: 5.2 },
];
const PUMPKIN_ORBIT = { rx: 0.45, rz: 0.32, period: 20, dip: 0.14, bob: 0.02, fade: 0.5, stagger: 0.06 };
const pumpkin = { on: false, items: [], start: [], t0: -10, loading: null, group: new THREE.Group() };
pumpkin.group.visible = false;
scene3.add(pumpkin.group);

const easeOutBack = (k) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2; // 少しだけ行き過ぎて戻る
const easeInCubic = (k) => k * k * k;

// アバターの MToon に合わせたトゥーンの塗り（3 段の陰）
function toonGradient() {
  const tex = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

async function loadPumpkins() {
  const gltf = await new GLTFLoader().loadAsync(PUMPKIN_URL);
  const gradientMap = toonGradient();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    o.material = new THREE.MeshToonMaterial({ map: m.map ?? null, color: m.map ? 0xffffff : m.color, gradientMap });
    m.dispose();
  });
  for (const p of PUMPKINS) {
    const o = gltf.scene.clone();
    o.rotation.order = 'YXZ'; // カメラの方へ向けてから傾ける
    o.scale.setScalar(0.0001);
    o.userData = { ...p, f: 0 };
    pumpkin.group.add(o);
    pumpkin.items.push(o);
  }
  pumpkin.start = pumpkin.items.map(() => 0);
  if (pumpkin.on) pumpkin.t0 = performance.now() / 1000; // 読み込み中に ON になったときは、ここからふわっと出す
}

function setPumpkins(on) {
  if (on === pumpkin.on) return;
  pumpkin.on = on;
  pumpkin.t0 = performance.now() / 1000;
  pumpkin.start = pumpkin.items.map((o) => o.userData.f); // 出しかけ・消しかけの大きさから続ける
  if (on && !pumpkin.items.length) {
    pumpkin.loading ??= loadPumpkins().catch((e) => { console.warn('カボチャを読み込めません', e); pumpkin.loading = null; });
  }
}

function updatePumpkins(t) {
  if (!pumpkin.items.length) return;
  const O = PUMPKIN_ORBIT;
  const cy = headY - 0.12; // 頭と胸の間
  let shown = false;
  pumpkin.items.forEach((o, i) => {
    const p = o.userData;
    const k = Math.min(1, Math.max(0, (t - pumpkin.t0 - i * O.stagger) / O.fade));
    const from = pumpkin.start[i] ?? 0;
    p.f = pumpkin.on ? from + (1 - from) * easeOutBack(k) : from * (1 - easeInCubic(k));
    if (p.f <= 0.001) { o.visible = false; return; }
    o.visible = shown = true;
    const th = p.a + (t / O.period) * Math.PI * 2;
    const front = Math.max(0, Math.sin(th)); // 1 = アバターの真ん前
    o.position.set(Math.cos(th) * O.rx, cy + p.y - front * O.dip + Math.sin(t * 2.4 + p.ph) * O.bob, Math.sin(th) * O.rz);
    o.scale.setScalar(p.d * p.f);
    const face = Math.atan2(camera3.position.x - o.position.x, camera3.position.z - o.position.z);
    o.rotation.set(Math.sin(t * 1.3 + p.ph) * 0.12, face + Math.sin(t * 0.8 + p.ph) * 0.25, Math.sin(t * 1.1 + p.ph * 1.3) * 0.15);
  });
  pumpkin.group.visible = shown;
}

// ---------------------------------------------------------------- メインループ
let prev = performance.now();
let lastFrame = 0;
function loop(now) {
  requestAnimationFrame(loop);
  // 30fps まで（OBS の出力と同じ。これ以上描いても使われない）
  if (now - lastFrame < 1000 / RENDER_FPS - 2) return;
  lastFrame = now;
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;

  if (view.mode === 'camera' && !brb.on) {
    try { drawReal(now); } catch (e) { console.warn(e); }
    if (now - tracking.t0 > 1000) {
      tracking.t0 = now;
      reportStatus(false);
    }
    return;
  }

  try { detect(now); } catch (e) { console.warn(e); }
  const lost = updateFace(now, dt);

  if (mode === 'vrm' && vrm) {
    applyVRM(dt, now / 1000);
    frameVRMCamera();
    updatePumpkins(now / 1000);
    renderer.render(scene3, camera3);
  } else if (mode === 'live2d') {
    layoutLive2D();
  }
  updateBrbTimer();

  if (now - tracking.t0 > 1000) {
    tracking.fps = tracking.frames;
    tracking.frames = 0;
    tracking.t0 = now;
    reportStatus(lost);
    const el = $('status');
    if (!el.classList.contains('err') && landmarker) {
      const line = el.textContent.split('\n')[0];
      el.textContent = `${line}\nトラッキング: ${lost ? '顔が見つかりません' : `OK（${tracking.fps} fps）`}`;
    }
  }
}

// ボタン盤（Zoom Deck）からの操作を受け取る
function listenDeck(models) {
  if (!window.EventSource) return;
  const es = new EventSource(APP_WIN ? `/api/events?win=app&born=${BORN}` : '/api/events');
  es.onmessage = (e) => {
    const cmd = JSON.parse(e.data);
    if (cmd.type === 'close') closeSelf();
    else if (cmd.type === 'expression') setExpression(cmd.index);
    else if (cmd.type === 'brb') setBrb(Boolean(cmd.on), cmd.message);
    else if (cmd.type === 'view') setView(cmd);
    else if (cmd.type === 'model') {
      const i = models.findIndex((m) => m.url === cmd.url);
      if (i >= 0) {
        $('model').value = String(i);
        $('model').dispatchEvent(new Event('change'));
      }
    }
  };
}

async function main() {
  onResize();
  window.addEventListener('resize', onResize);
  applyBackground();
  applyPreview();

  let models = FALLBACK_MODELS;
  try {
    const r = await fetch('/api/models');
    if (r.ok) models = await r.json();
  } catch { /* file:// で開いたとき */ }
  bindUI(models);
  listenDeck(models);
  // 最小化されると描画が止まり状態の報告も止まるので、隠れている間も「最小化中」とだけ知らせる
  setInterval(() => { if (document.hidden) reportStatus(true); }, 2000);
  fetch('/api/view').then((r) => r.json()).then(setView).catch(() => {});
  requestAnimationFrame(loop);

  const idx = Math.max(0, models.findIndex((m) => m.url === settings.model));
  $('model').value = String(idx);
  showModelPreview(models[idx]);
  const firstLoad = loadModel(models[idx]);

  try {
    await initLandmarker();
    if (params.has('test')) {
      initTestSource();
      window.__debug = { face, target, psFace, psBase, get psMap() { return psMap; }, get psEyeLook() { return psEyeLook; }, get testRoll() { return testRoll; }, get l2d() { return l2d; }, get vrm() { return vrm; } };
      // 非表示のタブでは requestAnimationFrame が止まるので、テスト時はタイマーでも回す
      setInterval(() => loop(performance.now()), 50);
      return;
    }
    // 保存済みのカメラが無くなっていたら既定のカメラで開き直す
    try { await startCamera(settings.camera || undefined); } catch { await startCamera(undefined); }
    const id = await listCameras();
    if (id && id !== stream.getVideoTracks()[0].getSettings().deviceId) await startCamera(id);
  } catch (e) {
    console.error(e);
    await firstLoad;
    status(`カメラ/トラッキングを開始できません: ${e.message || e}\n（アバターは待機モーションで表示します）`, true);
  }
}

main();
