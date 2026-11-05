// 音楽ソース（アプリ音声）を、今起動しているアプリにつなぎ直す
//
// OBS のアプリ音声取り込みは「作られた時点で起動していたアプリ」にしか繋がらない。
// 以前はプロパティ一覧の問い合わせで一覧を更新していたが、OBS 側の不具合で落ちることがあるため、
// ソースを作り直す（作成時に最新のアプリ一覧を取る）方式にしている。

export async function recreateMusicInputs(obs, sceneName = 'Zoom') {
  // 別の用途（Switch 配信など）のシーンコレクションでは、そちらのアプリ音声を消してしまうので何もしない
  const { currentSceneCollectionName } = await obs.call('GetSceneCollectionList');
  if (currentSceneCollectionName !== 'Zoom（音楽+アバター）') {
    throw new Error(`OBS は別の用途（${currentSceneCollectionName}）で使用中なので、音楽ソースは付け直しませんでした`);
  }
  const { inputs } = await obs.call('GetInputList', { inputKind: 'sck_audio_capture' });
  const done = [];
  for (const { inputName } of inputs) {
    const [{ inputSettings }, vol, mute, mon] = await Promise.all([
      obs.call('GetInputSettings', { inputName }),
      obs.call('GetInputVolume', { inputName }),
      obs.call('GetInputMute', { inputName }),
      obs.call('GetInputAudioMonitorType', { inputName }),
    ]);
    await obs.call('RemoveInput', { inputName });
    // 削除の反映を少し待つ（同名ですぐ作ると失敗することがある）
    await new Promise((r) => setTimeout(r, 300));
    await obs.call('CreateInput', { sceneName, inputName, inputKind: 'sck_audio_capture', inputSettings });
    await obs.call('SetInputVolume', { inputName, inputVolumeDb: vol.inputVolumeDb });
    await obs.call('SetInputMute', { inputName, inputMuted: mute.inputMuted });
    await obs.call('SetInputAudioMonitorType', { inputName, monitorType: mon.monitorType });
    done.push(`${inputName}（${inputSettings.application || 'デスクトップ全体'}）`);
  }
  return done;
}
