# Prompt Paraphrase

Turn a rough draft into a clear, well-structured prompt for Claude Code before you send it.

Prompt Paraphrase adds a **Paraphrase as Claude Code Prompt** button above the input box and a `/paraphrase` command. It rewrites your draft with Claude Haiku and puts the result back in the input box, so you can review it, edit it or undo it before you press Enter. Nothing is sent to your session until you send it yourself.

## Features

- **Rewrite in place.** One press replaces the draft in the input box with the rewritten prompt.
- **Keeps what you wrote.** File paths, class and method names, commands, code, error messages, ticket keys, IDs, numbers and quoted text are copied exactly. The rewrite adds no tasks or requirements you didn't ask for. When something the task needs is missing, it becomes a question under **Open questions** instead of a guess.
- **Stays in proportion.** A one-line request becomes a short, precise prompt, not a template, and the rewrite is in the same language as your draft.
- **Undo and Redo.** Swap between your draft and the rewrite at any time before you send. Edits you made to either version are kept.
- **Optional project context.** Tick **Project context** to let the rewrite use your project's own names (see [What it sends and reads](#what-it-sends-and-reads)). The setting is remembered across sessions.
- **Never overwrites new typing.** If you keep typing while the rewrite runs, or the rewrite dropped an `@file` mention or a `[Pasted text]` or `[Image]` placeholder, the rewrite opens in a pane instead, with **Replace prompt**, **Copy** and **Close**.
- **A command too.** `/paraphrase <prompt>` works from the keyboard, while Claude is busy, and in the VS Code extension.

## Requirements

- Claude Code **v2.1.287 or later**, which runs mods. Check with `claude --version`.
- The button shows in the terminal and in the Code tab of the Claude Desktop app. The VS Code extension runs mods but doesn't draw them: use `/paraphrase` there, and the rewrite comes back as the command's reply.

## Install

From Claude's plugin directory, once it's listed: find **Prompt Paraphrase** under **Customize > Plugins > Discover** on claude.ai, or run `/plugin directory` in Claude Code.

From GitHub, in your shell:

```bash
claude plugin marketplace add mkalawoun/prompt-paraphrase
claude plugin install prompt-paraphrase@mkalawoun
```

Then run `/reload-plugins` in an open session, or start a new one.

## Use it

### The button

1. Type your draft in the input box.
2. Press **Paraphrase as Claude Code Prompt**. While it runs, the button reads **Cancel**.
3. Review the rewrite. Press **Undo** to get your draft back, and **Redo** to return to the rewrite.
4. Press Enter when you're happy with it.

Tick **Project context** before you press the button to include it. Once the row has the focus (click it, or press ctrl+x then Tab), `p` paraphrases, `c` toggles the context and `u` is Undo.

### The command

```text
/paraphrase [--context | --no-context] <prompt>
```

Sending a command empties the input box, so the rewrite goes back into it for you to review. `--context` and `--no-context` override the **Project context** setting for that run only. If the rewrite fails or is cancelled, your text goes back into the input box.

### Left as typed

Drafts that start with `/` (a slash command) or `!` (a shell command) are not rewritten.

## What it sends and reads

- **Your draft goes to Claude Haiku**, through Claude Code's own model call, on your Claude plan or API key: the same provider your session already uses. Each rewrite is one request.
- **With Project context ticked**, that request also includes the session's working directory path, the current git branch (read from `.git/HEAD`), and the first paragraph and headings of each `CLAUDE.md` file in the working directory and the folders above it, up to 4,000 characters in all.
- **It stores one setting**, whether Project context is ticked, in the plugin's own Claude Code store.
- **Nothing else.** It makes no other network requests, starts no processes and collects no analytics. All of it is in the readable source, [`hooks/register.tsx`](hooks/register.tsx).

## Cost

Each rewrite is a single Haiku request with your draft, plus the project context when it's ticked. It counts against your own Claude usage.

## Limits

- A rewrite gives up after 60 seconds.
- **Copy** in the pane may not be available in the Desktop app. Select the text and copy it instead.

## License

[MIT](LICENSE)
