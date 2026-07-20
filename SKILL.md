---
name: session-calendar
description: Refresh and open the Claude Session Calendar — a week-calendar view of all local Claude Code sessions (user-input slots, Claude operating time, you/Claude/idle time splits, tool stats, PR links) mined from ~/.claude/projects transcripts. Use when the user asks to see the session calendar, a timeline/overview of their Claude sessions, or invokes /session-calendar.
---

# Claude Session Calendar

This skill's directory **is** the app repository
(https://github.com/panter/claude-session-calendar) — typically installed as a
symlink from `~/.claude/skills/session-calendar` to a clone of the repo.

## Steps

1. Resolve the app directory (follow the symlink):

   ```sh
   APP_DIR=$(cd ~/.claude/skills/session-calendar && pwd -P)
   ```

2. If `node_modules` is missing there, run `pnpm install` (or `npm install`).

3. Refresh the data (streams all transcripts, takes a few seconds):

   ```sh
   cd "$APP_DIR" && node scripts/extract.mjs
   ```

4. Start the dev server and show it in the browser pane:
   - Preferred: the Browser tool's `preview_start` with `{"name": "session-calendar"}`
     (defined in the repo's `.claude/launch.json`, port 5199).
   - Otherwise run `pnpm dev` in `$APP_DIR` in the background and open
     `http://localhost:5199`.
   - If a server is already running on port 5199, just reload the page — the
     extractor only rewrites `public/data.json`.

5. Tell the user the calendar is ready and mention the controls: week
   navigation (Monday start), project show/hide, slot granularity (default
   10 min), the "Show Claude operating time" toggle, and that clicking a chip
   or operating band opens a detail panel with the conversation, a
   you/Claude/idle time split, tool stats, edited files, and PR/issue links.

## Notes

- Session titles come from the macOS desktop app's metadata; on other setups
  sessions are titled by their first prompt.
- For a shareable static version: `pnpm build` produces a self-contained
  `dist/` (serve with any static file server). The extracted `data.json`
  contains conversation excerpts — treat it as private.
