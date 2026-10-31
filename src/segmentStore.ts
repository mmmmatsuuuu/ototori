// 記録した区間をファイルごとに localStorage へ保存する(音源そのものは保存しない)

export type SavedSegment = { no: number; start: number; end: number; tempo: number }
// nextNo を持つのは、削除で空いた番号を再利用しない(番号と区間の対応を変えない)ため
export type SegmentRecords = { nextNo: number; segments: SavedSegment[] }

const KEY_PREFIX = 'ototori:segments:'
const SAMPLE_BYTES = 1 << 18 // 指紋の計算に使う最大バイト数(長尺でも読込を遅くしないため間引く)

export const emptyRecords = (): SegmentRecords => ({ nextNo: 1, segments: [] })

// ファイルの指紋(サイズ + 間引いたバイト列の FNV-1a)。
// 改名しても同じファイルとして扱い、同名の別ファイルとは区別する。
// crypto.subtle は HTTPS 限定で LAN の開発環境で使えないため自前で計算する。
export function fingerprint(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  const stride = Math.max(1, Math.floor(bytes.length / SAMPLE_BYTES))
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += stride) {
    hash = Math.imul(hash ^ bytes[i], 0x01000193)
  }
  return `${bytes.length}-${(hash >>> 0).toString(16)}`
}

export function loadRecords(fileId: string): SegmentRecords {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + fileId)
    if (!raw) return emptyRecords()
    const parsed = JSON.parse(raw) as SegmentRecords
    if (typeof parsed.nextNo !== 'number' || !Array.isArray(parsed.segments)) return emptyRecords()
    return parsed
  } catch {
    return emptyRecords()
  }
}

// 保存できたかを返す(プライベートブラウズや容量超過で失敗することがある)
export function saveRecords(fileId: string, records: SegmentRecords): boolean {
  try {
    if (records.segments.length === 0) localStorage.removeItem(KEY_PREFIX + fileId)
    else localStorage.setItem(KEY_PREFIX + fileId, JSON.stringify(records))
    return true
  } catch {
    return false
  }
}

export function addSegment(records: SegmentRecords, seg: Omit<SavedSegment, 'no'>): SegmentRecords {
  return {
    nextNo: records.nextNo + 1,
    segments: [...records.segments, { ...seg, no: records.nextNo }],
  }
}

export function removeSegment(records: SegmentRecords, no: number): SegmentRecords {
  const segments = records.segments.filter((s) => s.no !== no)
  // 空になったら番号も #1 に戻す
  return segments.length === 0 ? emptyRecords() : { ...records, segments }
}

// 同じ区間・テンポの記録を探す(二重に記録しないため)
export function findSame(records: SegmentRecords, start: number, end: number, tempo: number): SavedSegment | undefined {
  return records.segments.find(
    (s) => Math.abs(s.start - start) < 0.005 && Math.abs(s.end - end) < 0.005 && Math.abs(s.tempo - tempo) < 0.005,
  )
}
