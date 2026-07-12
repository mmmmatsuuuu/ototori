import { useEffect, useRef } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'

type Props = {
  engine: AudioEngine
  buffer: AudioBuffer | null
  loopStart: number
  loopEnd: number
  loopEnabled: boolean
  onSeek: (sec: number) => void
  onSetLoop: (start: number, end: number) => void
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

const HANDLE_HIT_PX = 12

export function Waveform({ engine, buffer, loopStart, loopEnd, loopEnabled, onSeek, onSetLoop }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peaks | null>(null)
  // 最新の props をアニメーションループから参照するための ref
  const stateRef = useRef({ buffer, loopStart, loopEnd, loopEnabled })
  stateRef.current = { buffer, loopStart, loopEnd, loopEnabled }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0

    const draw = () => {
      const { buffer, loopStart, loopEnd, loopEnabled } = stateRef.current
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

      // ループ範囲の塗り
      if (loopEnabled) {
        ctx.fillStyle = cLoop
        ctx.fillRect(xOf(loopStart), 0, xOf(loopEnd) - xOf(loopStart), h)
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

      // ループ境界ハンドル
      for (const [sec, color] of [[loopStart, cWave], [loopEnd, cWave]] as const) {
        ctx.strokeStyle = color
        ctx.lineWidth = 2 * dpr
        ctx.beginPath()
        ctx.moveTo(xOf(sec), 0)
        ctx.lineTo(xOf(sec), h)
        ctx.stroke()
      }

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

  // ポインタ操作: クリック=シーク、ドラッグ=範囲選択、境界付近=ハンドル移動
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let mode: 'none' | 'seek' | 'start' | 'end' | 'select' = 'none'
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

    const onDown = (e: PointerEvent) => {
      if (!stateRef.current.buffer) return
      canvas.setPointerCapture(e.pointerId)
      downX = e.clientX
      moved = false
      const { loopStart, loopEnd } = stateRef.current
      if (Math.abs(e.clientX - pxOf(loopStart)) <= HANDLE_HIT_PX) mode = 'start'
      else if (Math.abs(e.clientX - pxOf(loopEnd)) <= HANDLE_HIT_PX) mode = 'end'
      else mode = 'seek'
    }
    const onMove = (e: PointerEvent) => {
      if (mode === 'none') return
      if (Math.abs(e.clientX - downX) > 4) moved = true
      const sec = secAt(e.clientX)
      const { loopStart, loopEnd } = stateRef.current
      if (mode === 'start') onSetLoop(Math.min(sec, loopEnd - 0.02), loopEnd)
      else if (mode === 'end') onSetLoop(loopStart, Math.max(sec, loopStart + 0.02))
      else if (mode === 'seek' && moved) {
        mode = 'select'
        onSetLoop(secAt(downX), sec)
      } else if (mode === 'select') {
        onSetLoop(secAt(downX), sec)
      }
    }
    const onUp = (e: PointerEvent) => {
      if (mode === 'seek' && !moved) onSeek(secAt(e.clientX))
      mode = 'none'
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
    }
  }, [onSeek, onSetLoop])

  return <canvas ref={canvasRef} className="waveform" aria-label="波形" />
}
