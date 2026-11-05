// 音楽ソース（アプリ音声）を今起動しているアプリに付け直す
// OBS より後に音楽アプリを起動したときに実行する:  node refresh-music.mjs
import { connect } from './obs-ws.mjs';
import { recreateMusicInputs } from './music.mjs';

const obs = await connect();
try {
  for (const line of await recreateMusicInputs(obs)) console.log(`・ ${line}を付け直しました`);
} catch (e) {
  console.log(e.message);
}
obs.close();
