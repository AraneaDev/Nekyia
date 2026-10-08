import { expect, test } from 'bun:test'
import {
  matchesTimeRange, parseTimeBound, presetTimeRange, validateTimeRange,
  type TimeRange,
} from '../src/core/time-range'

const NOW = 1_791_374_400_000 // 2026-10-07 12:00 UTC

test('duration bounds subtract whole spans from the same invocation time', () => {
  for (const [value, expected] of [
    ['0m', 1_791_374_400_000], ['30m', 1_791_372_600_000],
    ['12h', 1_791_331_200_000], ['2d', 1_791_201_600_000],
    ['3w', 1_789_560_000_000],
  ] as const) {
    expect(parseTimeBound(value, NOW, '--since')).toBe(expected)
    expect(parseTimeBound(value, NOW, '--until')).toBe(expected)
  }
})

test('calendar dates are midnight UTC, including valid leap dates', () => {
  expect(parseTimeBound('2024-02-29', NOW, '--since')).toBe(1_709_164_800_000)
  expect(parseTimeBound('2026-10-07', NOW, '--until')).toBe(1_791_331_200_000)
  expect(parseTimeBound('0099-01-01', NOW, '--since')).toBe(-59_042_995_200_000)
})

test('timezone-bearing ISO bounds preserve minute, second and fractional precision', () => {
  for (const [value, expected] of [
    ['2026-10-07T12:05Z', 1_791_374_700_000],
    ['2026-10-07T14:05+02:00', 1_791_374_700_000],
    ['2026-10-07T14:05:06.123+02:00', 1_791_374_706_123],
    ['2026-10-07T09:05:06.1-03:00', 1_791_374_706_100],
    ['2026-10-07T12:05:06.12Z', 1_791_374_706_120],
  ] as const) {
    expect(parseTimeBound(value, NOW, '--since')).toBe(expected)
  }
})

test('impossible dates, ambiguous times and unsupported spans name the offending flag', () => {
  for (const value of [
    '', ' 7d', '7d ', '-1d', '1.5h', '1y', '7D', 'Infinityd',
    '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '2026-01-32', '2026-1-1', '2026-10-07T12:05',
    '2026-02-30T12:05Z', '2026-10-07T24:00Z', '2026-10-07T12:60Z',
    '2026-10-07T12:05:60Z', '2026-10-07T12:05:06.1234Z',
    '2026-10-07T12:05+24:00', '2026-10-07T12:05+02:60',
  ]) {
    expect(() => parseTimeBound(value, NOW, '--since')).toThrow('--since')
    expect(() => parseTimeBound(value, NOW, '--until')).toThrow('--until')
  }
})

test('span parsing rejects unsafe arithmetic and results outside the Date range', () => {
  for (const value of ['9007199254740992m', '999999999999999999999999999999999999999999d', '100000001d']) {
    expect(() => parseTimeBound(value, 0, '--since')).toThrow('--since')
  }
  expect(() => parseTimeBound('1m', -8_640_000_000_000_000, '--until')).toThrow('--until')
  for (const now of [Number.NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.5]) {
    expect(() => parseTimeBound('0d', now, '--since')).toThrow('--since')
  }
  expect(parseTimeBound('100000000d', 0, '--since')).toBe(-8_640_000_000_000_000)
})

test('range validation accepts open windows and rejects invalid or non-increasing bounds', () => {
  for (const range of [{}, { since: 0 }, { until: 0 }, { since: -1000, until: 0 }]) {
    expect(() => validateTimeRange(range)).not.toThrow()
  }
  for (const bad of [Number.NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001, '1', null]) {
    expect(() => validateTimeRange({ since: bad } as TimeRange)).toThrow('--since')
    expect(() => validateTimeRange({ until: bad } as TimeRange)).toThrow('--until')
  }
  for (const range of [{ since: 3000, until: 3000 }, { since: 4000, until: 3000 }]) {
    expect(() => validateTimeRange(range)).toThrow(/since.*precede.*until/)
  }
})

test('overlap includes an end at since and excludes a start at until', () => {
  const range = { since: 2000, until: 3000 }
  for (const [start, end, expected] of [
    [1000, 4000, true], [1000, 2000, true], [3000, 4000, false],
    [1000, 1999, false], [4000, 1000, true], [2000, 2000, true],
    [3000, 3000, false], [0, 2500, true], [2500, 0, true],
    [-1000, 2500, true], [2500, Infinity, true], [NaN, 2500, true],
    [0, 0, false], [-1000, 0, false], [NaN, Infinity, false],
  ] as const) {
    expect(matchesTimeRange(start, end, range)).toBe(expected)
  }
  expect(matchesTimeRange(1000, 4000, { until: 2000 })).toBe(true)
  expect(matchesTimeRange(3000, 4000, { since: 2000 })).toBe(true)
  expect(matchesTimeRange(0, 0, {})).toBe(true)
  expect(matchesTimeRange(NaN, Infinity, {})).toBe(true)
})

test('core overlap fails closed for invalid ranges without throwing', () => {
  for (const range of [
    { since: NaN }, { until: Infinity }, { since: 1.5 },
    { since: 8_640_000_000_000_001 }, { until: '3000' },
    { since: 3000, until: 3000 }, { since: 4000, until: 3000 },
  ]) {
    expect(matchesTimeRange(1000, 4000, range as TimeRange)).toBe(false)
  }
})

test('rolling presets use fixed durations and include the captured current time', () => {
  expect(presetTimeRange('all', NOW)).toEqual({})
  expect(presetTimeRange('7d', NOW)).toEqual({ since: 1_790_769_600_000, until: 1_791_374_400_001 })
  expect(presetTimeRange('30d', NOW)).toEqual({ since: 1_788_782_400_000, until: 1_791_374_400_001 })
  expect(matchesTimeRange(NOW, NOW, presetTimeRange('7d', NOW))).toBe(true)
})

test('local calendar presets respect Amsterdam midnight and both DST transitions', () => {
  const moduleUrl = new URL('../src/core/time-range.ts', import.meta.url).href
  const script = `
    import { presetTimeRange, parseTimeBound } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({
      springToday: presetTimeRange('today', 1774785600000),
      springYesterday: presetTimeRange('yesterday', 1774872000000),
      autumnToday: presetTimeRange('today', 1792929600000),
      autumnYesterday: presetTimeRange('yesterday', 1793016000000),
      cliDate: parseTimeBound('2026-10-07', 1791374400000, '--since')
    }));
  `
  const child = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, TZ: 'Europe/Amsterdam' }, stdout: 'pipe', stderr: 'pipe',
  })
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toEqual({
    springToday: { since: 1_774_738_800_000, until: 1_774_785_600_001 },
    springYesterday: { since: 1_774_738_800_000, until: 1_774_821_600_000 },
    autumnToday: { since: 1_792_879_200_000, until: 1_792_929_600_001 },
    autumnYesterday: { since: 1_792_879_200_000, until: 1_792_969_200_000 },
    cliDate: 1_791_331_200_000,
  })
})
