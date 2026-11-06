import { expect, test } from 'bun:test'
import { compileSearch } from '../src/core/search-text'

for (const [text, mode, expression] of [
  ['retry ten', 'prefix-last', '"retry" "ten"*'],
  ['retry tenant ', 'prefix-last', '"retry" "tenant"'],
  ['retry ten', 'literal', '"retry" "ten"'],
  ['retry ten.', 'prefix-last', '"retry" "ten"'],
  ['retry ten\n', 'prefix-last', '"retry" "ten"'],
  ['東京 café_2', 'prefix-last', '"東京" "café_2"*'],
  ['"OR" NOT title:foo*', 'prefix-last', '"OR" "NOT" "title" "foo"'],
  ['foo-bar', 'prefix-last', '"foo" "bar"*'],
  // Below three characters an unfinished word is matched whole, not expanded.
  ['r', 'prefix-last', '"r"'],
  ['ui', 'prefix-last', '"ui"'],
  ['sse r', 'prefix-last', '"sse" "r"'],
  ['ref', 'prefix-last', '"ref"*'],
  // Counted in characters, not UTF-16 units: two astral letters stay short.
  ['𝒳𝒴', 'prefix-last', '"𝒳𝒴"'],
  ['éa', 'prefix-last', '"éa"'],
  // Unspaced scripts expand from the first character.
  ['東', 'prefix-last', '"東"*'],
  ['とう', 'prefix-last', '"とう"*'],
  ['서', 'prefix-last', '"서"*'],
  ['"app engine" r', 'prefix-last', '"app engine" "r"'],
  ['"app engine" ref', 'prefix-last', '"app engine" "ref"*'],
  ['"東"', 'prefix-last', '"東"'],
  ['!!!', 'prefix-last', null],
  ['', 'literal', null],
] as const) {
  test(`compiles ${JSON.stringify(text)} in ${mode} mode safely`, () => {
    expect(compileSearch(text, mode)).toBe(expression)
  })
}
