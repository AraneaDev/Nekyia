/** Stable identifiers shared by keyboard dispatch, menus and contextual help. */
export type ActionId =
  | 'resume' | 'handoff' | 'inspect' | 'inspect-match' | 'details' | 'chain'
  | 'copy-prompt' | 'copy-command' | 'bookmark' | 'manage-bookmarks'
  | 'filters' | 'clear-search' | 'refresh' | 'stats'

/** Enabled actions have no reason; unavailable actions carry an explanation. */
export interface ActionItem {
  id: ActionId
  label: string
  shortcut: string | null
  enabled: boolean
  reason: string | null
}

/**
 * Capabilities already checked against the selected session and visible clients.
 * Building a menu does not authorize execution: dispatch still runs preflight.
 */
export interface ActionContext {
  hasSelection: boolean
  canResume: boolean
  resumeReason: string | null
  canHandoff: boolean
  handoffReason: string | null
  hasMatch: boolean
  hasPrompt: boolean
  hasCommand: boolean
  bookmarked: boolean
  hasQuery: boolean
  refreshing: boolean
  statsVisible?: boolean
  statsAvailable?: boolean
}

/** One registry feeds menus, help and footer hints without duplicating bindings. */
export function actionsFor(context: ActionContext): ActionItem[] {
  /** Keeps enabled entries reason-free and gives disabled entries a fallback. */
  const item = (id: ActionId, label: string, shortcut: string | null, enabled = true, reason: string | null = null): ActionItem => ({
    id, label, shortcut, enabled, reason: enabled ? null : reason ?? 'Nothing selected',
  })
  return [
    item('resume', 'Resume session', 'enter', context.canResume, context.resumeReason),
    item('handoff', 'Start fresh with context', 'ctrl+t', context.canHandoff, context.handoffReason),
    item('inspect', 'Inspect history', 'ctrl+o', context.hasSelection),
    item('inspect-match', 'Inspect matching session', null, context.hasMatch, 'No matching evidence'),
    item('details', 'Session details', null, context.hasSelection),
    item('chain', 'Inspect related sessions', 'ctrl+e', context.hasSelection),
    item('copy-prompt', 'Copy first prompt', 'ctrl+p', context.hasPrompt, 'No prompt available'),
    item('copy-command', 'Copy launch command', 'ctrl+y', context.hasCommand, 'No native resume command available'),
    item('bookmark', context.bookmarked ? 'Unbookmark session' : 'Bookmark session', 'ctrl+b', context.hasSelection),
    item('manage-bookmarks', 'Manage bookmarks', null),
    item('filters', 'Filters', 'ctrl+g'),
    item('stats', context.statsVisible ? 'Hide stats panel' : 'Show stats panel', 'ctrl+s', context.statsAvailable ?? true,
      'Stats need 140 columns and 18 rows'),
    item('clear-search', 'Clear search', null, context.hasQuery, 'Search is empty'),
    item('refresh', 'Refresh index', 'ctrl+r', !context.refreshing, 'Refresh unavailable'),
  ]
}
