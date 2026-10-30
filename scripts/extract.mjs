#!/usr/bin/env node
/**
 * Extracts interaction data from Claude Code transcripts (~/.claude/projects)
 * into public/data.json for the calendar UI.
 *
 * Output:
 *   projects: [{ id, label, cwds: [...] }]
 *   sessions: [{ id, project, title, source, start, end }]
 *   inputs:   [{ t, s, text }]          — user prompts (t = epoch ms, s = sessionId)
 *   activity: [{ s, start, end }]       — merged intervals where Claude was working
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
// Desktop app session metadata — carries the human-readable session titles.
const DESKTOP_SESSIONS_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code-sessions"
);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_FILE = path.join(ROOT, "public", "data.json");

const MAX_INPUT_TEXT = 280;
const MAX_OUTPUT_TEXT = 300;
// Within a turn, an event gap longer than this ends the operating interval
// (e.g. a session left idle overnight and resumed the next morning).
const MAX_TURN_GAP_MS = 30 * 60 * 1000;
const MAX_TITLE = 70;

function projectLabelFromCwd(cwd) {
  if (!cwd) return null;
  let p = cwd.replace(/\/\.claude\/worktrees\/[^/]+$/, "");
  const home = os.homedir();
  if (p.startsWith(home)) p = p.slice(home.length + 1);
  p = p.replace(/^git\//, "");
  const segs = p.split("/").filter(Boolean);
  let label = segs[segs.length - 1] || "other";
  // collapse sibling checkouts like food-2050-2 / food-2050-3 into one project
  label = label.replace(/-(\d{1,2})$/, "");
  return label;
}

// Fallback when no line in the transcript carries a cwd.
function projectLabelFromFolder(folderName) {
  const guess = folderName.replace(/^-/, "/").replaceAll("-", "/");
  return projectLabelFromCwd(guess);
}

function cleanText(raw) {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns { kind: "input"|"output"|"activity", text? } | null */
function classifyLine(line) {
  if (!line.timestamp) return null;
  const type = line.type;

  if (type === "assistant") {
    if (line.isSidechain) return { kind: "activity" };
    const content = line.message?.content;
    const text = Array.isArray(content)
      ? cleanText(
          content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join(" ")
        )
      : "";
    return text ? { kind: "output", text } : { kind: "activity" };
  }
  if (type === "system") return { kind: "activity" };
  if (type !== "user") return null;

  // Subagent-internal messages and tool results = Claude operating, not user input.
  if (line.isSidechain || line.toolUseResult) return { kind: "activity" };
  if (line.isMeta) return null;
  if (line.userType && line.userType !== "external") return { kind: "activity" };

  const content = line.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((c) => c.type === "tool_result")) return { kind: "activity" };
    text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join(" ");
  } else {
    return null;
  }

  // Slash commands typed by the user count as input.
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    return { kind: "input", text: `${cmd[1].trim()} ${args?.[1]?.trim() ?? ""}`.trim() };
  }
  // Injected/meta content is not user input.
  if (/^\s*</.test(text)) return null;
  // Interruption markers are UI artifacts, not prompts.
  if (/^\s*\[Request interrupted/.test(text)) return { kind: "activity" };
  if (line.isCompactSummary || /^This session is being continued/.test(text)) {
    return { kind: "activity" };
  }
  text = cleanText(text);
  if (!text) return null;
  return { kind: "input", text };
}

