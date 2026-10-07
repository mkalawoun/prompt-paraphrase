import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { LastRun, PendingRewrite } from '../types'

const RUNNING = { plugin: 'prompt-paraphrase', key: 'isRunning' } as const
const CONTEXT = { plugin: 'prompt-paraphrase', key: 'includeContext' } as const
const UNDO = { plugin: 'prompt-paraphrase', key: 'undo' } as const
const PENDING = { plugin: 'prompt-paraphrase', key: 'pending' } as const
const LAST_RUN = { plugin: 'prompt-paraphrase', key: 'lastRun' } as const

const PANE = 'paraphrase-result'
const MODEL = 'haiku'
const TIMEOUT_MS = 60000
const CONTEXT_LIMIT = 4000

const USAGE =
  'Usage: /paraphrase [--context | --no-context] <prompt>. Rewrites the prompt with Haiku and puts it in the input box for you to review before sending.'

const SYSTEM = `You rewrite a developer's draft message into a clear, well-structured prompt for Claude Code, an AI coding agent that works in their repository with file, search and shell tools. You only rewrite; you never carry out the request.

Hard rules:
- Keep the intent exactly. Do not answer the draft, solve the task, or add requirements, steps, files or constraints that the draft does not state or clearly imply.
- Copy these exactly as written: file paths, class, method and variable names, commands, code, error messages, stack traces, logs, URLs, ticket keys, IDs, numbers and quoted text.
- Keep @-mentions (like @src/Foo.java) and bracketed placeholders (like [Pasted text #1 +20 lines] or [Image #2]) exactly as they are, next to the text they belong to. They stand for attached content.
- Write in the same language as the draft.
- Match the length to the draft. A one-line request becomes a short, precise prompt, not a template. If the draft is already clear, return it with light edits only.
- When something the task needs is missing or ambiguous, do not guess: add a short question under "Open questions". Leave that section out when nothing is missing.
- Project context, when given, is reference only: use it to spell names the way the project does and to resolve what the draft clearly refers to. Never add tasks from it.

Shape:
- Start with one sentence that states the goal.
- For anything beyond a simple request, add only the sections that have content, in this order, each a short bullet list under a bold label: **Context**, **Requirements**, **Constraints**, **Done when**, **Open questions**.
- Use imperative, specific wording. No greetings, no filler, no notes about the rewrite.

Reply with the rewritten prompt inside <prompt></prompt> tags and nothing else.`

type Rewrite = { isRewritten: true; text: string } | { isRewritten: false; message: string }

// The call in flight. Module scope, so a reload drops it; session.start resets the flag.
let inFlight: AbortController | null = null
let cancelNote = ''

function cancel(note: string) {
  if (inFlight) {
    cancelNote = note
    inFlight.abort()
  }
}

async function begin($: EngineInterface) {
  const controller = new AbortController()
  inFlight = controller
  cancelNote = ''
  await $.state.set(RUNNING, true)
  return controller
}

async function finish($: EngineInterface, controller: AbortController) {
  if (inFlight === controller) inFlight = null
  await $.state.set(RUNNING, false)
}

function refuseDraft(text: string) {
  if (text.trim() === '') return 'Type a prompt first.'
  if (/^\s*[/!]/.test(text)) return 'Slash commands and shell commands are left as typed.'
  return null
}

// Asks Haiku for the rewrite; every failure comes back as a message for the person.
async function rewrite($: EngineInterface, original: string, withContext: boolean, controller: AbortController): Promise<Rewrite> {
  const context = withContext ? await projectContext($) : ''
  const startedAt = await $.clock.now()
  const answer = await $.model.complete(
    {
      model: MODEL,
      system: SYSTEM,
      prompt: request(original, context),
      maxTokens: Math.min(8000, Math.max(1024, Math.ceil(original.length / 2))),
      timeoutMs: TIMEOUT_MS,
    },
    { signal: controller.signal },
  )
  const ms = (await $.clock.now()) - startedAt

  if (!answer.isAnswered) {
    if (answer.reason === 'aborted') {
      return { isRewritten: false, message: controller.signal.aborted ? cancelNote || 'Paraphrase cancelled.' : 'Haiku took too long. Try again.' }
    }
    if (answer.reason === 'api-error') {
      return { isRewritten: false, message: `Haiku request failed${answer.status ? ` (HTTP ${answer.status})` : ''}.` }
    }
    return { isRewritten: false, message: 'Haiku returned nothing.' }
  }

  const text = extract(answer.text)
  if (text === null) return { isRewritten: false, message: 'The rewrite was cut short. Try a shorter prompt.' }
  if (text === '') return { isRewritten: false, message: 'Haiku returned nothing.' }

  const lastRun: LastRun = { ms, inChars: original.length, outChars: text.length, withContext }
  await $.state.set(LAST_RUN, lastRun)

  if (text === original) return { isRewritten: false, message: 'The prompt is already clear. Nothing changed.' }
  return { isRewritten: true, text }
}

