import { assert, test } from 'orca/testing'
import { firstVisible, parseTrace } from './trace'
const parse = (events: unknown[]) => parseTrace(JSON.stringify({ displayTimeUnit: 'ns', traceEvents: events }))
test('Kineto timestamps stay in microseconds; late metadata labels GPU tracks', () => {
  const trace = parse([
    { ph: 'X', name: 'kernel', cat: 'kernel', pid: 0, tid: 7, ts: 5e12 + 100, dur: 250 },
    { ph: 'M', name: 'process_labels', pid: 0, args: { labels: 'GPU 0' } },
    { ph: 'M', name: 'thread_name', pid: 0, tid: 7, args: { name: 'stream 7' } },
  ])
  assert.equal(trace.end - trace.start, 250); assert.equal(trace.tracks[0].label, 'stream 7'); assert.match(trace.tracks[0].process, /GPU 0/)
})
test('nested and overlapping complete events stay visible in non-overlapping lanes', () => {
  const trace = parse([
    { ph: 'X', name: 'outer', ts: 0, dur: 100 }, { ph: 'X', name: 'inner', ts: 10, dur: 20 },
    { ph: 'X', name: 'overlap', ts: 20, dur: 40 }, { ph: 'X', name: 'after', ts: 105, dur: 10 },
  ])
  const lanes = trace.tracks[0].lanes
  assert.equal(lanes.length, 3); assert.equal(lanes.flat().length, 4)
  for (const lane of lanes) for (let i = 1; i < lane.length; i++) assert.ok(lane[i - 1].start + lane[i - 1].duration <= lane[i].start)
  assert.equal(firstVisible(lanes.find(lane => lane[0].name === 'outer')!, 50), 0)
})
test('pairs B/E by thread, merges args and reports unmatched events', () => {
  const trace = parse([
    { ph: 'B', name: 'outer', tid: 1, ts: 0, args: { input: 1 } }, { ph: 'B', name: 'other', tid: 2, ts: 1 },
    { ph: 'B', name: 'inner', tid: 1, ts: 2 }, { ph: 'E', tid: 1, ts: 4 },
    { ph: 'E', tid: 1, ts: 10, args: { output: 2 } }, { ph: 'E', tid: 3, ts: 11 },
  ])
  const slices = trace.tracks.flatMap(track => track.lanes.flat())
  assert.equal(slices.find(slice => slice.name === 'inner')?.duration, 2)
  assert.deepEqual(slices.find(slice => slice.name === 'outer')?.args, { input: 1, output: 2 })
  assert.equal(trace.skipped['unmatched B'], 1); assert.equal(trace.skipped['unmatched E'], 1)
})
test('event arrays and instant events work; ordinary/broken JSON has a clear error', () => {
  assert.equal(parseTrace('[{"ph":"i","name":"mark","ts":0}]').eventCount, 1)
  assert.equal(parse([]).eventCount, 0)
  assert.throws(() => parseTrace('{"config":true}'), /not a Chrome trace/)
  assert.throws(() => parseTrace('{"traceEvents":['), /Invalid JSON/)
  const trace = parse([null, { ph: 'X', ts: 0, dur: -1 }, { ph: 's', ts: 0 }])
  assert.equal(trace.eventCount, 0); assert.equal(trace.skipped.invalid, 2); assert.equal(trace.skipped.s, 1)
})
