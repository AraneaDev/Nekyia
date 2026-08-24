import type { FormatName } from '../manifests/load'
import { jsonDir } from './json-dir'
import type { FormatModule } from './jsonl-transcript'
import { jsonlTranscript } from './jsonl-transcript'
import { sqliteStore } from './sqlite-store'

/** Maps each format name to its reader. Dispatch is by manifest, which is why a new client needs no code here. */
export const FORMAT_MODULES: Record<FormatName, FormatModule> = {
  'jsonl-transcript': jsonlTranscript,
  'sqlite-store': sqliteStore,
  'json-dir': jsonDir,
}
