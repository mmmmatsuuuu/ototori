// 動作確認・お試し用のサンプル音源(WAV)をブラウザ内で合成する。
// 実ファイルと同じ経路(File → arrayBuffer → decodeAudioData)を通せるよう
// WAV バイト列を生成して File として返す。

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
}

// ドレミの短いフレーズ。波形に変化が出るようエンベロープを付ける。
export function makeSampleWav(): File {
  const sampleRate = 44100
  const notes = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25]
  const noteDur = 0.5
  const total = notes.length * noteDur
  const length = Math.floor(sampleRate * total)
  const samples = new Float32Array(length)

  for (let n = 0; n < notes.length; n++) {
    const freq = notes[n]
    const start = Math.floor(n * noteDur * sampleRate)
    const end = Math.floor((n + 1) * noteDur * sampleRate)
    for (let i = start; i < end; i++) {
      const t = (i - start) / sampleRate
      // 簡易エンベロープ(アタック/リリース)
      const env = Math.min(1, t * 20) * Math.min(1, (noteDur - t) * 8)
      samples[i] = Math.sin(2 * Math.PI * freq * t) * 0.3 * env
    }
  }

  const bytesPerSample = 2
  const dataSize = length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s * 0x7fff, true)
    offset += 2
  }

  return new File([buffer], 'サンプル音源(ドレミ).wav', { type: 'audio/wav' })
}
