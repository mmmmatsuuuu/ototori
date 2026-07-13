import { useEffect, useRef } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'

export type WaveMode = 'explore' | 'practice'

type Props = {
  engine: AudioEngine
  buffer: AudioBuffer | null
  mode: WaveMode
  anchor: number // 起点
  endPoint: number | null // 終点(練習モードのみ)
  onSeek: (sec: number) => void
  onMoveAnchor: (sec: number) => void
  onMoveEnd: (sec: number) => void
}

type Peaks = { min: Float32Array; max: Float32Array; width: number; buffer: AudioBuffer }

// バッファから列ごとの min/max ピークを計算(重いのでキャッシュする)
function computePeaks(buffer: AudioBuffer, width: number): Peaks {
  const data = buffer.getChannelData(0)
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  const step = data.length / width
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * step)
    const end = Math.min(data.length, Math.floor((x + 1) * step))
    let lo = 1
    let hi = -1
    for (let i = start; i < end; i++) {
      const v = data[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[x] = lo
    max[x] = hi
  }
  return { min, max, width, buffer }
}

const HANDLE_HIT_PX = 14

export function Waveform({ engine, buffer, mode, anchor, endPoint, onSeek, onMoveAnchor, onMoveEnd }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peaks | null>(null)
  // 最新の props をアニメーションループ/ポインタ処理から参照するための ref
  const stateRef = useRef({ buffer, mode, anchor, endPoint })
  stateRef.current = { buffer, mode, anchor, endPoint }

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
      const cLoop = style.getPropertyValue('--loop').trim() || 'rgba(93,202,165,0.16)'
      const cHead = style.getPropertyValue('--head').trim() || '#f0997b'
      const cAxis = style.getPropertyValue('--axis').trim() || 'rgba(255,255,255,0.15)'

      if (!buffer) {
        raf = requestAnimationFrame(draw)
        return
      }
      const dur = buffer.duration
      const xOf = (sec: number) => (sec / dur) * w

      // ピークのキャッシュ(バッファor幅が変わったら再計算)
      if (!peaksRef.current || peaksRef.current.buffer !== buffer || peaksRef.current.width !== w) {
        peaksRef.current = computePeaks(buffer, w)
      }
      const peaks = peaksRef.current

      // 区間の塗り(終点が確定しているとき)
      if (endPoint != null) {
        ctx.fillStyle = cLoop
        ctx.fillRect(xOf(anchor), 0, xOf(endPoint) - xOf(anchor), h)
      }

      // 中心線
      ctx.strokeStyle = cAxis
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()

      // 波形
      ctx.fillStyle = cWave
      const mid = h / 2
      for (let x = 0; x < peaks.width; x++) {
        const y1 = mid + peaks.min[x] * mid
        const y2 = mid + peaks.max[x] * mid
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }

      // 起点マーカー(常時) + 終点マーカー(あれば)
      const marker = (sec: number, withKnob: boolean) => {
        const x = xOf(sec)
        ctx.strokeStyle = cWave
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        if (withKnob) {
          ctx.fillStyle = cWave
          ctx.beginPath()
          ctx.arc(x, 10 * dpr, 5 * dpr, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      marker(anchor, true)
      if (endPoint != null) marker(endPoint, true)

      // 再生ヘッド
      const pos = engine.getPosition()
      ctx.strokeStyle = cHead
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.moveTo(xOf(pos), 0)
      ctx.lineTo(xOf(pos), h)
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [engine])

  // ポインタ操作:
  //  - 起点/終点ハンドル付近のドラッグ → その点を移動
  //  - それ以外(本体): 探索モードは起点を移動、練習モードはシーク
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let hit: 'none' | 'anchor' | 'end' | 'body' = 'none'
    let downX = 0
    let moved = false

    const secAt = (clientX: number) => {
      const rect = canvas.getBoundingClientRect()
      const dur = stateRef.current.buffer?.duration ?? 0
      const ratio = (clientX - rect.left) / rect.width
      return Math.max(0, Math.min(dur, ratio * dur))
    }
    const pxOf = (sec: number) => {
      const rect = canvas.getBoundingClientRect()
      const dur = stateRef.current.buffer?.duration ?? 1
      return (sec / dur) * rect.width + rect.left
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

    const onDown = (e: PointerEvent) => {
      if (!stateRef.current.buffer) return
      canvas.setPointerCapture(e.pointerId)
      downX = e.clientX
      moved = false
      const { anchor, endPoint } = stateRef.current
      if (Math.abs(e.clientX - pxOf(anchor)) <= HANDLE_HIT_PX) hit = 'anchor'
      else if (endPoint != null && Math.abs(e.clientX - pxOf(endPoint)) <= HANDLE_HIT_PX) hit = 'end'
      else hit = 'body'
    }
    const onMove = (e: PointerEvent) => {
      if (hit === 'none') return
      if (Math.abs(e.clientX - downX) > 4) moved = true
      const sec = secAt(e.clientX)
      if (hit === 'anchor') onMoveAnchor(clampAnchor(sec))
      else if (hit === 'end') onMoveEnd(clampEnd(sec))
      else if (moved) {
        if (stateRef.current.mode === 'explore') onMoveAnchor(clampAnchor(sec))
        else onSeek(sec)
      }
    }
    const onUp = (e: PointerEvent) => {
      if (hit === 'body' && !moved) {
        const sec = secAt(e.clientX)
        if (stateRef.current.mode === 'explore') onMoveAnchor(clampAnchor(sec))
        else onSeek(sec)
      }
      hit = 'none'
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
    }
  }, [onSeek, onMoveAnchor, onMoveEnd])

  return <canvas ref={canvasRef} className="waveform" aria-label="波形" />
}
