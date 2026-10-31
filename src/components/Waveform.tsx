import { forwardRef, useEffect, useImperativeHandle, useRef, type RefObject } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { fmt } from '../format'

export type WaveMode = 'explore' | 'practice'

// 「全体表示」「区間にフィット」はメニュー側にあるため、外部から呼べるように公開する
export type WaveformHandle = {
  resetView: () => void
  fitTo: (start: number, end: number) => void
}

type Props = {
  engine: AudioEngine
  buffer: AudioBuffer | null
  mode: WaveMode
  anchor: number // 起点
  endPoint: number | null // 終点(練習モードのみ)
  onSeek: (sec: number) => void
  onMoveAnchor: (sec: number) => void
  onMoveEnd: (sec: number) => void
  // 再生ヘッドのドラッグ開始/終了(再生中なら一時停止→再開するため)
  onScrubStart: () => void
  onScrubEnd: () => void
  onZoomedChange?: (zoomed: boolean) => void
  dockRef: RefObject<HTMLElement> // 再生ヘッドのつまみを下部ドックに重ねないために高さを読む
}

type Peaks = { min: Float32Array; max: Float32Array; width: number; vs: number; ve: number; buffer: AudioBuffer }

// 表示範囲[startSample,endSample]を width 列の min/max ピークに畳む(重いのでキャッシュ)
function computePeaks(buffer: AudioBuffer, width: number, startSample: number, endSample: number): Peaks {
  const data = buffer.getChannelData(0)
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  // 表示範囲は曲の前後の余白にはみ出すことがある。はみ出した列は無音(0)になる
  const step = (endSample - startSample) / width
  for (let x = 0; x < width; x++) {
    const a0 = Math.floor(startSample + x * step)
    const a = Math.max(0, a0)
    const b = Math.min(data.length, Math.max(a0 + 1, Math.floor(startSample + (x + 1) * step)))
    let lo = 1
    let hi = -1
    for (let i = a; i < b; i++) {
      const v = data[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[x] = lo === 1 && hi === -1 ? 0 : lo
    max[x] = lo === 1 && hi === -1 ? 0 : hi
  }
  return { min, max, width, vs: startSample, ve: endSample, buffer }
}

const HANDLE_HIT_PX = 22 // 起点/終点バー・再生ヘッドの当たり判定(指で掴める幅)
const MIN_SPAN = 0.03 // 最大ズーム時の表示秒数
const KNOB_MARGIN_PX = 16 // 曲の前後の余白に足す幅(つまみの半径。端でもつまみが切れないように)
const MAX_MARGIN_RATIO = 0.25 // 片側の余白の上限(画面幅に対する割合)
const FADED_ALPHA = 0.6 // 掴めない側の半分(点線)の濃さ
const DIM_OTHER_ZONE = 'rgba(15, 17, 21, 0.6)' // 触っている間、反対側の半分を落とす色

// 起点/終点のつまみの高さ(CSS px)。重なっても掴み分けられるよう段違いに置く。
// 起点は上部バーに隠れない高さ、終点はその下(タブ同士も重ならない間隔)
const barKnobYs = (cssH: number) => {
  const anchor = Math.max(74, cssH * 0.22)
  return { anchor, end: Math.max(anchor, Math.min(anchor + 40, cssH / 2 - 18)) }
}

// 波形の上半分=区間(起点/終点)、下半分=再生位置 を操作するゾーン
type Zone = 'top' | 'bottom'
type Grab = 'anchor' | 'end' | 'head'

export const Waveform = forwardRef<WaveformHandle, Props>(function Waveform(
  { engine, buffer, mode, anchor, endPoint, onSeek, onMoveAnchor, onMoveEnd, onScrubStart, onScrubEnd, onZoomedChange, dockRef },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peaks | null>(null)
  // 録音レベルが低い音源でも縦を活かせるよう、全体ピークで正規化する
  const gainRef = useRef(1)

  // 最新の props をアニメーション/ポインタ処理から参照する ref
  const stateRef = useRef({ buffer, mode, anchor, endPoint })
  stateRef.current = { buffer, mode, anchor, endPoint }
  const onZoomedChangeRef = useRef(onZoomedChange)
  onZoomedChangeRef.current = onZoomedChange

  // 表示ウィンドウ(秒)。描画・ポインタ判定はすべてこれ基準。
  const viewRef = useRef({ start: 0, end: 0 })
  const zoomedRef = useRef(false)
  const pointersRef = useRef(new Map<number, number>()) // pointerId -> clientX
  const pinchRef = useRef<{ dist0: number; span0: number; timeAtMid: number } | null>(null)
  const suppressFollowUntilRef = useRef(0)
  // 触っているゾーンと掴んでいるもの。描画(ラベル表示・反対側を暗く)に使う
  const activeZoneRef = useRef<Zone | null>(null)
  const grabRef = useRef<Grab | null>(null)

  // 曲の前後の余白(画面幅に対する割合)。ノッチ等に隠れてつまみを掴めなくなるのを防ぐ。
  // 表示範囲を曲の外へはみ出せるようにして作るので、余白が見えるのは曲の両端だけ。
  const marginRef = useRef({ left: 0, right: 0 })

  // 余白込みで曲全体が収まる表示秒数
  const fullSpanOf = (dur: number) => dur / (1 - marginRef.current.left - marginRef.current.right)

  // ズーム状態が変わったときだけ通知(ピンチ中の再レンダーを避ける)
  const syncZoomed = (span: number, dur: number) => {
    const z = span < fullSpanOf(dur) - 1e-4
    if (z !== zoomedRef.current) {
      zoomedRef.current = z
      onZoomedChangeRef.current?.(z)
    }
  }

  // 表示範囲を、余白を超えないように収めて設定する
  const setView = (start: number, span: number) => {
    const dur = stateRef.current.buffer?.duration ?? 0
    const { left, right } = marginRef.current
    const sp = Math.max(Math.min(MIN_SPAN, dur), Math.min(span, fullSpanOf(dur)))
    const st = Math.max(-left * sp, Math.min(start, dur + right * sp - sp))
    viewRef.current = { start: st, end: st + sp }
    syncZoomed(sp, dur)
  }

  const resetView = () => {
    const dur = stateRef.current.buffer?.duration ?? 0
    setView(-marginRef.current.left * fullSpanOf(dur), fullSpanOf(dur))
  }

  // 指定区間が画面いっぱいになるよう表示を合わせる(端が見切れず、ノッチにも隠れないよう余白を取る)
  const fitTo = (start: number, end: number) => {
    const dur = stateRef.current.buffer?.duration ?? 0
    if (!dur || end <= start) return
    const padL = Math.max(0.06, marginRef.current.left)
    const padR = Math.max(0.06, marginRef.current.right)
    const span = Math.max(MIN_SPAN, (end - start) / (1 - padL - padR))
    setView(start - padL * span, span)
    suppressFollowUntilRef.current = performance.now() + 1200
  }

  useImperativeHandle(ref, () => ({ resetView, fitTo }), [])

  // バッファが変わったら全体表示にリセットし、表示ゲインを求め直す
  useEffect(() => {
    pointersRef.current.clear()
    pinchRef.current = null
    resetView()

    if (!buffer) { gainRef.current = 1; return }
    const data = buffer.getChannelData(0)
    const stride = Math.max(1, Math.floor(data.length / 200000)) // 長尺は間引いて概算
    let peak = 0
    for (let i = 0; i < data.length; i += stride) {
      const v = Math.abs(data[i])
      if (v > peak) peak = v
    }
    // 音源のレベルによらず縦幅の約8割に収める(上下に余白を残す)
    gainRef.current = peak > 0.001 ? Math.min(12, Math.max(0.3, 0.8 / peak)) : 1
  }, [buffer])

  // 開発時のみ表示ウィンドウをデバッグ用に露出
  useEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as { __wave: typeof viewRef }).__wave = viewRef
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0

    const draw = () => {
      const { buffer, anchor, endPoint } = stateRef.current
      const dpr = window.devicePixelRatio || 1
      const cssW = canvas.clientWidth
      const cssH = canvas.clientHeight
      const w = Math.floor(cssW * dpr)
      const h = Math.floor(cssH * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, w, h)

      const style = getComputedStyle(canvas)
      const cWave = style.getPropertyValue('--wave').trim() || '#5dcaa5'
      const cAxis = style.getPropertyValue('--axis').trim() || 'rgba(255,255,255,0.15)'
      const cBarKnob = style.getPropertyValue('--bar-knob').trim() || '#e8ecf1'
      const cHeadKnob = style.getPropertyValue('--head-knob').trim() || '#c9704f'

      if (!buffer) {
        raf = requestAnimationFrame(draw)
        return
      }
      const dur = buffer.duration
      const pos = engine.getPosition()

      // 余白を測り直す(画面の回転でセーフエリアが変わる)。全体表示なら全体が収まるよう合わせ直す
      const toRatio = (css: string) => cssW > 0
        ? Math.min(MAX_MARGIN_RATIO, ((parseFloat(css) || 0) + KNOB_MARGIN_PX) / cssW)
        : 0
      const left = toRatio(style.scrollPaddingLeft)
      const right = toRatio(style.scrollPaddingRight)
      if (left !== marginRef.current.left || right !== marginRef.current.right) {
        marginRef.current = { left, right }
        if (zoomedRef.current) setView(viewRef.current.start, viewRef.current.end - viewRef.current.start)
        else resetView()
      }

      // 再生ヘッド自動追従(再生中・ズーム中・無操作時のみ)
      if (
        engine.state === 'playing' && zoomedRef.current &&
        pointersRef.current.size === 0 && performance.now() > suppressFollowUntilRef.current &&
        (pos < viewRef.current.start || pos > viewRef.current.end)
      ) {
        const sp = viewRef.current.end - viewRef.current.start
        setView(pos - 0.05 * sp, sp)
      }
      const { start: vs, end: ve } = viewRef.current
      const span = ve - vs || dur
      const xOf = (sec: number) => ((sec - vs) / span) * w

      // 表示範囲のピーク(ビュー/幅が変わったら再計算)
      const sr = buffer.sampleRate
      const s0 = Math.floor(vs * sr)
      const e0 = Math.ceil(ve * sr)
      const pk = peaksRef.current
      if (!pk || pk.buffer !== buffer || pk.width !== w || pk.vs !== s0 || pk.ve !== e0) {
        peaksRef.current = computePeaks(buffer, w, s0, e0)
      }
      const peaks = peaksRef.current!

      // 中心線
      ctx.strokeStyle = cAxis
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()

      // 波形(列は表示範囲に対応)。ゲインを掛けて縦幅を活かす
      ctx.fillStyle = cWave
      const mid = h / 2
      const gain = gainRef.current
      const waveX0 = Math.max(0, Math.ceil(xOf(0))) // 曲の前後の余白には描かない
      const waveX1 = Math.min(peaks.width, Math.floor(xOf(dur)))
      for (let x = waveX0; x < waveX1; x++) {
        const y1 = mid + Math.max(-1, peaks.min[x] * gain) * mid
        const y2 = mid + Math.min(1, peaks.max[x] * gain) * mid
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }

      // 区間外を暗く落として、練習中の区間を浮き上がらせる
      if (endPoint != null) {
        ctx.fillStyle = 'rgba(15, 17, 21, 0.68)'
        const xa = xOf(anchor)
        const xb = xOf(endPoint)
        if (xa > 0) ctx.fillRect(0, 0, xa, h)
        if (xb < w) ctx.fillRect(xb, 0, w - xb, h)
      }

      const zone = activeZoneRef.current
      const grab = grabRef.current
      const visible = (x: number) => x >= -2 && x <= w + 2

      // 縦線は掴めるゾーン側を実線、反対側を細い点線で描く
      const vline = (x: number, color: string, solid: Zone) => {
        ctx.strokeStyle = color
        for (const z of ['top', 'bottom'] as const) {
          const isSolid = z === solid
          ctx.lineWidth = (isSolid ? 2 : 1) * dpr
          ctx.setLineDash(isSolid ? [] : [3 * dpr, 4 * dpr])
          ctx.globalAlpha = isSolid ? 1 : FADED_ALPHA
          ctx.beginPath()
          ctx.moveTo(x, z === 'top' ? 0 : mid)
          ctx.lineTo(x, z === 'top' ? mid : h)
          ctx.stroke()
        }
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }

      // 起点/終点(上半分)と再生ヘッド(下半分)
      // つまみは上部バー・下部ドックに隠れない高さに置く(再生ヘッドは中心線とドックの中間)
      const knobYs = barKnobYs(cssH)
      const dockTop = h - (dockRef.current?.offsetHeight ?? 0) * dpr
      const headKnobY = Math.max(mid + 20 * dpr, (mid + dockTop) / 2)
      const bars: { x: number; y: number; label: string; grab: Grab }[] = [
        { x: xOf(anchor), y: knobYs.anchor * dpr, label: '起点', grab: 'anchor' },
      ]
      if (endPoint != null) bars.push({ x: xOf(endPoint), y: knobYs.end * dpr, label: '終点', grab: 'end' })
      const hx = xOf(pos)

      for (const b of bars) if (visible(b.x)) vline(b.x, cBarKnob, 'top')
      if (visible(hx)) vline(hx, cHeadKnob, 'bottom')

      // 触っていないゾーンのつまみは小さく(区間=丸に矢印, 再生位置=ひし形)
      if (zone !== 'top') {
        for (const b of bars) {
          if (!visible(b.x)) continue
          ctx.fillStyle = cBarKnob
          ctx.beginPath()
          ctx.arc(b.x, b.y, 14 * dpr, 0, Math.PI * 2)
          ctx.fill()
          // 区間の内側を指す三角(起点=右向き, 終点=左向き)
          const dir = b.grab === 'anchor' ? 1 : -1
          ctx.fillStyle = '#0f1115'
          ctx.beginPath()
          ctx.moveTo(b.x + dir * 7 * dpr, b.y)
          ctx.lineTo(b.x - dir * 5 * dpr, b.y - 7 * dpr)
          ctx.lineTo(b.x - dir * 5 * dpr, b.y + 7 * dpr)
          ctx.closePath()
          ctx.fill()
        }
      }
      if (zone !== 'bottom' && visible(hx)) {
        const r = 16 * dpr
        ctx.fillStyle = cHeadKnob
        ctx.beginPath()
        ctx.moveTo(hx, headKnobY - r)
        ctx.lineTo(hx + r, headKnobY)
        ctx.lineTo(hx, headKnobY + r)
        ctx.lineTo(hx - r, headKnobY)
        ctx.closePath()
        ctx.fill()
      }

      // 触っている間は反対側の半分を暗く落とす
      if (zone) {
        ctx.fillStyle = DIM_OTHER_ZONE
        ctx.fillRect(0, zone === 'top' ? mid : 0, w, h - mid)
      }

      // 触っているゾーンのつまみは、何を動かすか読めるようラベル付きタブにする(掴んだものは大きく)
      const tab = (x: number, y: number, text: string, color: string, active: boolean) => {
        const fs = (active ? 17 : 14) * dpr
        ctx.font = `600 ${fs}px system-ui, -apple-system, "Hiragino Sans", sans-serif`
        const bw = ctx.measureText(text).width + 16 * dpr
        const bh = fs + 18 * dpr // 触ったときにつまみより小さくならない高さ
        const bx = Math.max(2 * dpr, Math.min(x - bw / 2, w - bw - 2 * dpr)) // 画面端で切れないよう寄せる
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.roundRect(bx, y - bh / 2, bw, bh, bh / 2)
        ctx.fill()
        ctx.fillStyle = '#0f1115'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, bx + bw / 2, y)
      }
      if (zone === 'top') {
        for (const b of bars) if (visible(b.x)) tab(b.x, b.y, b.label, cBarKnob, grab === b.grab)
      } else if (zone === 'bottom' && visible(hx)) {
        tab(hx, headKnobY, fmt(pos), cHeadKnob, grab === 'head')
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  // ポインタ操作:
  //  1本指 … 上半分: 起点/終点バー付近 → そのバーを移動
  //          下半分: 再生ヘッド付近 → 再生位置を移動
  //          それ以外 → ドラッグでスクロール(パン)、動かさずに離せばタップ操作
  //  2本指 … ピンチでズーム + 中点移動でパン
  //  ホイール … Ctrl でズーム、Shift/横スクロールでパン(PC)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let g: 'none' | 'anchor' | 'end' | 'head' | 'body' | 'pinch' | 'suppress' = 'none'
    let zone: Zone = 'top'
    let downX = 0
    let lastX = 0
    let moved = false

    const rectOf = () => canvas.getBoundingClientRect()
    const secAt = (clientX: number) => {
      const { start, end } = viewRef.current
      const rect = rectOf()
      const dur = stateRef.current.buffer?.duration ?? 0
      const ratio = (clientX - rect.left) / rect.width
      return Math.max(0, Math.min(dur, start + ratio * (end - start)))
    }
    const pxOf = (sec: number) => {
      const { start, end } = viewRef.current
      const rect = rectOf()
      return rect.left + ((sec - start) / (end - start || 1)) * rect.width
    }
    const clampAnchor = (sec: number) => {
      const { endPoint, buffer } = stateRef.current
      const hi = endPoint != null ? endPoint - 0.02 : (buffer?.duration ?? 0)
      return Math.max(0, Math.min(sec, hi))
    }
    const clampEnd = (sec: number) => {
      const { anchor, buffer } = stateRef.current
      return Math.min(buffer?.duration ?? 0, Math.max(sec, anchor + 0.02))
    }
    // 再生位置は起点より後ろ(練習中は区間内)に限る。起点より前だと「区切る」が効かないため
    const clampHead = (sec: number) => {
      const { anchor, endPoint, buffer } = stateRef.current
      const hi = endPoint != null ? endPoint - 0.001 : (buffer?.duration ?? 0)
      return Math.max(anchor, Math.min(sec, hi))
    }
    const zoneAt = (clientY: number): Zone => {
      const rect = rectOf()
      return clientY - rect.top < rect.height / 2 ? 'top' : 'bottom'
    }
    // そのゾーンで掴めるもの(なければ null)
    const grabAt = (clientX: number, clientY: number, z: Zone): Grab | null => {
      const { anchor, endPoint } = stateRef.current
      if (z === 'bottom') {
        return Math.abs(clientX - pxOf(engine.getPosition())) <= HANDLE_HIT_PX ? 'head' : null
      }
      const nearAnchor = Math.abs(clientX - pxOf(anchor)) <= HANDLE_HIT_PX
      const nearEnd = endPoint != null && Math.abs(clientX - pxOf(endPoint)) <= HANDLE_HIT_PX
      if (nearAnchor && nearEnd) {
        // 両方のバーが近いときは、触った高さに近いつまみを掴む
        const rect = rectOf()
        const ys = barKnobYs(rect.height)
        return clientY - rect.top < (ys.anchor + ys.end) / 2 ? 'anchor' : 'end'
      }
      if (nearAnchor) return 'anchor'
      return nearEnd ? 'end' : null
    }

    const startPinch = (xA: number, xB: number) => {
      const rect = rectOf()
      const mid = (xA + xB) / 2
      const { start, end } = viewRef.current
      pinchRef.current = {
        dist0: Math.abs(xA - xB) || 1,
        span0: end - start,
        timeAtMid: start + ((mid - rect.left) / rect.width) * (end - start),
      }
    }
    const updatePinch = () => {
      const xs = [...pointersRef.current.values()]
      const p = pinchRef.current
      if (xs.length < 2 || !p) return
      const rect = rectOf()
      const dist = Math.abs(xs[0] - xs[1]) || 1
      const mid = (xs[0] + xs[1]) / 2
      const span = p.span0 * (p.dist0 / dist) // 指が開く(dist大)→ span縮小=拡大
      const frac = (mid - rect.left) / rect.width
      setView(p.timeAtMid - frac * span, span)
      suppressFollowUntilRef.current = performance.now() + 1200
    }

    const onDown = (e: PointerEvent) => {
      if (!stateRef.current.buffer) return
      pointersRef.current.set(e.pointerId, e.clientX)
      canvas.setPointerCapture(e.pointerId)
      if (pointersRef.current.size === 2) {
        if (g === 'head') onScrubEnd()
        const xs = [...pointersRef.current.values()]
        startPinch(xs[0], xs[1])
        g = 'pinch'
        activeZoneRef.current = null
        grabRef.current = null
        return
      }
      if (pointersRef.current.size !== 1) return
      downX = e.clientX
      lastX = e.clientX
      moved = false
      zone = zoneAt(e.clientY)
      activeZoneRef.current = zone
      const grab = grabAt(e.clientX, e.clientY, zone)
      grabRef.current = grab
      g = grab ?? 'body'
      if (g === 'head') onScrubStart()
    }
    const onMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) {
        // PC のホバー: 掴める位置だけカーソルを変える
        if (e.pointerType === 'mouse' && stateRef.current.buffer) {
          canvas.style.cursor = grabAt(e.clientX, e.clientY, zoneAt(e.clientY)) ? 'ew-resize' : ''
        }
        return
      }
      pointersRef.current.set(e.pointerId, e.clientX)
      if (g === 'pinch') { updatePinch(); return }
      if (g === 'none' || g === 'suppress') return
      if (Math.abs(e.clientX - downX) > 4) moved = true
      const sec = secAt(e.clientX)
      if (g === 'anchor') onMoveAnchor(clampAnchor(sec))
      else if (g === 'end') onMoveEnd(clampEnd(sec))
      else if (g === 'head') onSeek(clampHead(sec))
      else if (g === 'body' && moved) {
        // 1本指ドラッグ = スクロール(パン)。指に波形が付いてくる向き
        const { start, end } = viewRef.current
        const span = end - start
        const rect = rectOf()
        const dx = e.clientX - lastX
        lastX = e.clientX
        setView(start - (dx / rect.width) * span, span)
        suppressFollowUntilRef.current = performance.now() + 1500
      }
    }
    const endPointer = (e: PointerEvent, tap: boolean) => {
      pointersRef.current.delete(e.pointerId)
      try { canvas.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      const remaining = pointersRef.current.size
      if (remaining === 0) {
        activeZoneRef.current = null
        grabRef.current = null
      }
      if (g === 'pinch') {
        if (remaining < 2) pinchRef.current = null
        g = remaining > 0 ? 'suppress' : 'none'
        suppressFollowUntilRef.current = performance.now() + 1200
        return
      }
      if (g === 'suppress') { if (remaining === 0) g = 'none'; return }
      if (g === 'head') onScrubEnd()
      if (tap && g === 'body' && !moved) {
        const sec = secAt(e.clientX)
        // 下半分=再生位置へシーク / 上半分=探索では起点移動、練習ではシーク
        if (zone === 'bottom') onSeek(clampHead(sec))
        else if (stateRef.current.mode === 'explore') onMoveAnchor(clampAnchor(sec))
        else onSeek(sec)
      }
      g = 'none'
    }
    const onUp = (e: PointerEvent) => endPointer(e, true)
    const onCancel = (e: PointerEvent) => endPointer(e, false)

    const onWheel = (e: WheelEvent) => {
      const dur = stateRef.current.buffer?.duration ?? 0
      if (!dur) return
      const { start, end } = viewRef.current
      const span = end - start
      if (e.ctrlKey) {
        e.preventDefault()
        const rect = rectOf()
        const frac = (e.clientX - rect.left) / rect.width
        const timeAt = start + frac * span
        const nspan = span * Math.exp(e.deltaY * 0.0015) // 上スクロール(deltaY<0)で拡大
        setView(timeAt - frac * nspan, nspan)
        suppressFollowUntilRef.current = performance.now() + 1200
      } else if (e.shiftKey || e.deltaX !== 0) {
        e.preventDefault()
        const rect = rectOf()
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY
        setView(start + (dx / rect.width) * span, span)
        suppressFollowUntilRef.current = performance.now() + 1200
      }
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [engine, onSeek, onMoveAnchor, onMoveEnd, onScrubStart, onScrubEnd])

  return <canvas ref={canvasRef} className="waveform" aria-label="波形" />
})
