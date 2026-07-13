import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type EngineState, type PrepareState } from './audio/AudioEngine'
import { Waveform } from './components/Waveform'
import { makeSampleWav } from './audio/sampleTone'

const TEMPO_PRESETS = [0.35, 0.4, 0.5, 0.65, 0.8, 1.0]

type Mode = 'explore' | 'practice'
type Segment = { start: number; end: number }

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
  const [prepare, setPrepare] = useState<PrepareState>('idle')
  const [error, setError] = useState<string>('')

  // アンカー送りの状態
  const [mode, setMode] = useState<Mode>('explore')
  const [anchor, setAnchor] = useState(0) // 起点
  const [endPoint, setEndPoint] = useState<number | null>(null) // 終点(練習時)
  const [history, setHistory] = useState<Segment[]>([])

  // 安定したコールバックから最新値を参照するための ref
  const modeRef = useRef(mode); modeRef.current = mode
  const anchorRef = useRef(anchor); anchorRef.current = anchor
  const endRef = useRef(endPoint); endRef.current = endPoint
  const tempoRef = useRef(tempo); tempoRef.current = tempo

  useEffect(() => {
    engine.onStateChange = (s) => setState(s)
    engine.onPrepareChange = (s) => setPrepare(s)
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
      setMode('explore')
      setAnchor(0)
      setEndPoint(null)
      setHistory([])
      engine.setLooping(false)
      engine.seek(0)
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

  // ---- モード遷移 ----

  // 探索モードへ。from を起点にし、必要なら素通し再生を開始
  const goExplore = useCallback((from: number, autoplay: boolean) => {
    engine.pause()
    engine.setLooping(false)
    engine.setTempo(1) // 探索は常に等速
    setMode('explore')
    setEndPoint(null)
    setAnchor(from)
    engine.seek(from)
    if (autoplay) void engine.play(from)
  }, [engine])

  // 練習モードへ。区間[a,b]をループ(M2のピッチ維持テンポ)
  const goPractice = useCallback((a: number, b: number, autoplay: boolean) => {
    engine.pause()
    engine.setTempo(tempoRef.current)
    engine.setLoop(a, b)
    engine.setLooping(true)
    setMode('practice')
    setAnchor(a)
    setEndPoint(b)
    if (autoplay) void engine.play(a)
  }, [engine])

  // ---- 操作 ----

  const togglePlay = () => {
    if (state === 'playing') engine.pause()
    else void engine.play()
  }

  // 区切る: 現在位置を終点にして練習モードへ
  const punch = () => {
    const end = engine.getPosition()
    if (end <= anchor + 0.05) return // 短すぎる区間は無視
    goPractice(anchor, end, true)
  }

  // 次へ: 新起点=今の終点。履歴に積んで素通し再開
  const next = () => {
    if (endPoint == null) return
    setHistory((h) => [...h, { start: anchor, end: endPoint }])
    goExplore(endPoint, true)
  }

  // 戻る: 履歴を1つ戻して前の区間を練習
  const back = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    goPractice(prev.start, prev.end, true)
  }

  // 取り直す: 終点を捨てて起点から探索へ
  const redo = () => {
    goExplore(anchor, true)
  }

  const applyTempo = (r: number) => {
    setTempo(r)
    tempoRef.current = r
    if (modeRef.current === 'practice') engine.setTempo(r)
  }

  // ---- 波形コールバック(安定参照) ----
  const onSeek = useCallback((sec: number) => {
    engine.seek(sec)
    setPosition(sec)
  }, [engine])
  const onMoveAnchor = useCallback((sec: number) => {
    setAnchor(sec)
    if (modeRef.current === 'practice' && endRef.current != null) {
      engine.setLoop(sec, endRef.current)
    } else {
      engine.seek(sec) // 探索: 起点=再生開始位置
      setPosition(sec)
    }
  }, [engine])
  const onMoveEnd = useCallback((sec: number) => {
    setEndPoint(sec)
    engine.setLoop(anchorRef.current, sec)
  }, [engine])

  const stateLabel = useMemo(() => ({
    idle: '待機', ready: '準備完了', playing: '再生中', paused: '一時停止',
  }[state]), [state])

  const segLen = endPoint != null ? endPoint - anchor : 0

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
            mode={mode}
            anchor={anchor}
            endPoint={endPoint}
            onSeek={onSeek}
            onMoveAnchor={onMoveAnchor}
            onMoveEnd={onMoveEnd}
          />

          <div className="timerow">
            <span className="time">{fmt(position)}</span>
            <span className="time dim">/ {fmt(buffer.duration)}</span>
            <span className={`modechip ${mode}`}>{mode === 'explore' ? '探索' : '練習'}</span>
          </div>

          {/* トランスポート: モード別 */}
          {mode === 'explore' ? (
            <>
              <div className="transport">
                <button className="btn primary" onClick={togglePlay}>
                  {state === 'playing' ? '一時停止' : '再生'}
                </button>
                <button className="btn on" onClick={punch}>区切る</button>
              </div>
              {history.length > 0 && (
                <div className="transport">
                  <button className="btn" onClick={back}>◀ 戻る</button>
                </div>
              )}
              <div className="seginfo">
                <span className="lbl">起点</span>
                <span className="range">{fmt(anchor)}</span>
                <span className="hint">再生 → フレーズの切れ目で「区切る」。波形タップ/ドラッグで起点を移動。</span>
              </div>
            </>
          ) : (
            <>
              <div className="transport">
                <button className="btn primary" onClick={togglePlay}>
                  {state === 'playing' ? '一時停止' : '再生'}
                </button>
                <button className="btn on" onClick={next}>次へ ▶</button>
              </div>
              <div className="transport">
                <button className="btn" onClick={back} disabled={history.length === 0}>◀ 戻る</button>
                <button className="btn" onClick={redo}>取り直す</button>
              </div>
              <div className="seginfo">
                <span className="lbl">区間</span>
                <span className="range">{fmt(anchor)} → {fmt(endPoint ?? 0)}（{fmt(segLen)}）</span>
                <span className="hint">起点・終点をドラッグで微調整。</span>
              </div>
            </>
          )}

          <div className="temporow">
            <div className="tlabel">
              <span>テンポ <strong>{Math.round(tempo * 100)}%</strong></span>
              {mode === 'explore' ? (
                <span className="mode">探索は等速（この速さは練習ループに適用）</span>
              ) : tempo === 1 ? (
                <span className="mode">等速</span>
              ) : prepare === 'rendering' ? (
                <span className="mode rendering">高音質生成中…</span>
              ) : prepare === 'error' ? (
                <span className="warn">生成に失敗しました</span>
              ) : (
                <span className="mode ok">ピッチ維持（Rubberband）</span>
              )}
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
        <span>モード: {mode === 'explore' ? '探索' : '練習'}</span>
        <span>位置: {fmt(position)}</span>
        <span>テンポ: {Math.round(tempo * 100)}%</span>
        <span>履歴: {history.length}</span>
      </footer>
    </div>
  )
}
