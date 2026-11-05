// obs-websocket v5 の最小クライアント（Node 22 以降の組み込み WebSocket を使用、依存なし）
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OBS_DIR = path.join(os.homedir(), 'Library/Application Support/obs-studio');
export const WS_CONFIG = path.join(OBS_DIR, 'plugin_config/obs-websocket/config.json');

const sha256b64 = (s) => crypto.createHash('sha256').update(s).digest('base64');

export function readWsConfig() {
  return JSON.parse(fs.readFileSync(WS_CONFIG, 'utf8'));
}

export async function connect({ port, password, eventSubscriptions = 0, onEvent, onClose } = {}) {
  const cfg = readWsConfig();
  port ??= Number(process.env.OBS_WS_PORT) || (cfg.server_port ?? 4455); // OBS_WS_PORT はテスト用（本物の OBS に触らないため）
  password ??= cfg.auth_required ? cfg.server_password : undefined;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'obswebsocket.json');
  const pending = new Map();
  let seq = 0;

  await new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error(`OBS (ws://127.0.0.1:${port}) に接続できません`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions };
        const auth = msg.d.authentication;
        if (auth) {
          if (!password) return reject(new Error('OBS WebSocket のパスワードが必要です'));
          identify.authentication = sha256b64(sha256b64(password + auth.salt) + auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (msg.op === 2) {
        resolve();
      } else if (msg.op === 5) {
        onEvent?.(msg.d.eventType, msg.d.eventData);
      } else if (msg.op === 7) {
        const p = pending.get(msg.d.requestId);
        if (!p) return;
        pending.delete(msg.d.requestId);
        if (msg.d.requestStatus.result) p.resolve(msg.d.responseData ?? {});
        else p.reject(new Error(`${msg.d.requestType}: ${msg.d.requestStatus.comment ?? msg.d.requestStatus.code}`));
      }
    };
    ws.onclose = (ev) => reject(new Error(`OBS との接続が閉じました (${ev.code} ${ev.reason})`));
  });
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('OBS との接続が切れました（OBS が終了した可能性）'));
    pending.clear();
    onClose?.();
  };

  return {
    call(requestType, requestData = {}) {
      const requestId = String(++seq);
      if (process.env.OBS_DEBUG) console.error('  →', requestType, JSON.stringify(requestData));
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    },
    close() { ws.close(); },
  };
}

export async function waitForObs(timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    let o;
    try {
      o = await connect();
      // 起動した直後の OBS は、つながっても「まだ準備中（not ready）」と断ることがある。答えられるようになるまで待つ
      await o.call('GetSceneCollectionList');
      return o;
    } catch (e) {
      try { o?.close(); } catch { /* 無視 */ }
      if (Date.now() - t0 > timeoutMs) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
