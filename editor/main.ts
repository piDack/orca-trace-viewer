import type { EditorContent } from 'orca/frame'
import { readText, start } from './sync'
import { firstVisible, formatTime, isGPU, parseTrace, type Slice, type Trace, type Track } from './trace'

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const viewport = get<HTMLDivElement>('viewport'), canvas = get<HTMLCanvasElement>('timeline')
const ctx = canvas.getContext('2d')!
const search = get<HTMLInputElement>('search'), filter = get<HTMLSelectElement>('filter'), tooltip = get<HTMLDivElement>('tooltip')
const RULER = 28, ROW = 22, HEADING = 27
type Row = { y: number; track: Track; lane?: Slice[] }
type Hit = { x: number; y: number; width: number; slice: Slice }
let trace: Trace | undefined, rows: Row[] = [], hits: Hit[] = []
let viewStart = 0, viewEnd = 1, totalHeight = 0, width = 0, height = 0, gutter = 220
let selection: Slice | undefined, matches: Slice[] = [], matchIndex = -1
let frame = 0, loadVersion = 0
const colors = { background: '#141921', foreground: '#dce4ef', muted: '#94a3b8', border: '#303b49', card: '#202936' }

function requestDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() }) }
function readTheme() {
  const style = getComputedStyle(document.documentElement)
  for (const key of Object.keys(colors) as (keyof typeof colors)[]) {
    colors[key] = style.getPropertyValue(`--orca-${key === 'muted' ? 'muted-foreground' : key}`).trim() || colors[key]
  }
  requestDraw()
}
function allowed(slice: Slice) { return filter.value === 'all' || (filter.value === 'gpu' ? isGPU(slice) : !isGPU(slice)) }
function rebuildRows() {
  rows = []; totalHeight = 0
  for (const track of trace?.tracks ?? []) {
    const lanes = track.lanes.map(lane => filter.value === 'all' ? lane : lane.filter(allowed)).filter(lane => lane.length)
    if (!lanes.length) continue
    rows.push({ y: totalHeight, track }); totalHeight += HEADING
    for (const lane of lanes) { rows.push({ y: totalHeight, track, lane }); totalHeight += ROW }
  }
  get('spacer').style.height = `${Math.max(0, totalHeight + RULER - height)}px`
  requestDraw()
}
function resize() {
  width = viewport.clientWidth; height = viewport.clientHeight
  gutter = Math.min(250, Math.max(120, width * 0.26))
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  get('spacer').style.height = `${Math.max(0, totalHeight + RULER - height)}px`
  requestDraw()
}
function setView(start: number, end: number) {
  if (!trace) return
  const span = Math.min(trace.end - trace.start, Math.max(1, end - start))
  viewStart = Math.max(trace.start, Math.min(start, trace.end - span)); viewEnd = viewStart + span
  requestDraw()
}
function zoom(factor: number, fraction = 0.5) {
  const span = viewEnd - viewStart, anchor = viewStart + span * fraction
  setView(anchor - span * factor * fraction, anchor + span * factor * (1 - fraction))
}
function fit() { if (trace) setView(trace.start, trace.end) }
function color(slice: Slice) {
  if (isGPU(slice)) return slice.category.includes('mem') ? '#fbbf77' : '#80d7b4'
  if (/cuda/.test(slice.category)) return '#b7a1ed'
  if (/annotation/.test(slice.category)) return '#f3bc70'
  let hash = 0
  for (let i = 0; i < slice.name.length; i++) hash = (hash * 31 + slice.name.charCodeAt(i)) | 0
  return ['#7ebcf2', '#91b2eb', '#80cdd4', '#b5b8ed', '#94c9e9'][Math.abs(hash) % 5]
}
function draw() {
  hits = []
  ctx.fillStyle = colors.background; ctx.fillRect(0, 0, width, height)
  if (!trace || !width || !height) return
  const span = viewEnd - viewStart, scale = (width - gutter) / span, scroll = viewport.scrollTop
  const query = search.value.trim().toLowerCase()
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif'; ctx.textBaseline = 'middle'
  const rawStep = span / Math.max(1, (width - gutter) / 110), base = 10 ** Math.floor(Math.log10(rawStep))
  const step = [1, 2, 5, 10].find(n => n * base >= rawStep)! * base
  const firstTick = Math.ceil((viewStart - trace.start) / step) * step
  ctx.strokeStyle = colors.border; ctx.lineWidth = 0.5
  for (let t = firstTick; t <= viewEnd - trace.start; t += step) {
    const x = gutter + (trace.start + t - viewStart) * scale
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, height); ctx.stroke()
  }
  ctx.save(); ctx.beginPath(); ctx.rect(0, RULER, width, height - RULER); ctx.clip()
  for (const row of rows) {
    const y = row.y + RULER - scroll, rowHeight = row.lane ? ROW : HEADING
    if (y + rowHeight < RULER || y > height) continue
    ctx.fillStyle = row.lane ? colors.background : colors.card; ctx.fillRect(0, y, row.lane ? gutter : width, rowHeight)
    ctx.save(); ctx.beginPath(); ctx.rect(0, y, gutter - 6, rowHeight); ctx.clip()
    ctx.fillStyle = row.lane ? colors.muted : colors.foreground
    ctx.fillText(row.lane ? row.track.label : row.track.process, 10, y + rowHeight / 2); ctx.restore()
    if (!row.lane) continue
    let lastPixel = -Infinity
    for (let i = firstVisible(row.lane, viewStart); i < row.lane.length; i++) {
      const slice = row.lane[i]
      if (slice.start > viewEnd) break
      const x = Math.max(gutter, gutter + (slice.start - viewStart) * scale)
      const right = Math.min(width, gutter + (slice.start + slice.duration - viewStart) * scale), barWidth = Math.max(1, right - x)
      if (barWidth <= 1 && Math.floor(x) === lastPixel && slice !== selection) continue
      lastPixel = Math.floor(x)
      const matched = !query || slice.name.toLowerCase().includes(query) || slice.category.toLowerCase().includes(query)
      ctx.globalAlpha = matched || slice === selection ? 1 : 0.18
      ctx.fillStyle = color(slice); ctx.fillRect(x, y + 2, barWidth, ROW - 4)
      if (barWidth > 30) {
        ctx.save(); ctx.beginPath(); ctx.rect(x + 3, y + 2, barWidth - 6, ROW - 4); ctx.clip()
        ctx.fillStyle = '#172033'; ctx.fillText(slice.name, x + 4, y + ROW / 2); ctx.restore()
      }
      ctx.globalAlpha = 1
      if (slice === selection) { ctx.strokeStyle = colors.foreground; ctx.lineWidth = 2; ctx.strokeRect(x, y + 1, barWidth, ROW - 2) }
      hits.push({ x, y, width: barWidth, slice })
    }
  }
  ctx.restore()
  ctx.fillStyle = colors.card; ctx.fillRect(0, 0, width, RULER)
  ctx.fillStyle = colors.muted; ctx.fillText('PROCESS / THREAD', 10, RULER / 2)
  ctx.save(); ctx.beginPath(); ctx.rect(gutter, 0, width - gutter, RULER); ctx.clip()
  for (let t = firstTick; t <= viewEnd - trace.start; t += step) ctx.fillText(formatTime(t), gutter + (trace.start + t - viewStart) * scale + 5, RULER / 2)
  ctx.restore(); ctx.strokeStyle = colors.border; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(gutter, 0); ctx.lineTo(gutter, height); ctx.stroke()
  get('range').textContent = `${formatTime(viewStart - trace.start)} – ${formatTime(viewEnd - trace.start)}`
}
function showSelection(slice?: Slice) {
  selection = slice
  const info = get('event-info'); info.replaceChildren()
  get('arguments').textContent = slice ? JSON.stringify(slice.args, null, 2) : ''
  if (!slice) { info.textContent = 'Select an event to inspect its duration and arguments.'; requestDraw(); return }
  const title = document.createElement('b'); title.textContent = slice.name; info.append(title)
  const list = document.createElement('dl')
  for (const [label, value] of [['Category', slice.category || '—'], ['Start', formatTime(slice.start - (trace?.start ?? 0))],
    ['Duration', formatTime(slice.duration)], ['PID / TID', `${slice.pid} / ${slice.tid}`]]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd')
    dt.textContent = label; dd.textContent = value; list.append(dt, dd)
  }
  info.append(list); requestDraw()
}
function focus(slice: Slice) {
  const padding = Math.max(slice.duration * 0.25, 5)
  setView(slice.start - padding, slice.start + slice.duration + padding)
  const row = rows.find(row => row.lane?.includes(slice))
  if (row) viewport.scrollTop = Math.max(0, row.y - (height - RULER) / 3)
  showSelection(slice)
}
function updateSearch() {
  const query = search.value.trim().toLowerCase(); matches = []
  if (query && trace) for (const track of trace.tracks) for (const lane of track.lanes) for (const slice of lane) {
    if (allowed(slice) && (slice.name.toLowerCase().includes(query) || slice.category.toLowerCase().includes(query))) matches.push(slice)
  }
  matches.sort((a, b) => a.start - b.start); matchIndex = -1; updateMatchLabel(); requestDraw()
}
function updateMatchLabel() {
  get('matches').textContent = search.value.trim() ? `${matchIndex < 0 ? 0 : matchIndex + 1} / ${matches.length.toLocaleString()}` : ''
  get<HTMLButtonElement>('previous').disabled = !matches.length; get<HTMLButtonElement>('next').disabled = !matches.length
}
function nextMatch(direction = 1) {
  if (!matches.length) return
  matchIndex = matchIndex < 0 ? (direction > 0 ? 0 : matches.length - 1) : (matchIndex + direction + matches.length) % matches.length
  focus(matches[matchIndex]); updateMatchLabel()
}
function hitAt(x: number, y: number) {
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]
    if (x >= hit.x && x <= hit.x + Math.max(3, hit.width) && y >= Math.max(RULER, hit.y) && y < hit.y + ROW) return hit.slice
  }
}
let drag: { x: number; y: number; start: number; end: number; scroll: number; moved: boolean } | undefined
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  viewport.focus(); canvas.setPointerCapture(event.pointerId)
  drag = { x: event.clientX, y: event.clientY, start: viewStart, end: viewEnd, scroll: viewport.scrollTop, moved: false }; tooltip.hidden = true
})
canvas.addEventListener('pointermove', event => {
  const bounds = canvas.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top
  if (drag) {
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    if (drag.moved) {
      const delta = dx / (width - gutter) * (drag.end - drag.start)
      setView(drag.start - delta, drag.end - delta); viewport.scrollTop = drag.scroll - dy
    }
    return
  }
  const slice = hitAt(x, y); tooltip.hidden = !slice
  if (slice) {
    tooltip.textContent = `${slice.name}\n${slice.category} · ${formatTime(slice.duration)}`
    tooltip.style.left = `${Math.max(4, Math.min(event.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8))}px`
    tooltip.style.top = `${Math.max(4, Math.min(event.clientY + 12, window.innerHeight - tooltip.offsetHeight - 8))}px`
  }
})
canvas.addEventListener('pointerup', event => {
  if (!drag) return
  if (!drag.moved) { const bounds = canvas.getBoundingClientRect(); showSelection(hitAt(event.clientX - bounds.left, event.clientY - bounds.top)) }
  drag = undefined
})
canvas.addEventListener('lostpointercapture', () => { drag = undefined })
canvas.addEventListener('pointerleave', () => { tooltip.hidden = true })
canvas.addEventListener('dblclick', () => { if (selection) focus(selection) })
viewport.addEventListener('scroll', () => { tooltip.hidden = true; requestDraw() })
canvas.addEventListener('wheel', event => {
  tooltip.hidden = true
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    const x = event.clientX - canvas.getBoundingClientRect().left
    zoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.005))), Math.max(0, Math.min(1, (x - gutter) / (width - gutter))))
  } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    event.preventDefault()
    const delta = (event.deltaX || event.deltaY) / (width - gutter) * (viewEnd - viewStart)
    setView(viewStart + delta, viewEnd + delta)
  }
}, { passive: false })
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.ctrlKey || event.metaKey || event.altKey) return
  const key = event.key.toLowerCase(), span = viewEnd - viewStart
  if (key === 'w' || key === '+' || key === '=') zoom(0.5)
  else if (key === 's' || key === '-') zoom(2)
  else if (key === 'a') setView(viewStart - span * 0.2, viewEnd - span * 0.2)
  else if (key === 'd') setView(viewStart + span * 0.2, viewEnd + span * 0.2)
  else if (key === 'f') fit()
  else if (key === '/') search.focus()
  else if (key === 'enter' && selection) focus(selection)
  else return
  event.preventDefault()
})
get('zoom-in').onclick = () => zoom(0.5); get('zoom-out').onclick = () => zoom(2); get('fit').onclick = fit
get('next').onclick = () => nextMatch(); get('previous').onclick = () => nextMatch(-1)
search.addEventListener('input', updateSearch)
search.addEventListener('keydown', event => { if (event.key === 'Enter') { nextMatch(event.shiftKey ? -1 : 1); event.preventDefault() } })
filter.addEventListener('change', () => { viewport.scrollTop = 0; rebuildRows(); updateSearch() })

