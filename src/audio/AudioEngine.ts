// Web Audio によるプレイヤー基盤。
// マイルストーン1では再生/一時停止/シーク/区間ループ/テンポ変更を担う。
// ※ テンポは現状 playbackRate による暫定実装（ピッチも変化する）。
//   次の段階で Rubberband(WASM) の事前レンダリング方式に差し替える。

export type EngineState = 'idle' | 'ready' | 'playing' | 'paused'

export class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null

  private startCtxTime = 0 // 再生開始時の AudioContext 時刻
  private startOffset = 0 // 再生開始位置(秒)。停止中は現在位置を保持

  private _rate = 1
  private _looping = false
  private _loopStart = 0
  private _loopEnd = 0

  state: EngineState = 'idle'
  onStateChange?: (s: EngineState) => void

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

  setTempo(rate: number) {
    this._rate = rate
    if (this.source) this.source.playbackRate.value = rate
  }

  setLoop(start: number, end: number) {
    this._loopStart = Math.max(0, Math.min(start, end))
    this._loopEnd = Math.min(this.duration, Math.max(start, end))
    if (this.source && this._looping) {
      this.source.loopStart = this._loopStart
      this.source.loopEnd = this._loopEnd
    }
  }

  setLooping(on: boolean) {
    this._looping = on
    if (this.state === 'playing') {
      const pos = this.getPosition()
      const restart = on && (pos < this._loopStart || pos > this._loopEnd)
      void this.play(restart ? this._loopStart : pos)
    }
  }

  async play(from?: number): Promise<void> {
    if (!this.buffer) return
    const ctx = this.ensureCtx()
    if (ctx.state === 'suspended') await ctx.resume()
    this.stopSource()

    const src = ctx.createBufferSource()
    src.buffer = this.buffer
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
    offset = Math.max(0, Math.min(offset, this.buffer.duration - 0.001))

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
}
