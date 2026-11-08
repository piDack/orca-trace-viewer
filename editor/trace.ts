export interface Slice {
  name: string
  category: string
  start: number
  duration: number
  pid: string
  tid: string
  args: Record<string, unknown>
}
export interface Track {
  key: string
  label: string
  process: string
  pid: string
  tid: string
  lanes: Slice[][]
}
export interface Trace {
  tracks: Track[]
  start: number
  end: number
  eventCount: number
  skipped: Record<string, number>
}
type Event = Record<string, unknown>
const record = (value: unknown): value is Event => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const threadKey = (pid: string, tid: string) => JSON.stringify([pid, tid])
const id = (value: unknown) => value == null ? '0' : String(value)

// Chrome trace ts/dur are microseconds, including Kineto files with displayTimeUnit: "ns".
export function parseTrace(text: string): Trace {
  let data: unknown
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('Invalid JSON. Check that the trace finished writing, then reopen it.') }
  const events = Array.isArray(data) ? data : record(data) ? data.traceEvents : undefined
  if (!Array.isArray(events)) throw new Error('This JSON is not a Chrome trace. Expected a traceEvents array or an event array. Use Source to view ordinary JSON.')
  const processes = new Map<string, Event>(), threads = new Map<string, Event>()
  const byThread = new Map<string, Slice[]>(), paired = new Map<string, Event[]>()
  const skipped: Record<string, number> = Object.create(null)
  const skip = (phase: string) => { skipped[phase] = (skipped[phase] ?? 0) + 1 }
  let start = Infinity, end = -Infinity, eventCount = 0
  function add(event: Event, duration: number, args = event.args) {
    if (!finite(event.ts) || !finite(duration) || duration < 0 || !finite(event.ts + duration)) { skip('invalid'); return }
    const pid = id(event.pid), tid = id(event.tid), key = threadKey(pid, tid)
    const slice: Slice = { name: String(event.name ?? '(unnamed)'), category: String(event.cat ?? ''),
      start: event.ts, duration, pid, tid, args: record(args) ? args : {} }
    let items = byThread.get(key)
    if (!items) { items = []; byThread.set(key, items) }
    items.push(slice); start = Math.min(start, slice.start); end = Math.max(end, slice.start + slice.duration); eventCount++
  }
  for (const event of events) {
    if (!record(event)) { skip('invalid'); continue }
    const pid = id(event.pid), tid = id(event.tid), key = threadKey(pid, tid), phase = String(event.ph ?? 'invalid')
    if (phase === 'M') {
      if (!record(event.args)) continue
      const name = String(event.name ?? ''), map = name.startsWith('process_') ? processes : threads
      const mapKey = name.startsWith('process_') ? pid : key, metadata = map.get(mapKey) ?? {}
      if (name.endsWith('_name')) metadata.name = event.args.name
      if (name.endsWith('_labels')) metadata.labels = event.args.labels
      if (name.endsWith('_sort_index')) metadata.sort = event.args.sort_index
      map.set(mapKey, metadata)
    } else if (phase === 'X') {
      if (finite(event.dur)) add(event, event.dur); else skip('invalid')
    } else if (phase === 'i' || phase === 'I' || phase === 'R') add(event, 0)
    else if ((phase === 'B' || phase === 'E') && finite(event.ts)) {
      let items = paired.get(key)
      if (!items) { items = []; paired.set(key, items) }
      items.push(event)
    } else skip(phase)
  }
  for (const items of paired.values()) {
    items.sort((a, b) => (a.ts as number) - (b.ts as number))
    const stack: Event[] = []
    for (const event of items) {
      if (event.ph === 'B') stack.push(event)
      else {
        const begin = stack.pop()
        if (begin) add(begin, (event.ts as number) - (begin.ts as number), {
          ...(record(begin.args) ? begin.args : {}), ...(record(event.args) ? event.args : {}),
        }); else skip('unmatched E')
      }
    }
    for (const _ of stack) skip('unmatched B')
  }
  const tracks: Track[] = []
  for (const [key, slices] of byThread) {
    slices.sort((a, b) => a.start - b.start || b.duration - a.duration)
    const lanes: Slice[][] = []
    // Non-overlapping lanes let the renderer binary-search visible intervals. A min-heap
    // reuses the earliest free lane without scanning every nesting level.
    const heap: { end: number; lane: number }[] = []
    for (const slice of slices) {
      let slot = heap[0]
      if (!slot || slot.end > slice.start) {
        slot = { end: slice.start + slice.duration, lane: lanes.length }
        lanes.push([slice]); heap.push(slot)
        let i = heap.length - 1
        while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].end <= slot.end) break; heap[i] = heap[parent]; i = parent }
        heap[i] = slot
      } else {
        lanes[slot.lane].push(slice); slot.end = slice.start + slice.duration
        let i = 0
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1
          if (child + 1 < heap.length && heap[child + 1].end < heap[child].end) child++
          if (heap[child].end >= slot.end) break
          heap[i] = heap[child]; i = child
        }
        heap[i] = slot
      }
    }
    const { pid, tid } = slices[0], process = processes.get(pid)
    tracks.push({ key, pid, tid, lanes, label: String(threads.get(key)?.name ?? `Thread ${tid}`),
      process: [process?.labels, process?.name ?? `Process ${pid}`].filter(Boolean).join(' · ') })
  }
  const sortIndex = (metadata: Event | undefined) => finite(metadata?.sort) ? metadata.sort : 0
  tracks.sort((a, b) => sortIndex(processes.get(a.pid)) - sortIndex(processes.get(b.pid)) ||
    a.pid.localeCompare(b.pid, undefined, { numeric: true }) || sortIndex(threads.get(a.key)) - sortIndex(threads.get(b.key)) ||
    a.tid.localeCompare(b.tid, undefined, { numeric: true }))
  return { tracks, start: eventCount ? start : 0, end: eventCount ? Math.max(end, start + 1) : 1, eventCount, skipped }
}
export function firstVisible(lane: Slice[], time: number): number {
  let low = 0, high = lane.length
  while (low < high) { const mid = (low + high) >>> 1; if (lane[mid].start + lane[mid].duration < time) low = mid + 1; else high = mid }
  return low
}
export const isGPU = (slice: Slice) => /^(kernel|gpu_|cuda_kernel)/i.test(slice.category)
export function formatTime(us: number): string {
  const magnitude = Math.abs(us)
  if (magnitude >= 1e6) return `${(us / 1e6).toFixed(3)} s`
  if (magnitude >= 1e3) return `${(us / 1e3).toFixed(3)} ms`
  return `${Number(us.toFixed(3))} µs`
}
