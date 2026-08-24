const OSC52_MAX_BYTES = 65_536

/** `sent` means the text went out over OSC 52 rather than a local helper, so the terminal decides whether it lands. */
export type ClipboardWriteResult = void | 'sent'

/** The one operation the picker needs from a clipboard, so tests can supply their own. */
export interface ClipboardLike {
  writeText(text: string): ClipboardWriteResult | Promise<ClipboardWriteResult>
}

/** Everything clipboard selection depends on, injected so helper discovery can be tested without a terminal. */
export interface ClipboardRuntime {
  platform: string
  env: Record<string, string | undefined>
  which(command: string): string | null
  run(command: string, args: string[], text: string): Promise<number>
  isTTY: boolean
  writeTty(sequence: string): Promise<void>
}

interface Helper {
  command: string
  args: string[]
}

function nonempty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function helpers(platform: string, env: Record<string, string | undefined>): Helper[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
  if (platform === 'win32') return [{ command: 'clip', args: [] }]
  const result: Helper[] = []
  if (nonempty(env.WAYLAND_DISPLAY)) result.push({ command: 'wl-copy', args: [] })
  if (nonempty(env.DISPLAY)) {
    result.push(
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    )
  }
  return result
}

function checkedUtf8(text: string): Uint8Array {
  // Every retained code unit costs at least one encoded byte. Sampling one
  // beyond the ceiling proves oversize without encoding an unbounded string.
  const sample = text.slice(0, OSC52_MAX_BYTES + 1)
  const bytes = new TextEncoder().encode(sample)
  if (sample.length !== text.length || bytes.byteLength > OSC52_MAX_BYTES) {
    throw new Error(`clipboard text exceeds ${OSC52_MAX_BYTES.toLocaleString('en-US')} UTF-8 bytes`)
  }
  return bytes
}

async function sendOsc52(runtime: ClipboardRuntime, bytes: Uint8Array): Promise<'sent'> {
  const payload = Buffer.from(bytes).toString('base64')
  await runtime.writeTty(`\u001b]52;c;${payload}\u0007`)
  // OSC52 has no acknowledgement; do not claim that the clipboard changed.
  return 'sent'
}

const defaultRuntime: ClipboardRuntime = {
  platform: process.platform,
  env: process.env,
  which: (command) => Bun.which(command),
  async run(command, args, text) {
    const proc = Bun.spawn([command, ...args], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await proc.stdin.write(text)
    await proc.stdin.end()
    return await proc.exited
  },
  isTTY: process.stdout.isTTY === true,
  writeTty: (sequence) => new Promise<void>((resolve, reject) => {
    process.stdout.write(sequence, (error) => error ? reject(error) : resolve())
  }),
}

/** Build a clipboard backend without ever passing copied text through a shell. */
export function createHostClipboard(runtime: ClipboardRuntime = defaultRuntime): ClipboardLike | null {
  for (const helper of helpers(runtime.platform, runtime.env)) {
    let command: string | null
    try {
      command = runtime.which(helper.command)
    } catch {
      continue
    }
    if (!command) continue
    return {
      async writeText(text) {
        const bytes = checkedUtf8(text)
        try {
          const status = await runtime.run(command, helper.args, text)
          if (status === 0) return
          if (!runtime.isTTY) throw new Error(`${helper.command} exited with status ${status}`)
        } catch (error) {
          if (!runtime.isTTY) throw error
        }
        return sendOsc52(runtime, bytes)
      },
    }
  }

  if (!runtime.isTTY) return null
  return {
    async writeText(text) {
      return sendOsc52(runtime, checkedUtf8(text))
    },
  }
}
