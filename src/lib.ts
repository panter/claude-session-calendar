import type { DataFile, SlotBlock } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday 00:00 (local time) of the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function addDays(t: number, days: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

export function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtMinutesShort(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${String(min % 60).padStart(2, "0")}m`;
}

export function fmtDurationShort(ms: number): string {
  return fmtMinutesShort(Math.max(1, Math.ceil(ms / 60000)));
}

export function fmtDuration(ms: number): string {
  return fmtMinutes(Math.max(1, Math.ceil(ms / 60000)));
}

/**
 * Apportion a chunk into whole minutes per part (largest-remainder method) so
 * the parts always sum exactly to the rounded-up total — bar and numbers stay
 * consistent regardless of rounding.
 */
export function splitMinutes(
  totalMs: number,
  partsMs: number[],
  ensureIdx?: number
): { totalMin: number; parts: number[] } {
  const totalMin = Math.max(1, Math.ceil(totalMs / 60000));
  const sum = partsMs.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { totalMin, parts: partsMs.map((_, i) => (i === 0 ? totalMin : 0)) };
  const exact = partsMs.map((p) => (p / sum) * totalMin);
  const parts = exact.map(Math.floor);
  let rest = totalMin - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ frac: e - Math.floor(e), i }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k].i]++;
  // Guarantee the given part (human time) is never 0 — every chunk starts
  // with a typed prompt even if the transcript can't measure the typing time.
  // Borrow the minute from the largest other part.
  if (ensureIdx !== undefined && parts[ensureIdx] === 0) {
    const donor = parts
      .map((v, i) => ({ v, i }))
      .filter((x) => x.i !== ensureIdx)
      .sort((a, b) => b.v - a.v)[0];
    if (donor && donor.v > 0) {
      parts[donor.i]--;
      parts[ensureIdx]++;
    }
  }
  return { totalMin, parts };
}

export function fmtWeekLabel(ws: number): string {
  const end = addDays(ws, 6);
  const s = new Date(ws).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const e = new Date(end).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${s} – ${e}`;
}

export function isoWeekNumber(ws: number): number {
  const d = new Date(ws);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 3); // Thursday of this week
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - jan1.getTime()) / DAY_MS + 1) / 7);
}

function dayAndMinutes(t: number, ws: number): { dayIdx: number; min: number } | null {
  if (t < ws || t >= addDays(ws, 7)) return null;
  const d = new Date(t);
  const dayIdx = Math.floor((t - ws) / DAY_MS); // works because ws is local midnight; DST shifts <2h don't move the day for our data
  const min = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  return { dayIdx: Math.min(6, Math.max(0, dayIdx)), min };
}

interface Laneable {
  dayIdx: number;
  startMin: number;
  endMin: number;
  lane: number;
  lanes: number;
}

/** Assign side-by-side lanes to overlapping items within one day. */
function assignLanes(blocks: Laneable[]): void {
  const byDay = new Map<number, Laneable[]>();
  for (const b of blocks) {
    if (!byDay.has(b.dayIdx)) byDay.set(b.dayIdx, []);
    byDay.get(b.dayIdx)!.push(b);
  }
  for (const day of byDay.values()) {
    day.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    let cluster: Laneable[] = [];
    let clusterEnd = -1;
    const flush = () => {
      const laneEnds: number[] = [];
      for (const b of cluster) {
        let lane = laneEnds.findIndex((end) => end <= b.startMin);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(b.endMin);
        } else {
          laneEnds[lane] = b.endMin;
        }
        b.lane = lane;
      }
      for (const b of cluster) b.lanes = laneEnds.length;
      cluster = [];
    };
    for (const b of day) {
      if (cluster.length && b.startMin >= clusterEnd) flush();
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.endMin);
    }
    if (cluster.length) flush();
  }
}

export interface WeekBlocks {
  inputBlocks: SlotBlock[];
  activityBlocks: SlotBlock[];
  minHour: number;
  maxHour: number;
}

