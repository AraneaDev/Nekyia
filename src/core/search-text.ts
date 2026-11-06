/** Whether the unfinished final word should match token prefixes. */
export type MatchMode = 'literal' | 'prefix-last'

/**
 * The shortest unfinished word that is matched as a prefix rather than whole.
 *
 * A prefix of one or two letters expands to nearly every term in the index, and
 * ranking that many hits costs over a hundred milliseconds on a large one, where
 * the same term matched whole costs about one. Matching it whole until it grows
 * keeps short words such as `ui` or `db` findable without paying for that.
 */
export const MIN_PREFIX_LENGTH = 3

/**
 * Scripts written without spaces, which the tokenizer keeps as one term per run
 * of characters. Their words are often a single character or two, so the
 * minimum would make `東京` stop finding `東京都`; they expand from the first.
 */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** True when an unfinished final word is long enough, or so written, that prefix expansion is worth its cost. */
function expandsAsPrefix(term: string): boolean {
  return [...term].length >= MIN_PREFIX_LENGTH || UNSPACED_SCRIPT.test(term)
}

/** Compile user words into quoted FTS terms, without allowing user query syntax. */
export function compileSearch(text: string, mode: MatchMode): string | null {
  const parts = [...text.matchAll(/"([^"\n]+)"|([\p{L}\p{N}_]+)/gu)]
  const terms = parts.flatMap(part => {
    const words = (part[1] ?? part[2]!).match(/[\p{L}\p{N}_]+/gu)
    if (!words?.length) return []
    const prefix = !part[1] && mode === 'prefix-last' && part.index + part[0].length === text.length && expandsAsPrefix(words[0]!)
    return [`"${words.join(' ')}"${prefix ? '*' : ''}`]
  })
  return terms.length ? terms.join(' ') : null
}