async function load(content: EditorContent) {
  const version = ++loadVersion
  trace = undefined; rows = []; totalHeight = 0; tooltip.hidden = true
  rebuildRows(); showSelection(); updateSearch()
  get('summary').textContent = 'Loading trace…'; get('message').hidden = true; get('range').textContent = ''
  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
  if (version !== loadVersion) return
  try {
    const text = await readText(content)
    if (version !== loadVersion) return
    trace = parseTrace(text)
    get('summary').textContent = `${trace.eventCount.toLocaleString()} events · ${trace.tracks.length} tracks · ${formatTime(trace.end - trace.start)}`
    const omitted = Object.entries(trace.skipped)
    get('summary').title = omitted.length ? `Not drawn: ${omitted.map(([phase, count]) => `${phase}: ${count}`).join(', ')}. Flow arrows, counters and async events are not rendered.` : 'Times are relative to the first event.'
    if (!trace.eventCount) { get('message').textContent = 'No duration or instant events to display. Supported phases: X, B/E, i/I and R.'; get('message').hidden = false }
    viewport.scrollTop = 0; rebuildRows(); updateSearch(); fit()
  } catch (error) {
    if (version !== loadVersion) return
    get('summary').textContent = 'Unable to display trace'
    get('message').textContent = error instanceof Error ? error.message : String(error); get('message').hidden = false
  }
}
new ResizeObserver(resize).observe(viewport)
orca.on('theme', readTheme); readTheme(); updateMatchLabel()
try {
  const doc = await start()
  doc.onReplace(content => { void load(content) })
  window.addEventListener('pagehide', () => doc.dispose(), { once: true })
  await load(doc.value)
} catch (error) {
  get('summary').textContent = 'Unable to open document'
  get('message').textContent = error instanceof Error ? error.message : String(error); get('message').hidden = false
}
