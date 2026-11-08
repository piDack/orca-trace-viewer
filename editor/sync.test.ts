import { assert, mockEditorHost, test } from 'orca/testing'
import { readText, start } from './sync'

test('viewing and receiving an outside replacement never changes the file', async () => {
  const host = mockEditorHost({ text: '{"traceEvents":[]}' })
  const doc = await start()
  try {
    assert.equal(await readText(doc.value), '{"traceEvents":[]}')
    let replacement = ''
    doc.onReplace(value => { if (value.kind === 'text') replacement = value.text })
    host.replace('{"traceEvents":[{"ph":"i","ts":0}]}')
    await host.flush()
    assert.equal(replacement, host.text)
    assert.equal(host.edits.length, 0)
  } finally { doc.dispose(); host.dispose() }
})

test('reads gzip by magic bytes and rejects truncated compressed data', async () => {
  const source = '{"traceEvents":[{"ph":"X","name":"kernel","ts":10,"dur":5}]}'
  const compressed = await new Response(new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  assert.equal(await readText({ kind: 'bytes', bytes: compressed }), source)
  await assert.rejects(() => readText({ kind: 'bytes', bytes: compressed.slice(0, 12) }))
})