// The band's button: rewrites the draft in place.
async function primary($: EngineInterface) {
  const { value: running = false } = await $.state.get(RUNNING)
  if (running && inFlight) {
    cancel('Paraphrase cancelled.')
    return
  }
  await paraphrase($)
}

async function paraphrase($: EngineInterface) {
  const original = (await $.prompt.read()).text
  const refusal = refuseDraft(original)
  if (refusal) {
    $.ui.toast(refusal)
    return
  }

  const { value: withContext = false } = await $.state.get(CONTEXT)
  const controller = await begin($)
  try {
    const result = await rewrite($, original, withContext, controller)
    if (!result.isRewritten) {
      $.ui.toast(result.message)
      return
    }
    const rewritten = result.text

    // Attachments live behind these tokens; a rewrite that drops one would lose content.
    const missing = attachmentTokens(original).filter(token => !rewritten.includes(token))
    if (missing.length > 0) {
      await offer($, { text: rewritten, reason: 'dropped', missing })
      return
    }

    // Never overwrite what the person typed while Haiku was working.
    if ((await $.prompt.read()).text !== original) {
      await offer($, { text: rewritten, reason: 'edited', missing: [] })
      return
    }

    const filled = await $.prompt.fill({ text: rewritten, mode: 'replace' })
    if (!filled.isFilled) {
      await offer($, { text: rewritten, reason: 'refused', missing: [] })
      return
    }
    await $.state.set(UNDO, { original, rewritten, isUndone: false })
  } catch (error) {
    $.ui.toast(`Paraphrase failed: ${String(error)}`)
  } finally {
    await finish($, controller)
  }
}

// /paraphrase <prompt>: sending the command empties the box, so the rewrite goes back into it.
// Returns the command's reply, which the model also reads: kept short unless nothing else can show the rewrite.
async function runCommand($: EngineInterface, args: string) {
  const { text: original, withContext: override } = parseArgs(args)
  if (original === '') return USAGE
  const refusal = refuseDraft(original)
  if (refusal) return refusal
  if (inFlight) return 'A paraphrase is already running. Wait for it, or press Cancel.'

  const { value: saved = false } = await $.state.get(CONTEXT)
  const controller = await begin($)
  try {
    const result = await rewrite($, original, override ?? saved, controller)
    if (!result.isRewritten) return `${result.message}${await restore($, original)}`
    const rewritten = result.text

    const missing = attachmentTokens(original).filter(token => !rewritten.includes(token))
    if (missing.length > 0) {
      const restored = await restore($, original)
      return `${await present($, { text: rewritten, reason: 'dropped', missing })}${restored}`
    }

    // Leave alone anything typed after the command was sent.
    if ((await $.prompt.read()).text.trim() !== '') {
      return present($, { text: rewritten, reason: 'edited', missing: [] })
    }

    const filled = await $.prompt.fill({ text: rewritten, mode: 'replace' })
    if (!filled.isFilled) {
      // No box to fill (the VS Code extension): the reply is the only place left to show it.
      if (filled.refusal === 'no_composer') return `Paraphrased prompt:\n\n${rewritten}`
      return present($, { text: rewritten, reason: 'refused', missing: [] })
    }
    await $.state.set(UNDO, { original, rewritten, isUndone: false })
    return 'The rewrite is in the input box. Review it, then press Enter.'
  } catch (error) {
    return `Paraphrase failed: ${String(error)}${await restore($, original)}`
  } finally {
    await finish($, controller)
  }
}

// A leading --context or --no-context overrides the saved setting for one run.
function parseArgs(args: string): { text: string; withContext: boolean | null } {
  const flag = args.match(/^\s*(--context|--no-context)(?=\s|$)/)
  if (!flag) return { text: args.trim(), withContext: null }
  return { text: args.slice(flag[0].length).trim(), withContext: flag[1] === '--context' }
}

