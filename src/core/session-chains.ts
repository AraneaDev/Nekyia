import type { SearchRef } from './db'
import type { SessionSnapshot } from './query'

/**
 * Disjoint-set data structure (Union-Find) for tracking connected components.
 */
export class Components {
  private readonly parents: number[]

  /**
   * Initializes the union-find structure with the given size.
   */
  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index)
  }

  /**
   * Finds the root representative of the given index, applying path compression.
   */
  find(index: number): number {
    let root = index
    while (this.parents[root] !== root) root = this.parents[root]!
    while (this.parents[index] !== index) {
      const parent = this.parents[index]!
      this.parents[index] = root
      index = parent
    }
    return root
  }

  /**
   * Merges the components containing the left and right indices.
   */
  union(left: number, right: number): void {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return
    // Stable roots make corrupt cycles and equivalent inputs deterministic.
    if (leftRoot < rightRoot) this.parents[rightRoot] = leftRoot
    else this.parents[leftRoot] = rightRoot
  }
}

/** Build chain membership from every row, including rows later removed by filters. */
function chainComponents(rows: readonly SearchRef[]): Components {
  const components = new Components(rows.length)
  const byNative = new Map<string, number[]>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const key = `${row.client}\0${row.nativeId}`
    const matches = byNative.get(key)
    if (matches) matches.push(index)
    else byNative.set(key, [index])
  }

  const orphanChildren = new Map<string, number>()
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (!row.parentNativeId) continue
    const parentKey = `${row.client}\0${row.parentNativeId}`
    const parents = byNative.get(parentKey)
    if (parents?.length === 1) {
      components.union(index, parents[0]!)
    } else if (!parents) {
      // Two children of an omitted parent are still forks of one conversation.
      const sibling = orphanChildren.get(parentKey)
      if (sibling === undefined) orphanChildren.set(parentKey, index)
      else components.union(index, sibling)
    }
    // Duplicate native IDs make the edge ambiguous; keeping it disconnected is
    // safer than silently merging unrelated conversations.
  }
  return components
}

/**
 * The fork-chain components of a snapshot, keyed by the snapshot itself.
 *
 * Union-find over the whole table is the expensive half of a search, and it
 * depends on nothing but the rows. Keying on the array means a snapshot that
 * goes out of scope takes its components with it, and a one-shot `query` gets
 * the same treatment as the picker without either having to say so.
 */
const snapshotComponents = new WeakMap<SessionSnapshot, Components>()

/** The snapshot's fork chains, built on first use and reused by every later search over it. */
export function componentsFor(snapshot: SessionSnapshot): Components {
  const cached = snapshotComponents.get(snapshot)
  if (cached) return cached
  const components = chainComponents(snapshot)
  snapshotComponents.set(snapshot, components)
  return components
}

/** Returns the full snapshot component for an exact UID; policy filtering belongs to the caller. */
export function chainMembers(snapshot: SessionSnapshot, uid: string): readonly SearchRef[] {
  const index = snapshot.findIndex((row) => row.uid === uid)
  if (index < 0) return []
  const components = componentsFor(snapshot)
  const root = components.find(index)
  return snapshot.filter((_, memberIndex) => components.find(memberIndex) === root)
}
