/** Whether the unfinished final word should match token prefixes. */
export type MatchMode = 'literal' | 'prefix-last'

/** Compile user words into quoted FTS terms, without allowing user query syntax. */
export function compileSearch(text: string, mode: MatchMode): string | null {
  const terms = [...text.matchAll(/[\p{L}\p{N}_]+/gu)]
  if (!terms.length) return null
  return terms.map((term, index) => {
    const prefix = mode === 'prefix-last' && index === terms.length - 1
      && term.index + term[0].length === text.length
    return `"${term[0]}"${prefix ? '*' : ''}`
  }).join(' ')
}
