import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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
  expect(config.packages['.']?.['extra-files']).toContain('README.md')
})

test('the README install block tracks the released version', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string }
  const block = read('README.md').match(
    /<!-- x-release-please-start-version -->\n([\s\S]*?)<!-- x-release-please-end -->/,
  )?.[1]
  expect(block).toBeDefined()

  const lines = block!.split('\n')
  const versions = lines.flatMap(line => line.match(/\d+\.\d+\.\d+/g) ?? [])
  expect(versions.length).toBeGreaterThan(0)
  for (const version of versions) expect(version).toBe(pkg.version)

  // The generic updater rewrites one version per line, so a second version on
  // any line would survive a release and leave a stale reference behind.
  for (const line of lines) {
    expect((line.match(/\d+\.\d+\.\d+/g) ?? []).length).toBeLessThanOrEqual(1)
  }
})

test('every interface shot the README points at exists and is generated', () => {
  const readme = read('README.md')
  const referenced = [...readme.matchAll(/\]\((docs\/media\/[^)]+)\)/gu)].map((match) => match[1]!)
  expect(referenced.length).toBeGreaterThan(0)
  for (const path of referenced) {
    // A missing image renders as a broken icon on the page, which is worse
    // than no image at all.
    expect(existsSync(join(root, path))).toBe(true)
    // The shots are captured from the running picker, not drawn by hand.
    expect(path.endsWith('.svg')).toBe(true)
  }
  // Every shot the script produces earns its place on the page.
  const shots = read('scripts/shots.ts')
  for (const name of [...shots.matchAll(/name: '([a-z]+)',\n\s*what:/gu)].map((m) => m[1]!)) {
    expect(referenced).toContain(`docs/media/${name}.svg`)
  }
})
