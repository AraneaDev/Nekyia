/** Whether the unfinished final word should match token prefixes. */
export type MatchMode = 'literal' | 'prefix-last'

/** Compile user words into quoted FTS terms, without allowing user query syntax. */
export function compileSearch(text: string, mode: MatchMode): string | null {
  const parts = [...text.matchAll(/"([^"\n]+)"|([\p{L}\p{N}_]+)/gu)]
  const terms = parts.flatMap(part => {
    const words = (part[1] ?? part[2]!).match(/[\p{L}\p{N}_]+/gu)
    if (!words?.length) return []
    const prefix = !part[1] && mode === 'prefix-last' && part.index + part[0].length === text.length
    return [`"${words.join(' ')}"${prefix ? '*' : ''}`]
  })
  return terms.length ? terms.join(' ') : null
}