function shortPath(p, cwd) {
  if (!p) return p;
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  const home = os.homedir();
  if (p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

// PR / MR / issue URLs (GitHub + GitLab, incl. self-hosted GitLab paths).
const LINK_RE = /https?:\/\/[^\s)\]'"`>]+\/(?:pull|issues|merge_requests)\/\d+/g;

/** Collect PR/MR/issue links from message text (dedup: same URL ≤5 min apart). */
function extractLinks(text, t, events, lastLinkAt) {
  for (const m of text.matchAll(LINK_RE)) {
    const u = m[0].replace(/[.,;:]+$/, "");
    const last = lastLinkAt.get(u);
    if (last !== undefined && t - last < 5 * 60 * 1000) continue;
    lastLinkAt.set(u, t);
    const parts = u.split("/");
    const i = parts.findIndex((p) => p === "pull" || p === "issues" || p === "merge_requests");
    const repo = parts[i - 1] === "-" ? parts[i - 2] : parts[i - 1];
    events.push({
      t,
      k: parts[i] === "issues" ? "issue" : "pr",
      u,
      l: `${repo}#${parts[i + 1]}`,
    });
  }
}

/** Extract tool-call events and token usage from an assistant line. */
function extractAssistantEvents(line, t, cwd, events, usageByMsg) {
  const content = line.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type !== "tool_use") continue;
      const name = b.name || "";
      if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) {
        events.push({ t, k: "edit", f: shortPath(b.input?.file_path, cwd) });
      } else if (name === "Read") {
        events.push({ t, k: "read", f: shortPath(b.input?.file_path, cwd) });
      } else if (name === "Bash") {
        const cmd = b.input?.command || "";
        events.push({ t, k: /\bgit commit\b/.test(cmd) ? "commit" : "bash" });
      } else if (name === "Task" || name === "Agent" || name === "Workflow") {
        events.push({ t, k: "agent" });
      } else {
        events.push({ t, k: "tool" });
      }
    }
  }
  const usage = line.message?.usage;
  const id = line.message?.id;
  if (usage && id) {
    const prev = usageByMsg.get(id);
    usageByMsg.set(id, {
      t: Math.min(prev?.t ?? t, t),
      o: Math.max(prev?.o ?? 0, usage.output_tokens || 0),
    });
  }
}

async function parseTranscript(file, seenUuids) {
  const sessionId = path.basename(file, ".jsonl");
  const inputs = [];
  const outputs = [];
  const events = [];
  const usageByMsg = new Map();
  const lastLinkAt = new Map();
  const activityTs = [];
  let cwd = null;
  let branch = null;
  let entrypoint = null;
  let firstT = Infinity;
  let lastT = -Infinity;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!cwd && line.cwd) cwd = line.cwd;
    if (line.gitBranch) branch = line.gitBranch;
    if (!entrypoint && line.entrypoint) entrypoint = line.entrypoint;
    // Forked sessions are transcript copies sharing the message uuids of the
    // common prefix — count each message only once (owned by the oldest file).
    if (line.uuid) {
      if (seenUuids.has(line.uuid)) continue;
      seenUuids.add(line.uuid);
    }
    const cls = classifyLine(line);
    if (!cls) continue;
    const t = Date.parse(line.timestamp);
    if (Number.isNaN(t)) continue;
    firstT = Math.min(firstT, t);
    lastT = Math.max(lastT, t);
    if (line.type === "assistant") extractAssistantEvents(line, t, cwd, events, usageByMsg);
    if (cls.kind === "input") {
      extractLinks(cls.text, t, events, lastLinkAt);
      inputs.push({ t, text: cls.text.slice(0, MAX_INPUT_TEXT) });
    } else if (cls.kind === "output") {
      extractLinks(cls.text, t, events, lastLinkAt);
      const text = cls.text.slice(0, MAX_OUTPUT_TEXT);
      const prev = outputs[outputs.length - 1];
      if (!prev || prev.text !== text) outputs.push({ t, text });
      activityTs.push(t);
    } else {
      activityTs.push(t);
    }
  }
  if (inputs.length === 0) return null;

  inputs.sort((a, b) => a.t - b.t);
  activityTs.sort((a, b) => a - b);

  // Turn-based operating intervals: from each user input until the last
  // assistant/tool event before the next input. This bridges quiet stretches
  // inside a turn (e.g. long-running tool calls) while leaving genuine
  // waiting-for-user time empty.
  const intervals = [];
  let p = 0;
  for (let i = 0; i < inputs.length; i++) {
    const start = inputs[i].t;
    const next = i + 1 < inputs.length ? inputs[i + 1].t : Infinity;
    while (p < activityTs.length && activityTs[p] < start) p++;
    let end = start;
    while (p < activityTs.length && activityTs[p] < next) {
      if (activityTs[p] - end > MAX_TURN_GAP_MS) break;
      end = Math.max(end, activityTs[p]);
      p++;
    }
    const last = intervals[intervals.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      intervals.push({ start, end });
    }
  }

  const firstReal = inputs.find((i) => !i.text.startsWith("/")) ?? inputs[0];
  const title =
    firstReal.text.length > MAX_TITLE
      ? firstReal.text.slice(0, MAX_TITLE - 1).trimEnd() + "…"
      : firstReal.text;

  for (const u of usageByMsg.values()) {
    if (u.o > 0) events.push({ t: u.t, k: "usage", o: u.o });
  }
  events.sort((a, b) => a.t - b.t);

  return {
    sessionId,
    cwd,
    branch,
    entrypoint,
    title,
    inputs,
    outputs,
    events,
    intervals,
    start: firstT,
    end: lastT,
  };
}