export function computeWeekBlocks(
  data: DataFile,
  ws: number,
  visibleProjects: Set<string>,
  slotMinutes: number
): WeekBlocks {
  const we = addDays(ws, 7);
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));
  const projectOf = (sid: string) => sessionById.get(sid)?.project ?? "unknown";
  const visible = (sid: string) => visibleProjects.has(projectOf(sid));

  // --- user input slots, rounded down to slotMinutes, merged per session when adjacent
  const slotMap = new Map<string, SlotBlock>();
  for (const inp of data.inputs) {
    if (inp.t < ws || inp.t >= we || !visible(inp.s)) continue;
    const dm = dayAndMinutes(inp.t, ws)!;
    const slotStart = Math.floor(dm.min / slotMinutes) * slotMinutes;
    const key = `${inp.s}:${dm.dayIdx}:${slotStart}`;
    let block = slotMap.get(key);
    if (!block) {
      const session = sessionById.get(inp.s);
      block = {
        key,
        sessionId: inp.s,
        project: projectOf(inp.s),
        dayIdx: dm.dayIdx,
        startMin: slotStart,
        endMin: Math.min(24 * 60, slotStart + slotMinutes),
        title: session?.title ?? inp.text,
        texts: [],
        kind: "input",
        lane: 0,
        lanes: 1,
      };
      slotMap.set(key, block);
    }
    block.texts.push({ t: inp.t, text: inp.text });
  }
  // merge adjacent slots of the same session into one block
  const bySession = new Map<string, SlotBlock[]>();
  for (const b of slotMap.values()) {
    const k = `${b.sessionId}:${b.dayIdx}`;
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(b);
  }
  const inputBlocks: SlotBlock[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.startMin - b.startMin);
    let cur: SlotBlock | null = null;
    for (const b of list) {
      if (cur && b.startMin <= cur.endMin) {
        cur.endMin = Math.max(cur.endMin, b.endMin);
        cur.texts.push(...b.texts);
      } else {
        if (cur) inputBlocks.push(cur);
        cur = { ...b, texts: [...b.texts] };
      }
    }
    if (cur) inputBlocks.push(cur);
  }

  // --- activity intervals clipped to days
  const activityBlocks: SlotBlock[] = [];
  for (const iv of data.activity) {
    if (iv.end < ws || iv.start >= we || !visible(iv.s)) continue;
    let cursor = Math.max(iv.start, ws);
    const end = Math.min(iv.end, we - 1);
    while (cursor <= end) {
      const dm = dayAndMinutes(cursor, ws)!;
      const dayEndT = ws + (dm.dayIdx + 1) * DAY_MS;
      const segEndT = Math.min(end, dayEndT - 1);
      const endDm = dayAndMinutes(segEndT, ws)!;
      const session = sessionById.get(iv.s);
      activityBlocks.push({
        key: `act:${iv.s}:${cursor}`,
        sessionId: iv.s,
        project: projectOf(iv.s),
        dayIdx: dm.dayIdx,
        startMin: dm.min,
        endMin: Math.max(endDm.min, dm.min + 2), // ≥2 min so it is visible
        title: session?.title ?? "",
        texts: [],
        kind: "activity",
        lane: 0,
        lanes: 1,
      });
      cursor = dayEndT;
    }
  }

  // Lanes are assigned per session-per-day so a session's input chips and its
  // operating band share the same column and visibly extend past the input slot.
  const groups = new Map<string, Laneable & { blocks: SlotBlock[] }>();
  for (const b of [...inputBlocks, ...activityBlocks]) {
    const k = `${b.sessionId}:${b.dayIdx}`;
    let g = groups.get(k);
    if (!g) {
      g = { dayIdx: b.dayIdx, startMin: b.startMin, endMin: b.endMin, lane: 0, lanes: 1, blocks: [] };
      groups.set(k, g);
    }
    g.startMin = Math.min(g.startMin, b.startMin);
    g.endMin = Math.max(g.endMin, b.endMin);
    g.blocks.push(b);
  }
  assignLanes([...groups.values()]);
  for (const g of groups.values()) {
    for (const b of g.blocks) {
      b.lane = g.lane;
      b.lanes = g.lanes;
    }
  }

  let minHour = 8;
  let maxHour = 19;
  for (const b of [...inputBlocks, ...activityBlocks]) {
    minHour = Math.min(minHour, Math.floor(b.startMin / 60));
    maxHour = Math.max(maxHour, Math.ceil(b.endMin / 60));
  }
  return { inputBlocks, activityBlocks, minHour, maxHour: Math.min(24, maxHour) };
}

// ---------- day / week summaries ----------

const TYPING_MS = 60_000;
const IDLE_GAP_MS = 5 * 60_000;
// Gaps longer than this are "dormant" — not counted as work time at all.
const DORMANT_GAP_MS = 30 * 60_000;

interface IV {
  s: number;
  e: number;
}

export interface SplitMs {
  youMs: number;
  claudeMs: number;
  idleMs: number;
}

