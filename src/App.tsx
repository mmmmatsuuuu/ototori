import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioEngine, type EngineState, type PrepareState } from './audio/AudioEngine'
import { Waveform, type WaveformHandle } from './components/Waveform'
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
  const waveRef = useRef<WaveformHandle>(null)

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

  // UI 状態
  const [menuOpen, setMenuOpen] = useState(false)
  const [isZoomed, setIsZoomed] = useState(false)
  const [portrait, setPortrait] = useState(false)
  const [rotateDismissed, setRotateDismissed] = useState(false)

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

  // 再生中は画面を消灯させない(Wake Lock)。非対応環境では何もしない。
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  useEffect(() => {
    const releaseLock = () => {
      wakeLockRef.current?.release().catch(() => { /* 既に解放済み */ })
      wakeLockRef.current = null
    }
    if (!('wakeLock' in navigator) || state !== 'playing') {
      releaseLock()
      return
    }
    let cancelled = false
    const acquire = async () => {
      if (wakeLockRef.current || document.visibilityState !== 'visible') return
      try {
        const s = await navigator.wakeLock.request('screen')
        if (cancelled) { void s.release(); return }
        wakeLockRef.current = s
        s.addEventListener('release', () => { wakeLockRef.current = null })
      } catch { /* 権限や電源状態により失敗することがある */ }
    }
    void acquire()
    // 画面を離れると自動解放されるため、戻ってきたら取り直す
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [state])
  useEffect(() => () => { wakeLockRef.current?.release().catch(() => {}) }, [])

  // 復帰時に AudioContext が止まったままにならないようにする
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void engine.resume()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [engine])

  // 縦向き検出(タッチ端末のみ。PCの縦長ウィンドウでは promptしない)
  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const isTouch = navigator.maxTouchPoints > 0
    const update = () => setPortrait(mq.matches && isTouch)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // 横向き全画面を試みる(Android等では有効。iOSは非対応なので手動回転に委ねる)
  const goLandscape = async () => {
    try {
      await document.documentElement.requestFullscreen?.()
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      await o?.lock?.('landscape')
    } catch { /* 非対応環境では何もしない */ }
  }

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
      setMenuOpen(false)
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
  const punch = () => {
    const end = engine.getPosition()
    if (end <= anchor + 0.05) return
    goPractice(anchor, end, true)
  }
  const next = () => {
    if (endPoint == null) return
    setHistory((h) => [...h, { start: anchor, end: endPoint }])
    goExplore(endPoint, true)
  }
  const back = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    goPractice(prev.start, prev.end, true)
  }
  const redo = () => goExplore(anchor, true)

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
      engine.seek(sec)
      setPosition(sec)
    }
  }, [engine])
  const onMoveEnd = useCallback((sec: number) => {
    setEndPoint(sec)
    engine.setLoop(anchorRef.current, sec)
  }, [engine])
  const onZoomedChange = useCallback((z: boolean) => setIsZoomed(z), [])

  const playing = state === 'playing'
  const segLen = endPoint != null ? endPoint - anchor : 0
  const showRotate = portrait && !rotateDismissed

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {!buffer ? (
        <div className="empty">
          <h1 className="brand">音取り<span>耳コピ練習</span></h1>
          <label className="dropzone">
            <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg" onChange={onFileInput} hidden />
            <div className="dz-inner">
              <strong>音源ファイルを選択</strong>
              <span>タップ、またはドラッグ＆ドロップ（MP3 / M4A / WAV など）</span>
              <span className="note">ファイルは端末内で処理され、外部に送信されません。</span>
            </div>
          </label>
          <button className="ghost" onClick={() => void loadFile(makeSampleWav())}>
            サンプル音源（ドレミ）で試す
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      ) : (
        <>
          {/* 波形は全画面。UI はこの上にフローティング */}
          <Waveform
            ref={waveRef}
            engine={engine}
            buffer={buffer}
            mode={mode}
            anchor={anchor}
            endPoint={endPoint}
            onSeek={onSeek}
            onMoveAnchor={onMoveAnchor}
            onMoveEnd={onMoveEnd}
            onZoomedChange={onZoomedChange}
          />

          <div className="topbar">
            <span className={`mode ${mode}`}>{mode === 'explore' ? '探索' : '練習'}</span>
            <span className="fname">{fileName}</span>
            {tempo !== 1 && (
              <span className={`tempopill ${prepare === 'rendering' ? 'busy' : ''}`}>
                {prepare === 'rendering' ? '生成中…' : `${Math.round(tempo * 100)}%`}
              </span>
            )}
          </div>

          <div className={`dock ${menuOpen ? 'shifted' : ''}`}>
            <div className="readout">
              <span className="time">{fmt(position)}</span>
              <span className="seg">
                {endPoint != null
                  ? `区間 ${fmt(anchor)} → ${fmt(endPoint)}（${fmt(segLen)}）`
                  : `起点 ${fmt(anchor)}`}
              </span>
            </div>
            <div className="dockrow">
              <button className="db sub" onClick={back} disabled={history.length === 0}>◀ 戻る</button>
              <button className="db main play" onClick={togglePlay}>
                {playing ? '❚❚ 一時停止' : '▶ 再生'}
              </button>
              {mode === 'explore' ? (
                <button className="db main go" onClick={punch}>区切る</button>
              ) : (
                <>
                  <button className="db main go" onClick={next}>次へ ▶</button>
                  <button className="db sub" onClick={redo}>取り直す</button>
                </>
              )}
              <button
                className={`db menu ${menuOpen ? 'on' : ''}`}
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="メニュー"
              >≡</button>
            </div>
          </div>

          {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
          <aside className={`drawer ${menuOpen ? 'open' : ''}`}>
            <div className="drawerhead">
              <strong>設定</strong>
              <button className="icon" onClick={() => setMenuOpen(false)} aria-label="閉じる">✕</button>
            </div>

            <section className="dsec">
              <div className="dlabel">
                <span>テンポ <strong>{Math.round(tempo * 100)}%</strong></span>
                {mode === 'explore' ? (
                  <span className="note2">探索は等速（練習ループに適用）</span>
                ) : tempo === 1 ? (
                  <span className="note2">等速</span>
                ) : prepare === 'rendering' ? (
                  <span className="note2 busy">高音質生成中…</span>
                ) : prepare === 'error' ? (
                  <span className="note2 warn">生成に失敗しました</span>
                ) : (
                  <span className="note2 ok">ピッチ維持</span>
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
            </section>

            <section className="dsec">
              <button
                className="drow"
                onClick={() => {
                  if (endPoint == null) return
                  waveRef.current?.fitTo(anchor, endPoint)
                  setMenuOpen(false) // 波形を見て微調整に移れるよう閉じる
                }}
                disabled={endPoint == null}
              >区間フィット</button>
              <button
                className="drow"
                onClick={() => { waveRef.current?.resetView(); setMenuOpen(false) }}
                disabled={!isZoomed}
              >全体表示</button>
              <label className="drow">
                別のファイルを読み込む
                <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg" onChange={onFileInput} hidden />
              </label>
            </section>

            <p className="dhint">
              波形: ピンチで拡大 / ドラッグで移動 / 起点・終点バーはドラッグで微調整。<br />
              {mode === 'explore' ? 'タップで起点を移動、切れ目で「区切る」。' : 'タップでその位置へシーク。'}
            </p>
          </aside>
        </>
      )}

      {/* 縦向きの案内はファイル読込前から出す */}
      {showRotate && (
        <div className="rotate">
          <div className="rot-ico">⟳</div>
          <strong>端末を横向きにしてください</strong>
          <p>波形を大きく表示するため、横置きでの利用を前提にしています。</p>
          <div className="rot-btns">
            <button className="db main go" onClick={() => void goLandscape()}>横向き全画面にする</button>
            <button className="ghost" onClick={() => setRotateDismissed(true)}>このまま使う</button>
          </div>
          <p className="rot-note">回転しない場合は、端末側の「画面の向きをロック」を解除してください。</p>
        </div>
      )}
    </div>
  )
}
