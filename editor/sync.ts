import type { EditorContent } from 'orca/frame'

// Viewing, searching and zooming never send edits. Decode outside the session so a
// malformed trace can show an error and recover when the file is replaced externally.
export function start() {
  if (!orca.document) throw new Error('Open this viewer as an Orca custom editor.')
  return orca.document.session<EditorContent>({ decode: content => content, encode: content => content })
}

export async function readText(content: EditorContent): Promise<string> {
  if (content.kind === 'text') return content.text
  let bytes = content.bytes
  const magic = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength))
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    bytes = await new Response(stream).arrayBuffer()
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
