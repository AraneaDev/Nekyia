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
  ['!!!', 'prefix-last', null],
  ['', 'literal', null],
] as const) {
  test(`compiles ${JSON.stringify(text)} in ${mode} mode safely`, () => {
    expect(compileSearch(text, mode)).toBe(expression)
  })
}
