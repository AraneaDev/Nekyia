import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

test('the package and release manifest agree on one semver version', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string }
  const manifest = JSON.parse(read('.release-please-manifest.json')) as Record<string, string>
  // Release Please rewrites both files together, so pin the invariant rather
  // than the number: a well formed version that the manifest still agrees with.
  expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  expect(manifest['.']).toBe(pkg.version)
})

test('CI runs frozen Bun checks on Linux and macOS', () => {
  const workflow = read('.github/workflows/ci.yml')
  expect(workflow).toContain('ubuntu-latest')
  expect(workflow).toContain('macos-latest')
  expect(workflow).toContain('bun install --frozen-lockfile --ignore-scripts')
  expect(workflow).toContain('bun run typecheck')
  expect(workflow).toContain('bun run test')
  expect(workflow).toContain('bun pm pack --dry-run')
})

test('Release Please is configured for conventional releases from main', () => {
  const workflow = read('.github/workflows/release-please.yml')
  const config = JSON.parse(read('release-please-config.json')) as {
    packages: Record<string, Record<string, unknown>>
  }
  expect(workflow).toContain('googleapis/release-please-action@v4')
  expect(workflow).toContain('branches: [main]')
  expect(config.packages['.']?.['package-name']).toBe('nekyia')
  expect(config.packages['.']?.['release-type']).toBe('node')
})
