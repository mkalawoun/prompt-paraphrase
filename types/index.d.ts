// The two versions Undo swaps between; isUndone means the original is in the box.
export type UndoEntry = { original: string; rewritten: string; isUndone: boolean }

// A rewrite that could not go into the box, shown in the pane instead.
// missing: the @-mentions or placeholders the rewrite dropped.
export type PendingRewrite = { text: string; reason: 'edited' | 'refused' | 'dropped'; missing: string[] }

export type LastRun = { ms: number; inChars: number; outChars: number; withContext: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prompt-paraphrase': {
      isRunning: boolean
      includeContext: boolean
      undo: UndoEntry | null
      pending: PendingRewrite | null
      lastRun: LastRun | null
    }
  }
}
