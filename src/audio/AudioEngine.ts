// Web Audio によるプレイヤー基盤。
// 再生/一時停止/シーク/区間ループ/テンポを担う。
//
// テンポ(ピッチ維持)の方式:
//  - ループON かつ テンポ≠100% のとき、ループ区間だけを Rubberband(WASM) で
//    オフライン生成し、その1本のバッファをネイティブループする(完全ギャップレス+ピッチ維持)。
//  - それ以外(ループOFF、または 100%)は元バッファを直接再生する。
//    ループOFFでのテンポ変更は playbackRate による簡易プレビュー(ピッチも変化)。
// 生成はワーカーで行い、テンポ/区間の変更時にデバウンスして再生成する。

import { StretchRenderer } from './renderStretch'

export type EngineState = 'idle' | 'ready' | 'playing' | 'paused'
export type PrepareState = 'idle' | 'rendering' | 'ready' | 'error'

type Prepared = { buffer: AudioBuffer; src: AudioBuffer; rate: number; start: number; end: number }
type Active = { prepared: false } | { prepared: true; start: number; rate: number; dur: number }

const EPS = 1e-6

export class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null

  private startCtxTime = 0 // 再生開始時の AudioContext 時刻
  private startOffset = 0 // 再生開始位置(原音・秒)。停止中は現在位置を保持
  private active: Active = { prepared: false }

  private _rate = 1
  private _looping = false
  private _loopStart = 0
  private _loopEnd = 0

  private renderer = new StretchRenderer()
  private prepared: Prepared | null = null
  private prepareGen = 0
  private prepareTimer: ReturnType<typeof setTimeout> | null = null

  state: EngineState = 'idle'
  prepareState: PrepareState = 'idle'
  onStateChange?: (s: EngineState) => void
  onPrepareChange?: (s: PrepareState) => void

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }
    return this.ctx
  }

  async load(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureCtx()
    this.stopSource()
    const buf = await ctx.decodeAudioData(data)
    this.buffer = buf
    this.startOffset = 0
    this._loopStart = 0
    this._loopEnd = buf.duration
    this.prepared = null
    this.renderer.cancel()
    this.setPrepareState('idle')
    this.setState('ready')
    return buf
  }

  get duration(): number { return this.buffer?.duration ?? 0 }
  get audioBuffer(): AudioBuffer | null { return this.buffer }
  get rate(): number { return this._rate }
  get looping(): boolean { return this._looping }
  get loopStart(): number { return this._loopStart }
  get loopEnd(): number { return this._loopEnd }

  private setState(s: EngineState) {
    this.state = s
    this.onStateChange?.(s)
  }
  private setPrepareState(s: PrepareState) {
    if (this.prepareState === s) return
    this.prepareState = s
    this.onPrepareChange?.(s)
  }

  setTempo(rate: number) {
    if (rate === this._rate) return
    // 直接再生中はスライダー追従(簡易プレビュー)。位置がずれないよう基準を取り直す
    if (this.state === 'playing' && !this.active.prepared && this.source) {
      this.startOffset = this.getPosition()
      this.startCtxTime = this.ctx!.currentTime
      this.source.playbackRate.value = rate
    }
    this._rate = rate
    this.schedulePrepare()
  }

  setLoop(start: number, end: number) {
    this._loopStart = Math.max(0, Math.min(start, end))
    this._loopEnd = Math.min(this.duration, Math.max(start, end))
    if (this.source && this._looping && this.active.prepared === false) {
      this.source.loopStart = this._loopStart
      this.source.loopEnd = this._loopEnd
    }
    this.schedulePrepare()
  }

  setLooping(on: boolean) {
    this._looping = on
    if (this.state === 'playing') {
      const pos = this.getPosition()
      const restart = on && (pos < this._loopStart || pos > this._loopEnd)
      void this.play(restart ? this._loopStart : pos)
    }
    this.schedulePrepare()
  }

  // ---- 事前レンダリング(prepared-loop) ----

  private needsPrepared(): boolean {
    return !!this.buffer && this._looping && Math.abs(this._rate - 1) > EPS && this._loopEnd - this._loopStart > EPS
  }

  private preparedMatches(): boolean {
    const p = this.prepared
    return !!p && p.src === this.buffer && Math.abs(p.rate - this._rate) < EPS &&
      Math.abs(p.start - this._loopStart) < EPS && Math.abs(p.end - this._loopEnd) < EPS
  }

  private schedulePrepare() {
    if (this.prepareTimer) clearTimeout(this.prepareTimer)
    if (!this.needsPrepared()) {
      this.renderer.cancel()
      this.setPrepareState('idle')
      return
    }
    if (this.preparedMatches()) {
      this.setPrepareState('ready')
      return
    }
    this.prepareTimer = setTimeout(() => { this.prepareTimer = null; void this.ensurePrepared() }, 300)
  }

  private async ensurePrepared() {
    if (!this.needsPrepared() || !this.buffer) return
    if (this.preparedMatches()) { this.setPrepareState('ready'); return }

    const gen = ++this.prepareGen
    const src = this.buffer
    const rate = this._rate
    const start = this._loopStart
    const end = this._loopEnd
    this.setPrepareState('rendering')
    try {
      const { channels, sampleRate } = await this.renderer.render(src, start, end, 1 / rate)
      if (gen !== this.prepareGen) return // 新しい要求に置き換わった
      const ctx = this.ensureCtx()
      const len = channels[0]?.length ?? 0
      if (len === 0) { this.setPrepareState('error'); return }
      const out = ctx.createBuffer(channels.length, len, sampleRate)
      for (let c = 0; c < channels.length; c++) {
        out.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c)
      }
      this.prepared = { buffer: out, src, rate, start, end }
      this.setPrepareState('ready')
      // 再生中で条件が揃っていれば、生成済みバッファへ差し替える
      if (this.state === 'playing' && this.needsPrepared() && this.preparedMatches()) {
        void this.play(this.getPosition())
      }
    } catch (e) {
      if ((e as Error).message === 'cancelled') return
      if (gen !== this.prepareGen) return
      this.setPrepareState('error')
    }
  }

  // ---- 再生 ----

  // バックグラウンド復帰や割り込み(着信など)で AudioContext が
  // suspended のまま戻ることがあるため、明示的に復帰させる。
  async resume(): Promise<void> {
    if (!this.ctx || this.ctx.state !== 'suspended') return
    try { await this.ctx.resume() } catch { /* 解禁にはユーザー操作が要る場合がある */ }
  }

  async play(from?: number): Promise<void> {
    if (!this.buffer) return
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') await ctx.resume()
    this.stopSource()

    if (this.needsPrepared() && this.preparedMatches() && this.prepared) {
      this.playPrepared(from)
    } else {
      this.playDirect(from)
      // 生成が必要なのにまだ無い場合は即座に生成を開始(プレビューしつつ差し替え)
      if (this.needsPrepared() && !this.preparedMatches()) void this.ensurePrepared()
    }
  }

  private playPrepared(from?: number) {
    const ctx = this.ctx!
    const p = this.prepared!
    const src = ctx.createBufferSource()
    src.buffer = p.buffer
    src.loop = true
    src.loopStart = 0
    src.loopEnd = p.buffer.duration
    src.connect(this.gain!)

    // 原音時間の from を生成音側のオフセットへ写像
    let orig = from ?? this.startOffset
    if (orig < p.start || orig >= p.end) orig = p.start
    const stretchedOffset = (orig - p.start) / p.rate

    src.start(0, stretchedOffset)
    this.source = src
    this.startCtxTime = ctx.currentTime - stretchedOffset
    this.startOffset = orig
    this.active = { prepared: true, start: p.start, rate: p.rate, dur: p.buffer.duration }
    this.setState('playing')
  }

  private playDirect(from?: number) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.buffer!
    src.playbackRate.value = this._rate
    src.loop = this._looping
    if (this._looping) {
      src.loopStart = this._loopStart
      src.loopEnd = this._loopEnd
    }
    src.connect(this.gain!)

    let offset = from ?? this.startOffset
    if (this._looping && (offset < this._loopStart || offset >= this._loopEnd)) {
      offset = this._loopStart
    }
    offset = Math.max(0, Math.min(offset, this.buffer!.duration - 0.001))

    src.onended = () => {
      if (this.source === src && !this._looping) {
        this.startOffset = 0
        this.setState('paused')
      }
    }
    src.start(0, offset)
    this.source = src
    this.startCtxTime = ctx.currentTime
    this.startOffset = offset
    this.active = { prepared: false }
    this.setState('playing')
  }

  pause() {
    if (this.state !== 'playing') return
    this.startOffset = this.getPosition()
    this.stopSource()
    this.setState('paused')
  }

  stop() {
    this.stopSource()
    this.startOffset = this._looping ? this._loopStart : 0
    this.setState('ready')
  }

  seek(pos: number) {
    this.startOffset = Math.max(0, Math.min(pos, this.duration))
    if (this.state === 'playing') void this.play(this.startOffset)
  }

  private stopSource() {
    if (this.source) {
      this.source.onended = null
      try { this.source.stop() } catch { /* already stopped */ }
      this.source.disconnect()
      this.source = null
    }
  }

  getPosition(): number {
    if (!this.buffer) return 0
    if (this.state !== 'playing' || !this.ctx) return this.startOffset

    if (this.active.prepared) {
      const { start, rate, dur } = this.active
      const elapsedStretched = ((this.ctx.currentTime - this.startCtxTime) % dur + dur) % dur
      return start + elapsedStretched * rate
    }

    const elapsed = (this.ctx.currentTime - this.startCtxTime) * this._rate
    let pos = this.startOffset + elapsed
    if (this._looping) {
      const len = this._loopEnd - this._loopStart
      if (len > 0) pos = this._loopStart + (((pos - this._loopStart) % len) + len) % len
    } else if (pos > this.buffer.duration) {
      pos = this.buffer.duration
    }
    return pos
  }

  dispose() {
    this.stopSource()
    if (this.prepareTimer) clearTimeout(this.prepareTimer)
    this.renderer.dispose()
  }
}
