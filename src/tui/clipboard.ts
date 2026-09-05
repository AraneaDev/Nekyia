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

/**
 * Represents a shell command and its arguments for a clipboard backend.
 */
interface Helper {
  command: string
  args: string[]
}

/**
 * Checks if a string is defined and contains non-whitespace characters.
 */
function nonempty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Returns the appropriate clipboard helper commands for the given platform and environment.
 */
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

/**
 * Validates that the text fits within the OSC 52 byte limit and encodes it as UTF-8.
 */
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

/**
 * Sends a base64-encoded payload to the terminal using the OSC 52 escape sequence.
 */
async function sendOsc52(runtime: ClipboardRuntime, bytes: Uint8Array): Promise<'sent'> {
  const payload = Buffer.from(bytes).toString('base64')
  await runtime.writeTty(`\u001b]52;c;${payload}\u0007`)
  // OSC52 has no acknowledgement; do not claim that the clipboard changed.
  return 'sent'
}

/** Whether the terminal an escape sequence would go to is still this process's to write on. */
export interface TerminalOwnership {
  owned: boolean
}

/**
 * This process's own terminal, owned until a client is launched onto it.
 *
 * The picker waits briefly for a copy to finish before launching, and then
 * launches anyway. Waiting is not ownership: a helper that hangs past the drain
 * and only then fails would fall back to OSC 52 and write into a terminal the
 * client is already drawing on. So the handover is stated rather than timed.
 *
 * One-way, because nothing hands the terminal back inside a run. It is a value
 * rather than a module flag so a test can own one of its own and not leave the
 * process latched for everything that runs after it.
 */
const hostTerminal: TerminalOwnership = { owned: true }

/** Marks a terminal as handed over, after which no escape sequence is written to it. */
export function releaseTerminal(terminal: TerminalOwnership = hostTerminal): void {
  terminal.owned = false
}

/**
 * Writes a sequence to the terminal, unless it has been handed to a client.
 *
 * A dropped sequence costs the copy. Writing it into another program's screen
 * costs that program's rendering, and the user has already moved on to it.
 */
export function writeTtySequence(
  sequence: string,
  terminal: TerminalOwnership = hostTerminal,
): Promise<void> {
  if (!terminal.owned) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(sequence, (error) => error ? reject(error) : resolve())
  })
}

const defaultRuntime: ClipboardRuntime = {
  platform: process.platform,
  env: process.env,
  /**
   * Resolves the absolute path of an executable command.
   */
  which: (command) => Bun.which(command),
  /**
   * Spawns a process to execute a command and pipes the given text to its standard input.
   */
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
  writeTty: writeTtySequence,
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
      /**
       * Writes text to the system clipboard using the discovered helper command, falling back to OSC 52.
       */
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
    /**
     * Writes text directly via the terminal's OSC 52 clipboard escape sequence.
     */
    async writeText(text) {
      return sendOsc52(runtime, checkedUtf8(text))
    },
  }
}
