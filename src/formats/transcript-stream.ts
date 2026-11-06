const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024 * 1024

/** Opens a plain file or Bun's native streaming zstd decoder. */
function transcriptStream(path: string): ReadableStream<Uint8Array> {
  const stream = Bun.file(path).stream()
  // Bun 1.4 supports zstd; TypeScript's DOM CompressionFormat union does not yet.
  return path.endsWith('.jsonl.zst')
    ? stream.pipeThrough(new DecompressionStream('zstd' as CompressionFormat))
    : stream
}

/** A decompressed prefix, and whether the transcript continues past it. */
export interface TranscriptHead {
  text: string
  /**
   * True when more bytes follow the prefix. Judged from the bytes, never from the
   * decoded text: decoding drops a leading BOM, so text length undercounts.
   */
  truncated: boolean
}

/** Reads only the decompressed prefix and cancels the upstream file reader. */
export async function readTranscriptPrefix(path: string, maxBytes: number): Promise<TranscriptHead> {
  const reader = transcriptStream(path).getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const prefix = value.subarray(0, maxBytes - bytes)
      bytes += prefix.byteLength
      text += decoder.decode(prefix, { stream: true })
      // A chunk with bytes left over proves the transcript continues. A prefix
      // that ends exactly on a chunk boundary needs one more read to tell an
      // exact-length file from a longer one.
      if (prefix.byteLength < value.byteLength) { truncated = true; break }
    }
    return { text: text + decoder.decode(), truncated }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Reads only the decompressed prefix as text. */
export async function readTranscriptHead(path: string, maxBytes: number): Promise<string> {
  return (await readTranscriptPrefix(path, maxBytes)).text
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
