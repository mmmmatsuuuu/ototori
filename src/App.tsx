import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type EngineState } from './audio/AudioEngine'
import { Waveform } from './components/Waveform'
import { makeSampleWav } from './audio/sampleTone'

const TEMPO_PRESETS = [0.5, 0.65, 0.8, 1.0]

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 100)
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`
}

export default function App() {
  const engineRef = useRef<AudioEngine>()
  if (!engineRef.current) engineRef.current = new AudioEngine()
  const engine = engineRef.current

  const [fileName, setFileName] = useState<string>('')
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null)
  const [state, setState] = useState<EngineState>('idle')
  const [position, setPosition] = useState(0)
  const [tempo, setTempo] = useState(1)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [loopStart, setLoopStart] = useState(0)
  const [loopEnd, setLoopEnd] = useState(0)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    engine.onStateChange = (s) => setState(s)
    if (import.meta.env.DEV) {
      ;(window as unknown as { __engine: AudioEngine }).__engine = engine
    }
  }, [engine])

  // 現在位置の表示更新(10fps 程度)
  useEffect(() => {
    const id = setInterval(() => setPosition(engine.getPosition()), 100)
    return () => clearInterval(id)
  }, [engine])

  const loadFile = useCallback(async (file: File) => {
    setError('')
    try {
      const data = await file.arrayBuffer()
      const buf = await engine.load(data)
      setFileName(file.name)
      setBuffer(buf)
      setTempo(1)
      engine.setTempo(1)
      setLoopStart(0)
      setLoopEnd(buf.duration)
      setLoopEnabled(false)
      engine.setLooping(false)
      setPosition(0)
    } catch (e) {
      setError(`読み込み/デコードに失敗しました: ${(e as Error).message}`)
    }
  }, [engine])

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) void loadFile(f)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f) void loadFile(f)
  }

  const togglePlay = () => {
    if (state === 'playing') engine.pause()
    else void engine.play()
  }
  const stop = () => engine.stop()

  const applyTempo = (r: number) => {
    setTempo(r)
    engine.setTempo(r)
  }
  const toggleLoop = () => {
    const next = !loopEnabled
    setLoopEnabled(next)
    engine.setLooping(next)
  }
  const onSeek = useCallback((sec: number) => {
    engine.seek(sec)
    setPosition(sec)
  }, [engine])
  const onSetLoop = useCallback((s: number, e: number) => {
    const a = Math.min(s, e)
    const b = Math.max(s, e)
    setLoopStart(a)
    setLoopEnd(b)
    engine.setLoop(a, b)
  }, [engine])

  const stateLabel = useMemo(() => ({
    idle: '待機', ready: '準備完了', playing: '再生中', paused: '一時停止',
  }[state]), [state])

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="header">
        <h1>音取り <span className="sub">耳コピ練習 — MVP</span></h1>
        <div className="badge" data-state={state}>{stateLabel}</div>
      </header>

      {!buffer && (
        <label className="dropzone">
          <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg" onChange={onFileInput} hidden />
          <div className="dz-inner">
            <strong>音源ファイルを選択</strong>
            <span>クリック、またはここにドラッグ＆ドロップ（MP3 / M4A / WAV など）</span>
            <span className="note">ファイルは端末内で処理され、外部に送信されません。</span>
          </div>
        </label>
      )}

      {!buffer && (
        <button className="btn sample" onClick={() => void loadFile(makeSampleWav())}>
          サンプル音源（ドレミ）で試す
        </button>
      )}

      {error && <div className="error">{error}</div>}

      {buffer && (
        <main className="editor">
          <div className="filebar">
            <span className="fname" title={fileName}>{fileName}</span>
            <label className="link">
              別のファイル
              <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg" onChange={onFileInput} hidden />
            </label>
          </div>

          <Waveform
            engine={engine}
            buffer={buffer}
            loopStart={loopStart}
            loopEnd={loopEnd}
            loopEnabled={loopEnabled}
            onSeek={onSeek}
            onSetLoop={onSetLoop}
          />

          <div className="timerow">
            <span className="time">{fmt(position)}</span>
            <span className="time dim">/ {fmt(buffer.duration)}</span>
          </div>

          <div className="transport">
            <button className="btn primary" onClick={togglePlay}>
              {state === 'playing' ? '一時停止' : '再生'}
            </button>
            <button className="btn" onClick={stop}>停止</button>
            <button className={`btn ${loopEnabled ? 'on' : ''}`} onClick={toggleLoop}>
              ループ {loopEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div className="looprow">
            <span className="lbl">ループ範囲</span>
            <span className="range">{fmt(loopStart)} → {fmt(loopEnd)}（{fmt(loopEnd - loopStart)}）</span>
            <span className="hint">波形をドラッグで範囲選択・境界線をドラッグで微調整</span>
          </div>

          <div className="temporow">
            <div className="tlabel">
              <span>テンポ <strong>{Math.round(tempo * 100)}%</strong></span>
              <span className="warn">暫定：ピッチも変化（次でRubberband化）</span>
            </div>
            <input
              type="range" min={0.25} max={1} step={0.01} value={tempo}
              onChange={(e) => applyTempo(parseFloat(e.target.value))}
            />
            <div className="presets">
              {TEMPO_PRESETS.map((p) => (
                <button
                  key={p}
                  className={`chip ${Math.abs(tempo - p) < 0.005 ? 'on' : ''}`}
                  onClick={() => applyTempo(p)}
                >{Math.round(p * 100)}%</button>
              ))}
            </div>
          </div>
        </main>
      )}

      <footer className="statusbar">
        <span>状態: <b>{stateLabel}</b></span>
        <span>位置: {fmt(position)}</span>
        <span>テンポ: {Math.round(tempo * 100)}%</span>
        <span>ループ: {loopEnabled ? `${fmt(loopStart)}–${fmt(loopEnd)}` : 'OFF'}</span>
      </footer>
    </div>
  )
}
