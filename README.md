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

This repo doubles as a Claude Code skill ([SKILL.md](SKILL.md) at the repo
root): once installed, typing `/session-calendar` in any Claude Code session
refreshes the data and opens the calendar.

### Install

Clone the repo and symlink it into your user-level skills directory:

```sh
git clone https://github.com/panter/claude-session-calendar.git ~/git/claude-session-calendar
ln -s ~/git/claude-session-calendar ~/.claude/skills/session-calendar
cd ~/git/claude-session-calendar && pnpm install
```

Restart Claude Code (or start a new session) and `/session-calendar` is
available everywhere.

### Update

Because the skill directory is a symlink to the clone, updating is just:

```sh
cd ~/git/claude-session-calendar && git pull && pnpm install
```

### Other ways to distribute skills

There is no single blessed channel yet; the common options are:

- **Copy/symlink into `~/.claude/skills/`** (user-wide) or `.claude/skills/`
  (per project, shareable via the project repo) — what this README uses.
- **Claude Code plugins**: a marketplace repo with a
  `.claude-plugin/marketplace.json` can bundle skills; users install via
  `/plugin marketplace add <owner>/<repo>` and `/plugin install …`. Worth it
  when you distribute several skills/commands together.
- **The `skills` CLI** (skills.sh): `npx skills add <owner>/<repo>` installs
  SKILL.md-based skills from GitHub repos across different agents. Since this
  repo has a root-level `SKILL.md`, it should be discoverable that way too.

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
