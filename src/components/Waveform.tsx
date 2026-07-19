import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'

export type WaveMode = 'explore' | 'practice'

// 「全体表示」はメニュー側にあるため、外部から呼べるように公開する
export type WaveformHandle = { resetView: () => void }

type Props = {
  engine: AudioEngine
  buffer: AudioBuffer | null
  mode: WaveMode
  anchor: number // 起点
  endPoint: number | null // 終点(練習モードのみ)
  onSeek: (sec: number) => void
  onMoveAnchor: (sec: number) => void
  onMoveEnd: (sec: number) => void
  onZoomedChange?: (zoomed: boolean) => void
}

type Peaks = { min: Float32Array; max: Float32Array; width: number; vs: number; ve: number; buffer: AudioBuffer }

// 表示範囲[startSample,endSample]を width 列の min/max ピークに畳む(重いのでキャッシュ)
function computePeaks(buffer: AudioBuffer, width: number, startSample: number, endSample: number): Peaks {
  const data = buffer.getChannelData(0)
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  const s = Math.max(0, Math.min(startSample, data.length))
  const e = Math.max(s, Math.min(endSample, data.length))
  const step = (e - s) / width
  for (let x = 0; x < width; x++) {
    const a = Math.floor(s + x * step)
    const b = Math.min(data.length, Math.max(a + 1, Math.floor(s + (x + 1) * step)))
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

const HANDLE_HIT_PX = 14
const MIN_SPAN = 0.03 // 最大ズーム時の表示秒数

export const Waveform = forwardRef<WaveformHandle, Props>(function Waveform(
  { engine, buffer, mode, anchor, endPoint, onSeek, onMoveAnchor, onMoveEnd, onZoomedChange },
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

  // ズーム状態が変わったときだけ通知(ピンチ中の再レンダーを避ける)
  const syncZoomed = (span: number, dur: number) => {
    const z = span < dur - 1e-4
    if (z !== zoomedRef.current) {
      zoomedRef.current = z
      onZoomedChangeRef.current?.(z)
    }
  }

  const resetView = () => {
    const dur = stateRef.current.buffer?.duration ?? 0
    viewRef.current = { start: 0, end: dur }
    syncZoomed(dur, dur)
  }
  useImperativeHandle(ref, () => ({ resetView }), [])

  // バッファが変わったら全体表示にリセットし、表示ゲインを求め直す
  useEffect(() => {
    const dur = buffer?.duration ?? 0
    viewRef.current = { start: 0, end: dur }
    pointersRef.current.clear()
    pinchRef.current = null
    syncZoomed(dur, dur)

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
      const cHead = style.getPropertyValue('--head').trim() || '#f0997b'
      const cAxis = style.getPropertyValue('--axis').trim() || 'rgba(255,255,255,0.15)'

      if (!buffer) {
        raf = requestAnimationFrame(draw)
        return
      }
      const dur = buffer.duration
      const pos = engine.getPosition()

      // 再生ヘッド自動追従(再生中・ズーム中・無操作時のみ)
      let { start: vs, end: ve } = viewRef.current
      let span = ve - vs
      if (
        engine.state === 'playing' && span < dur - 1e-6 &&
        pointersRef.current.size === 0 && performance.now() > suppressFollowUntilRef.current &&
        (pos < vs || pos > ve)
      ) {
        vs = Math.max(0, Math.min(pos - 0.05 * span, dur - span))
        ve = vs + span
        viewRef.current = { start: vs, end: ve }
      }
      span = ve - vs || dur
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
      for (let x = 0; x < peaks.width; x++) {
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

      // 起点/終点マーカー。つまみは上部バーに隠れない高さに置く
      const knobY = Math.max(74 * dpr, h * 0.22)
      const marker = (sec: number) => {
        const x = xOf(sec)
        if (x < -2 || x > w + 2) return
        ctx.strokeStyle = cWave
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillStyle = cWave
        ctx.beginPath()
        ctx.arc(x, knobY, 7 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }
      marker(anchor)
      if (endPoint != null) marker(endPoint)

      // 再生ヘッド
      const hx = xOf(pos)
      if (hx >= -2 && hx <= w + 2) {
        ctx.strokeStyle = cHead
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.moveTo(hx, 0)
        ctx.lineTo(hx, h)
        ctx.stroke()
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  // ポインタ操作:
  //  1本指 → 従来操作(タップ=シーク/起点移動、ハンドル=微調整)
  //  2本指 → ピンチでズーム + ドラッグでパン
  //  ホイール → Ctrl でズーム、Shift/横スクロールでパン(PC)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let g: 'none' | 'anchor' | 'end' | 'body' | 'pinch' | 'suppress' = 'none'
    let downX = 0
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
    const setView = (start: number, span: number) => {
      const dur = stateRef.current.buffer?.duration ?? 0
      const sp = Math.max(Math.min(MIN_SPAN, dur), Math.min(span, dur))
      const st = Math.max(0, Math.min(start, dur - sp))
      viewRef.current = { start: st, end: st + sp }
      syncZoomed(sp, dur)
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
        const xs = [...pointersRef.current.values()]
        startPinch(xs[0], xs[1])
        g = 'pinch'
        return
      }
      if (pointersRef.current.size !== 1) return
      downX = e.clientX
      moved = false
      const { anchor, endPoint } = stateRef.current
      if (Math.abs(e.clientX - pxOf(anchor)) <= HANDLE_HIT_PX) g = 'anchor'
      else if (endPoint != null && Math.abs(e.clientX - pxOf(endPoint)) <= HANDLE_HIT_PX) g = 'end'
      else g = 'body'
    }
    const onMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return
      pointersRef.current.set(e.pointerId, e.clientX)
      if (g === 'pinch') { updatePinch(); return }
      if (g === 'none' || g === 'suppress') return
      if (Math.abs(e.clientX - downX) > 4) moved = true
      const sec = secAt(e.clientX)
      if (g === 'anchor') onMoveAnchor(clampAnchor(sec))
      else if (g === 'end') onMoveEnd(clampEnd(sec))
      else if (g === 'body' && moved) {
        if (stateRef.current.mode === 'explore') onMoveAnchor(clampAnchor(sec))
        else onSeek(sec)
      }
    }
    const endPointer = (e: PointerEvent, tap: boolean) => {
      pointersRef.current.delete(e.pointerId)
      try { canvas.releasePointerCapture(e.pointerId) } catch { /* noop */ }
      const remaining = pointersRef.current.size
      if (g === 'pinch') {
        if (remaining < 2) pinchRef.current = null
        g = remaining > 0 ? 'suppress' : 'none'
        suppressFollowUntilRef.current = performance.now() + 1200
        return
      }
      if (g === 'suppress') { if (remaining === 0) g = 'none'; return }
      if (tap && g === 'body' && !moved) {
        const sec = secAt(e.clientX)
        if (stateRef.current.mode === 'explore') onMoveAnchor(clampAnchor(sec))
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
  }, [onSeek, onMoveAnchor, onMoveEnd])

  return <canvas ref={canvasRef} className="waveform" aria-label="波形" />
})