export function splitTotal(st: SplitMs): number {
  return st.youMs + st.claudeMs + st.idleMs;
}

function mergeIvs(list: IV[]): IV[] {
  const sorted = [...list].sort((a, b) => a.s - b.s);
  const out: IV[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e);
    else out.push({ ...iv });
  }
  return out;
}

/** a minus b; both must be merged & sorted. */
function subtractIvs(a: IV[], b: IV[]): IV[] {
  const out: IV[] = [];
  let j = 0;
  for (const iv of a) {
    let s = iv.s;
    while (j < b.length && b[j].e <= s) j++;
    let k = j;
    while (k < b.length && b[k].s < iv.e) {
      if (b[k].s > s) out.push({ s, e: Math.min(b[k].s, iv.e) });
      s = Math.max(s, b[k].e);
      if (s >= iv.e) break;
      k++;
    }
    if (s < iv.e) out.push({ s, e: iv.e });
  }
  return out;
}

export interface WeekSummaries {
  /** per weekday (0 = Monday), project id → time split */
  days: Map<string, SplitMs>[];
  /** whole week, project id → time split */
  week: Map<string, SplitMs>;
}

/**
 * Per-project time splits per day, using the same semantics as the detail
 * panel: 1 min assumed typing per message, claude = operating minus typing,
 * gaps ≤5 min = you, ≤30 min = idle, longer = dormant (not counted).
 */
export function computeWeekSummaries(data: DataFile, ws: number): WeekSummaries {
  const we = addDays(ws, 7);
  const bounds = Array.from({ length: 8 }, (_, i) => addDays(ws, i));
  const sessionById = new Map(data.sessions.map((s) => [s.id, s]));

  const inputsBySession = new Map<string, number[]>();
  for (const i of data.inputs) {
    let list = inputsBySession.get(i.s);
    if (!list) inputsBySession.set(i.s, (list = []));
    list.push(i.t);
  }
  const actBySession = new Map<string, IV[]>();
  for (const a of data.activity) {
    let list = actBySession.get(a.s);
    if (!list) actBySession.set(a.s, (list = []));
    list.push({ s: a.start, e: a.end });
  }

  const days: Map<string, SplitMs>[] = Array.from({ length: 7 }, () => new Map());
  const week = new Map<string, SplitMs>();
  const add = (proj: string, kind: keyof SplitMs, s: number, e: number) => {
    s = Math.max(s, ws);
    e = Math.min(e, we);
    for (let d = 0; d < 7; d++) {
      const os = Math.max(s, bounds[d]);
      const oe = Math.min(e, bounds[d + 1]);
      if (oe <= os) continue;
      let dm = days[d].get(proj);
      if (!dm) days[d].set(proj, (dm = { youMs: 0, claudeMs: 0, idleMs: 0 }));
      dm[kind] += oe - os;
      let wm = week.get(proj);
      if (!wm) week.set(proj, (wm = { youMs: 0, claudeMs: 0, idleMs: 0 }));
      wm[kind] += oe - os;
    }
  };

  for (const [sid, times] of inputsBySession) {
    const session = sessionById.get(sid);
    if (!session || session.end < ws || session.start >= we) continue;
    const proj = session.project;
    const typing = mergeIvs(times.map((t) => ({ s: t - TYPING_MS, e: t })));
    const claudeRaw = mergeIvs(actBySession.get(sid) ?? []);
    const claude = subtractIvs(claudeRaw, typing);
    for (const iv of typing) add(proj, "youMs", iv.s, iv.e);
    for (const iv of claude) add(proj, "claudeMs", iv.s, iv.e);
    const cov = mergeIvs([...typing, ...claudeRaw]);
    for (let i = 1; i < cov.length; i++) {
      const gap = cov[i].s - cov[i - 1].e;
      if (gap <= 0) continue;
      if (gap <= IDLE_GAP_MS) add(proj, "youMs", cov[i - 1].e, cov[i].s);
      else if (gap <= DORMANT_GAP_MS) add(proj, "idleMs", cov[i - 1].e, cov[i].s);
    }
  }
  return { days, week };
}

const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#b07aa1",
  "#76b7b2",
  "#edc948",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
  "#86bcb6",
  "#d37295",
  "#a0cbe8",
  "#ffbe7d",
  "#8cd17d",
];

export function projectColor(projectIds: string[], id: string): string {
  const idx = projectIds.indexOf(id);
  return PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
}
