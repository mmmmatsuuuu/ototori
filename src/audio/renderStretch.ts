// ワーカーを1つ保持し、区間のタイムストレッチ生成を仲介する。
// テンポ/区間のドラッグ中に何度も要求が来るため、常に最新の要求だけを有効とし、
// 古い要求の結果は破棄する(id で判定)。

import type { StretchRequest, StretchResponse } from './stretchWorker'

export type StretchResult = { channels: Float32Array[]; sampleRate: number }

export class StretchRenderer {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (r: StretchResult) => void; reject: (e: Error) => void; sampleRate: number }>()

  constructor() {
    this.worker = new Worker(new URL('./stretchWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<StretchResponse>) => {
      const entry = this.pending.get(e.data.id)
      if (!entry) return // すでに破棄済み(stale)
      this.pending.delete(e.data.id)
      if ('error' in e.data) entry.reject(new Error(e.data.error))
      else entry.resolve({ channels: e.data.channels, sampleRate: entry.sampleRate })
    }
  }

  // 直近の要求のみ有効。これ以前の未解決要求は破棄(cancelled)する。
  render(buffer: AudioBuffer, start: number, end: number, timeRatio: number): Promise<StretchResult> {
    // 進行中の古い要求を破棄
    for (const [, entry] of this.pending) entry.reject(new Error('cancelled'))
    this.pending.clear()

    const id = ++this.seq
    const sampleRate = buffer.sampleRate
    const s = Math.max(0, Math.floor(start * sampleRate))
    const e = Math.min(buffer.length, Math.floor(end * sampleRate))
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      // 区間をコピー(転送するので元バッファは保持したまま独立させる)
      channels.push(buffer.getChannelData(c).slice(s, e))
    }

    const promise = new Promise<StretchResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sampleRate })
    })
    const req: StretchRequest = { id, channels, sampleRate, timeRatio }
    this.worker.postMessage(req, channels.map((v) => v.buffer))
    return promise
  }

  // 進行中の要求をすべて破棄する(結果を使わないと確定したとき)
  cancel() {
    for (const [, entry] of this.pending) entry.reject(new Error('cancelled'))
    this.pending.clear()
  }

  dispose() {
    this.cancel()
    this.worker.terminate()
  }
}
