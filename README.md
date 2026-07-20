# Claude Session Calendar

A week-calendar view of your Claude Code sessions, mined from the local
transcripts in `~/.claude/projects`.

- **Solid chips** = time slots where *you* gave an input (rounded to a
  configurable slot size, default 10 min). Click a chip for details: chunk
  duration (your input → end of Claude's work) and the conversation of that
  chunk (your inputs interleaved with Claude's text replies).
- **Translucent bands** = time where *Claude* was operating, rendered in the
  same lane as the session's chips so you can see how far the work extended
  past your input. Intervals are turn-based: from each input until the last
  assistant/tool event before your next input, so quiet stretches during
  long-running tools are bridged. A gap of more than 30 min without any event
  ends the interval (idle session resumed later).
- Projects can be shown/hidden in the sidebar (worktrees and numbered sibling
  checkouts like `food-2050-3` are collapsed into their base project).
- Navigate weeks with ◀ / ▶ or the week dropdown. Weeks start on Monday.

## Usage

```sh
pnpm install          # once
pnpm extract          # (re)scan ~/.claude/projects → public/data.json
pnpm dev              # dev server on http://localhost:5199
pnpm build            # extract + static build → dist/ (self-contained)
```

The build is fully static — serve `dist/` with any web server, e.g.
`npx serve dist`.

## Claude skill

The `session-calendar` skill (installed at `~/.claude/skills/session-calendar`)
lets you just type `/session-calendar` in any Claude Code session to refresh
the data and open the calendar.

## How it works

`scripts/extract.mjs` streams every `*.jsonl` transcript in
`~/.claude/projects/*/`, classifies each line:

- **input** — non-meta user messages typed by you (including slash commands);
  interruption markers, injected system content, tool results, and
  subagent-internal messages are excluded
- **output** — assistant text replies (excerpts, shown in the detail panel)
- **activity** — tool results, system events, sidechains, non-text assistant events

and writes `public/data.json` with sessions, inputs, outputs, and turn-based
activity intervals. All slot rounding and layout happens client-side in React.

Session titles come from the desktop app's metadata in
`~/Library/Application Support/Claude/claude-code-sessions` (matched via
`cliSessionId`). Sessions without desktop metadata (e.g. plain-CLI sessions)
fall back to their first real prompt as the title.
