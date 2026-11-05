// 音量メーターの確認: 各ソースと「BlackHole 2ch に実際に出ている音（= Zoom に届く音）」のピークを表示
// 使い方: node check-levels.mjs [秒数]
import crypto from 'node:crypto';
import { readWsConfig } from './obs-ws.mjs';

const SECONDS = Number(process.argv[2] || 8);
const PROBE = '__確認用 BlackHole 入力';
const cfg = readWsConfig();
const sha = (s) => crypto.createHash('sha256').update(s).digest('base64');
const ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port}`, 'obswebsocket.json');
const peaks = {};
let seq = 0;
const pending = new Map();
const call = (requestType, requestData = {}) => {
  const requestId = String(++seq);
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  return new Promise((res, rej) => pending.set(requestId, { res, rej }));
};

ws.onmessage = async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.op === 0) {
    const a = m.d.authentication;
    ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 1 << 16, authentication: a && sha(sha(cfg.server_password + a.salt) + a.challenge) } }));
  } else if (m.op === 2) {
    await run();
  } else if (m.op === 7) {
    const p = pending.get(m.d.requestId);
    pending.delete(m.d.requestId);
    if (m.d.requestStatus.result) p?.res(m.d.responseData ?? {});
    else p?.rej(new Error(m.d.requestStatus.comment));
  } else if (m.op === 5 && m.d.eventType === 'InputVolumeMeters') {
    for (const i of m.d.eventData.inputs) {
      const peak = Math.max(0, ...i.inputLevelsMul.map((ch) => ch[1] ?? 0));
      peaks[i.inputName] = Math.max(peaks[i.inputName] ?? 0, peak);
    }
  }
};

async function run() {
  const { currentProgramSceneName } = await call('GetCurrentProgramScene');
  await call('RemoveInput', { inputName: PROBE }).catch(() => {});
  const tmp = await call('CreateInput', { sceneName: currentProgramSceneName, inputName: PROBE, inputKind: 'coreaudio_input_capture', inputSettings: { device_id: 'default' } });
  const items = (await call('GetInputPropertiesListPropertyItems', { inputName: PROBE, propertyName: 'device_id' })).propertyItems;
  const bh = items.find((i) => /BlackHole 2ch/.test(i.itemName));
  await call('SetInputSettings', { inputName: PROBE, inputSettings: { device_id: bh.itemValue } });
  console.log(`${SECONDS} 秒間計測します…`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await call('RemoveInput', { inputName: PROBE });
  for (const [name, peak] of Object.entries(peaks)) {
    const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : '-inf';
    console.log(`${name === PROBE ? '→ Zoom に届く音（BlackHole 2ch）' : name}: ピーク ${db} dB`);
  }
  ws.close();
  void tmp;
}
