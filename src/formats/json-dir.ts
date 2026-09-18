import type { Manifest } from '../manifests/load'
import { codebuffReader } from './codebuff'
import type { FormatModule } from './jsonl-transcript'

/**
 * The reader for a directory-of-JSON manifest, chosen by its variant.
 *
 * Each client lays its directory out differently, so the variant, not the
 * format, decides which files are read and how.
 */
function readerFor(manifest: Manifest): FormatModule {
  if (manifest.format !== 'json-dir') throw new Error('json-dir reader given a non-json-dir manifest')
  switch (manifest.jsonDir.variant) {
    case 'codebuff':
      return codebuffReader
  }
}

export const jsonDir: FormatModule = {
  /**
   * Delegates discovery to the reader chosen by the manifest's variant.
   */
  discover(manifest, root) {
    return readerFor(manifest).discover(manifest, root)
  },
  /**
   * Delegates hydration to the reader chosen by the manifest's variant.
   */
  hydrate(manifest, root, ref, config) {
    return readerFor(manifest).hydrate(manifest, root, ref, config)
  },
}