// Puts the text the command took back into the box, when the box is still empty.
async function restore($: EngineInterface, original: string) {
  if ((await $.prompt.read()).text.trim() !== '') return ''
  const filled = await $.prompt.fill({ text: original, mode: 'replace' })
  return filled.isFilled ? ' Your text is back in the input box.' : ''
}

function request(draft: string, context: string) {
  const parts: string[] = []
  if (context !== '') parts.push('<project_context>', context, '</project_context>', '')
  parts.push('<draft>', draft, '</draft>', '', 'Rewrite the draft as a prompt for Claude Code.')
  return parts.join('\n')
}

// Returns null when the reply opened <prompt> but was cut off before closing it.
function extract(reply: string): string | null {
  const tagged = reply.match(/<prompt>([\s\S]*?)<\/prompt>/)
  if (!tagged && reply.includes('<prompt>')) return null
  let text = (tagged ? (tagged[1] ?? '') : reply).trim()
  const fenced = text.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  if (fenced) text = (fenced[1] ?? '').trim()
  return text
}

function attachmentTokens(text: string) {
  return [...new Set(text.match(/\[(?:Pasted text|Image)[^\]]*\]|(?<![\w.])@[\w./\\-]+/g) ?? [])]
}

// Opens the pane on a rewrite that could not go into the box; false where no pane can be placed.
async function showPending($: EngineInterface, pending: PendingRewrite) {
  await $.state.set(PENDING, pending)
  const opened = await $.ui.open({ id: PANE, title: 'Paraphrased prompt' })
  return opened.isPlaced
}

async function offer($: EngineInterface, pending: PendingRewrite) {
  if (await showPending($, pending)) return
  const copied = await $.ui.copy({ text: pending.text })
  $.ui.toast(copied.isCopied ? `${pendingNote(pending)} The rewrite is on your clipboard.` : `${pendingNote(pending)} Try again.`)
}

// The command's version of offer: the reply carries the rewrite when the pane cannot.
async function present($: EngineInterface, pending: PendingRewrite) {
  const note = pendingNote(pending)
  return (await showPending($, pending)) ? `${note} The rewrite is in the pane.` : `${note}\n\n${pending.text}`
}

