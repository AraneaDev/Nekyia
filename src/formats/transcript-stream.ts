const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024 * 1024

/** Opens a plain file or Bun's native streaming zstd decoder. */
function transcriptStream(path: string): ReadableStream<Uint8Array> {
  const stream = Bun.file(path).stream()
  // Bun 1.4 supports zstd; TypeScript's DOM CompressionFormat union does not yet.
  return path.endsWith('.jsonl.zst')
    ? stream.pipeThrough(new DecompressionStream('zstd' as CompressionFormat))
    : stream
}

/** Reads only the decompressed prefix and cancels the upstream file reader. */
export async function readTranscriptHead(path: string, maxBytes: number): Promise<string> {
  const reader = transcriptStream(path).getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      const prefix = value.subarray(0, maxBytes - bytes)
      bytes += prefix.byteLength
      text += decoder.decode(prefix, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Fails before passing an over-limit decompressed chunk to a transcript parser. */
export async function* transcriptChunks(
  path: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): AsyncGenerator<Uint8Array> {
  let bytes = 0
  for await (const chunk of transcriptStream(path)) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error(`transcript exceeds ${maxBytes} byte decompressed safety limit`)
    yield chunk
  }
}