/** Map of CLI session id (= transcript filename) → desktop app session title. */
function loadDesktopTitles() {
  const titles = new Map();
  let stack;
  try {
    stack = fs.readdirSync(DESKTOP_SESSIONS_DIR).map((d) => path.join(DESKTOP_SESSIONS_DIR, d));
  } catch {
    return titles; // not on macOS desktop app, or dir missing
  }
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      stack.push(...fs.readdirSync(p).map((f) => path.join(p, f)));
    } else if (p.endsWith(".json")) {
      try {
        const meta = JSON.parse(fs.readFileSync(p, "utf8"));
        if (meta.cliSessionId && meta.title) titles.set(meta.cliSessionId, meta.title);
      } catch {
        // ignore unreadable metadata
      }
    }
  }
  return titles;
}

async function main() {
  const desktopTitles = loadDesktopTitles();
  const folders = fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  const projects = new Map(); // label -> { id, label, cwds:Set }
  const sessions = [];
  const inputs = [];
  const outputs = [];
  const events = []; // tool calls & usage; e.s = index into sessions
  const activity = [];
  let files = 0;

  // Oldest transcript first, so shared (forked) history belongs to the original.
  const transcriptFiles = [];
  for (const folder of folders) {
    const dir = path.join(PROJECTS_DIR, folder.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      let birth = 0;
      try {
        const st = fs.statSync(p);
        birth = st.birthtimeMs || st.mtimeMs;
      } catch {
        continue;
      }
      transcriptFiles.push({ p, folderName: folder.name, birth });
    }
  }
  transcriptFiles.sort((a, b) => a.birth - b.birth);

  const seenUuids = new Set();
  for (const { p, folderName } of transcriptFiles) {
    {
      files++;
      const parsed = await parseTranscript(p, seenUuids).catch(() => null);
      if (!parsed) continue;
      const label =
        projectLabelFromCwd(parsed.cwd) ?? projectLabelFromFolder(folderName) ?? "unknown";
      if (!projects.has(label)) projects.set(label, { id: label, label, cwds: new Set() });
      if (parsed.cwd) projects.get(label).cwds.add(parsed.cwd);

      sessions.push({
        id: parsed.sessionId,
        project: label,
        title: desktopTitles.get(parsed.sessionId) ?? parsed.title,
        branch: parsed.branch ?? undefined,
        source: parsed.entrypoint ?? undefined,
        start: parsed.start,
        end: parsed.end,
      });
      for (const i of parsed.inputs) inputs.push({ t: i.t, s: parsed.sessionId, text: i.text });
      for (const o of parsed.outputs) outputs.push({ t: o.t, s: parsed.sessionId, text: o.text });
      for (const e of parsed.events) events.push({ ...e, s: parsed.sessionId });
      for (const iv of parsed.intervals)
        activity.push({ s: parsed.sessionId, start: iv.start, end: iv.end });
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    projects: [...projects.values()]
      .map((p) => ({ ...p, cwds: [...p.cwds].sort() }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    sessions: sessions.sort((a, b) => a.start - b.start),
    inputs: inputs.sort((a, b) => a.t - b.t),
    outputs: outputs.sort((a, b) => a.t - b.t),
    events: events.sort((a, b) => a.t - b.t),
    activity: activity.sort((a, b) => a.start - b.start),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(
    `Scanned ${files} transcripts → ${sessions.length} sessions, ${inputs.length} inputs, ` +
      `${activity.length} activity intervals across ${out.projects.length} projects.`
  );
  console.log(`Wrote ${OUT_FILE}`);
}

main();