// Swaps the box between the two versions, keeping any edits made to the one it replaces.
async function toggleUndo($: EngineInterface) {
  const { value: entry = null } = await $.state.get(UNDO)
  if (!entry) return

  const current = (await $.prompt.read()).text
  const target = entry.isUndone ? entry.rewritten : entry.original
  const filled = await $.prompt.fill({ text: target, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('The input box is busy. Try again.')
    return
  }
  await $.state.set(
    UNDO,
    entry.isUndone
      ? { original: current, rewritten: entry.rewritten, isUndone: false }
      : { original: entry.original, rewritten: current, isUndone: true },
  )
}

async function toggleContext($: EngineInterface) {
  const { value: withContext = false } = await $.state.get(CONTEXT)
  await $.state.set(CONTEXT, !withContext)
  await $.store.set('includeContext', !withContext)
}

async function usePending($: EngineInterface) {
  const { value: pending = null } = await $.state.get(PENDING)
  if (!pending) return

  const current = (await $.prompt.read()).text
  const filled = await $.prompt.fill({ text: pending.text, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.toast('The input box is busy. Close any open dialog and try again.')
    return
  }
  await $.state.set(UNDO, { original: current, rewritten: pending.text, isUndone: false })
  await closePane($)
}

async function copyPending($: EngineInterface, surface: RenderSurface) {
  const { value: pending = null } = await $.state.get(PENDING)
  if (!pending) return

  const copied = await $.ui.copy({ text: pending.text, surface })
  $.ui.toast(copied.isCopied ? 'Copied.' : 'Copy is not available here. Select the text instead.')
}

async function closePane($: EngineInterface) {
  await $.state.set(PENDING, null)
  await $.ui.close({ id: PANE })
}

// The session root, the git branch, and an outline of each CLAUDE.md above it.
async function projectContext($: EngineInterface) {
  const root = await $.session.root()
  const sep = root.includes('\\') ? '\\' : '/'
  const lines = [`Working directory: ${root}`]

  const branch = await gitBranch($, root, sep)
  if (branch) lines.push(`Git branch: ${branch}`)

  const files = await $.fs.ancestors({ names: ['CLAUDE.md'] }).catch(() => [])
  // Nearest first: it says the most about this project and survives the cut.
  for (const file of [...files].reverse()) {
    lines.push('', `From ${file.dir}${sep}${file.name}:`, outline(file.content, 1200))
  }
  return lines.join('\n').slice(0, CONTEXT_LIMIT)
}

async function gitBranch($: EngineInterface, root: string, sep: string) {
  try {
    let dir = root
    for (let depth = 0; depth < 6; depth++) {
      const dotGit = `${dir}${sep}.git`
      const stat = await $.fs.stat(dotGit).catch(() => null)
      if (stat) {
        let gitDir = dotGit
        if (stat.kind === 'file') {
          // A worktree's .git is a file pointing at its git dir.
          const pointer = (await $.fs.read(dotGit)).trim()
          if (!pointer.startsWith('gitdir:')) return null
          gitDir = pointer.slice('gitdir:'.length).trim()
          if (!/^([A-Za-z]:)?[\\/]/.test(gitDir)) gitDir = `${dir}${sep}${gitDir}`
        }
        const head = (await $.fs.read(`${gitDir}${sep}HEAD`)).trim()
        return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : `detached at ${head.slice(0, 8)}`
      }
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      if (cut <= 0) return null
      dir = dir.slice(0, cut)
      if (/^[A-Za-z]:$/.test(dir)) return null
    }
    return null
  } catch {
    return null
  }
}

// The first paragraph and the headings.
function outline(content: string, budget: number) {
  const lines = content.split(/\r?\n/)
  const intro: string[] = []
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') {
      if (intro.length > 0) break
      continue
    }
    intro.push(line.trim())
  }
  const headings = lines.filter(line => /^#{1,3} /.test(line))
  return [intro.join(' ').slice(0, 600), ...headings].join('\n').slice(0, budget)
}

function status(running: boolean, lastRun: LastRun | null) {
  if (running) return 'Rewriting with Haiku...'
  if (!lastRun) return ''
  const seconds = (lastRun.ms / 1000).toFixed(1)
  return `Last: ${lastRun.inChars} → ${lastRun.outChars} chars in ${seconds} s${lastRun.withContext ? ', with context' : ''}`
}

function pendingNote(pending: PendingRewrite) {
  if (pending.reason === 'dropped') {
    return `The rewrite left out ${pending.missing.join(', ')}, so it was not put in the input box.`
  }
  if (pending.reason === 'edited') {
    return 'The input box changed while Haiku was rewriting, so it was left alone.'
  }
  return 'The input box did not take the rewrite (a dialog may be open).'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('includeContext')
    await $.state.set(CONTEXT, stored === true)
    await $.state.set(RUNNING, false)
    await $.command.register({
      name: 'paraphrase',
      description: 'Rewrite a prompt into a clear Claude Code prompt with Haiku, for review before sending',
      argumentHint: '[--context | --no-context] <prompt>',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'paraphrase' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  // Sending a prompt ends the chance to undo and cancels a rewrite still running; slash commands keep both.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !/^\s*\//.test(e.text)) {
      cancel('Paraphrase cancelled: the prompt was sent.')
      await $.state.set(UNDO, null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const { value: running = false } = await $.state.get(RUNNING)
    const { value: withContext = false } = await $.state.get(CONTEXT)
    const { value: undo = null } = await $.state.get(UNDO)
    const { value: lastRun = null } = await $.state.get(LAST_RUN)

    return (
      <Box gap={1} flexWrap="wrap" alignItems="center">
        <Button
          key="paraphrase"
          hotkey="p"
          variant="primary"
          label={running ? 'Cancel' : 'Paraphrase as Claude Code Prompt'}
          onPress={() => void primary($)}
        />
        <Button
          key="context"
          hotkey="c"
          label={`${withContext ? '☑' : '☐'} Project context`}
          onPress={() => void toggleContext($)}
        />
        {undo && !running && (
          <Button
            key="undo"
            hotkey="u"
            label={undo.isUndone ? 'Redo' : 'Undo'}
            onPress={() => void toggleUndo($)}
          />
        )}
        <Text dimColor wrap="truncate-end">
          {status(running, lastRun)}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const { value: pending = null } = await $.state.get(PENDING)

    if (!pending) {
      return <Text dimColor>No rewrite waiting.</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{pendingNote(pending)}</Text>
        <Code source={pending.text} language="markdown" wrap="wrap" />
        <Box gap={1}>
          <Button key="use" hotkey="r" variant="primary" label="Replace prompt" onPress={() => void usePending($)} />
          <Button key="copy" hotkey="y" label="Copy" onPress={press => void copyPending($, press.surface)} />
          <Button key="close" role="dismiss" label="Close" onPress={() => void closePane($)} />
        </Box>
      </Box>
    )
  })
}
