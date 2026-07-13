// Rubberband(WASM) によるオフライン・タイムストレッチをワーカー内で実行する。
// メインスレッドをブロックしないため、重い study/process はここで回す。
// 単スレッド版 WASM なので SharedArrayBuffer / COOP-COEP は不要。

import { RubberBandInterface, RubberBandOption } from 'rubberband-wasm'
import wasmUrl from 'rubberband-wasm/dist/rubberband.wasm?url'

export type StretchRequest = {
  id: number
  channels: Float32Array[] // 区間の各チャンネル波形(原音)
  sampleRate: number
  timeRatio: number // 出力長 / 入力長。0.5倍速なら 2.0
}

export type StretchResponse =
  | { id: number; channels: Float32Array[] }
  | { id: number; error: string }

let apiPromise: Promise<RubberBandInterface> | null = null
function getApi(): Promise<RubberBandInterface> {
  if (!apiPromise) {
    apiPromise = WebAssembly.compileStreaming(fetch(wasmUrl)).then((mod) =>
      RubberBandInterface.initialize(mod),
    )
  }
  return apiPromise
}

// 高音質なオフライン設定: R3(Finer) エンジン + 高品質ピッチ。
// ピッチは据え置き(scale=1)なのでフォルマント保持は不要。
const OFFLINE_OPTIONS =
  RubberBandOption.RubberBandOptionProcessOffline |
  RubberBandOption.RubberBandOptionEngineFiner |
  RubberBandOption.RubberBandOptionPitchHighQuality

function stretch(
  api: RubberBandInterface,
  channels: Float32Array[],
  sampleRate: number,
  timeRatio: number,
): Float32Array[] {
  const channelCount = channels.length
  const inputLen = channels[0].length

  const state = api.rubberband_new(sampleRate, channelCount, OFFLINE_OPTIONS, timeRatio, 1)
  try {
    api.rubberband_set_time_ratio(state, timeRatio)
    api.rubberband_set_expected_input_duration(state, inputLen)
    const block = api.rubberband_get_samples_required(state)

    // float** レイアウト: チャンネルポインタ配列 + 各チャンネルのブロックバッファ
    const channelArrayPtr = api.malloc(channelCount * 4)
    const channelDataPtr: number[] = []
    for (let c = 0; c < channelCount; c++) {
      const ptr = api.malloc(block * 4)
      channelDataPtr.push(ptr)
      api.memWritePtr(channelArrayPtr + c * 4, ptr)
    }

    // 余裕を持たせて確保し、最後に実際の書き込み長へ切り詰める
    const outCapacity = Math.ceil(inputLen * timeRatio) + block + 8192
    const output = channels.map(() => new Float32Array(outCapacity))
    let write = 0

    const drain = (final: boolean) => {
      for (;;) {
        const available = api.rubberband_available(state)
        if (available < 1) break
        if (!final && available < block) break
        const recv = api.rubberband_retrieve(state, channelArrayPtr, Math.min(block, available))
        for (let c = 0; c < channelCount; c++) {
          output[c].set(api.memReadF32(channelDataPtr[c], recv), write)
        }
        write += recv
      }
    }

    // study パス: 全入力を先に解析する(オフラインモードの要件)
    let read = 0
    while (read < inputLen) {
      const remaining = Math.min(block, inputLen - read)
      for (let c = 0; c < channelCount; c++) {
        api.memWrite(channelDataPtr[c], channels[c].subarray(read, read + remaining))
      }
      read += remaining
      api.rubberband_study(state, channelArrayPtr, remaining, read >= inputLen ? 1 : 0)
    }

    // process パス: 全入力を流し込みつつ出力を回収する
    read = 0
    while (read < inputLen) {
      const remaining = Math.min(block, inputLen - read)
      for (let c = 0; c < channelCount; c++) {
        api.memWrite(channelDataPtr[c], channels[c].subarray(read, read + remaining))
      }
      read += remaining
      api.rubberband_process(state, channelArrayPtr, remaining, read >= inputLen ? 1 : 0)
      drain(false)
    }
    drain(true)

    for (const ptr of channelDataPtr) api.free(ptr)
    api.free(channelArrayPtr)

    return output.map((buf) => buf.subarray(0, write))
  } finally {
    api.rubberband_delete(state)
  }
}

self.onmessage = async (e: MessageEvent<StretchRequest>) => {
  const { id, channels, sampleRate, timeRatio } = e.data
  try {
    const api = await getApi()
    const out = stretch(api, channels, sampleRate, timeRatio)
    // subarray はビュー。転送のため独立した ArrayBuffer にコピーする
    const detached = out.map((v) => v.slice())
    ;(self as unknown as Worker).postMessage(
      { id, channels: detached } satisfies StretchResponse,
      detached.map((v) => v.buffer),
    )
  } catch (err) {
    const msg: StretchResponse = { id, error: (err as Error).message }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
