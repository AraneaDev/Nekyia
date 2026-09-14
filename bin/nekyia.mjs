#!/usr/bin/env node
// Nekyia runs on Bun. This launcher is the one file in the package Node can
// read start to finish, so it is where a missing Bun turns into a sentence
// instead of "Cannot find module 'bun:sqlite'".
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveBun } from './resolve-bun.mjs'

const CLI_URL = new URL('../src/cli.ts', import.meta.url)

const MISSING_BUN = `nekyia needs Bun, and no runnable 'bun' was found on your PATH.

Install Bun 1.1.0 or newer from https://bun.sh, then run nekyia again.
If Bun is already installed, add its bin directory to your PATH.`

/** Re-execs the CLI through Bun, or explains why that is not possible. */
function runUnderBun() {
  const bun = resolveBun()
  if (!bun) {
    console.error(MISSING_BUN)
    return 1
  }

  const result = spawnSync(bun, [fileURLToPath(CLI_URL), ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`nekyia could not start Bun at ${bun}: ${result.error.message}`)
    return 1
  }
  // A signalled child has a null status. Report that as a failure rather than
  // as a clean exit, which is what the fallback below is doing.
  return result.status ?? 1
}

if (typeof Bun === 'undefined') {
  process.exit(runUnderBun())
} else {
  // src/cli.ts only self-starts under `import.meta.main`, which is false once
  // this file is the entry point. Call the exported main directly.
  const { main } = await import(CLI_URL.href)
  process.exit(await main(process.argv.slice(2)))
}
