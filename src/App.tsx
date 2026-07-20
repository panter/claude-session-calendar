import { useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import type { DataFile, SlotBlock } from "./types";
import {
  addDays,
  computeWeekBlocks,
  computeWeekSummaries,
  fmtDay,
  fmtDurationShort,
  fmtMinutes,
  fmtMinutesShort,
  fmtTime,
  fmtTokens,
  fmtWeekLabel,
  isoWeekNumber,
  projectColor,
  splitMinutes,
  splitTotal,
  weekStart,
  type SplitMs,
} from "./lib";

const SLOT_OPTIONS = [5, 10, 15, 30, 60];

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}

export default function App() {
  const [data, setData] = useState<DataFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slotMinutes, setSlotMinutes] = useLocalStorage("cal.slotMinutes", 10);
  const [hiddenProjects, setHiddenProjects] = useLocalStorage<string[]>("cal.hiddenProjects", []);
  const [showActivity, setShowActivity] = useLocalStorage("cal.showActivity", true);
  const [week, setWeek] = useState<number | null>(null);
  const [selected, setSelected] = useState<SlotBlock | null>(null);

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + "data.json")
      .then((r) => {
        if (!r.ok) throw new Error(`data.json missing (${r.status}) — run: pnpm extract`);
        return r.json();
      })
      .then((d: DataFile) => {
        setData(d);
        const last = d.inputs[d.inputs.length - 1];
        setWeek(weekStart(last ? last.t : Date.now()));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const projectIds = useMemo(() => data?.projects.map((p) => p.id) ?? [], [data]);

  const weeks = useMemo(() => {
    if (!data || data.inputs.length === 0) return [];
    const first = weekStart(data.inputs[0].t);
    const last = weekStart(data.inputs[data.inputs.length - 1].t);
    const list: number[] = [];
    for (let w = last; w >= first; w = addDays(w, -7)) list.push(w);
    return list;
  }, [data]);

  const visibleProjects = useMemo(() => {
    const hidden = new Set(hiddenProjects);
    return new Set(projectIds.filter((p) => !hidden.has(p)));
  }, [projectIds, hiddenProjects]);

  const blocks = useMemo(() => {
    if (!data || week === null) return null;
    return computeWeekBlocks(data, week, visibleProjects, slotMinutes);
  }, [data, week, visibleProjects, slotMinutes]);

  const summaries = useMemo(() => {
    if (!data || week === null) return null;
    return computeWeekSummaries(data, week);
  }, [data, week]);

  const splitTitle = (label: string, st: SplitMs) => {
    const { totalMin, parts } = splitMinutes(splitTotal(st), [st.claudeMs, st.youMs, st.idleMs], 1);
    return (
      `${label}: total ${fmtMinutes(totalMin)} · you ${fmtMinutes(parts[1])} · ` +
      `Claude ${fmtMinutes(parts[0])}` +
      (parts[2] > 0 ? ` · idle ${fmtMinutes(parts[2])}` : "")
    );
  };

  // Full "chunk" for the selected block: your inputs interleaved with Claude's
  // replies, from the first input of the slot to the end of the operating turn.
  const chunk = useMemo(() => {
    if (!selected || !data) return null;
    // Each human message is assumed to take 1 min to type, ending at its
    // timestamp — so the chunk starts 1 min before the first message.
    const TYPING_MS = 60 * 1000;
    const IDLE_GAP_MS = 5 * 60 * 1000;
    const firstInputT = Math.min(...selected.texts.map((m) => m.t));
    const lastT = Math.max(...selected.texts.map((m) => m.t));
    const nextInput = data.inputs.find((i) => i.s === selected.sessionId && i.t > lastT);
    const bound = nextInput ? nextInput.t : Infinity;
    let end = lastT;
    const claudeIvs: { s: number; e: number }[] = [];
    for (const iv of data.activity) {
      if (iv.s === selected.sessionId && iv.start >= firstInputT && iv.start < bound) {
        end = Math.max(end, iv.end);
        claudeIvs.push({ s: iv.start, e: iv.end });
      }
    }
    const start = firstInputT - TYPING_MS;
    const msgs = [
      ...selected.texts.map((m) => ({ ...m, role: "you" as const })),
      ...data.outputs
        .filter((o) => o.s === selected.sessionId && o.t >= firstInputT && o.t <= end)
        .map((o) => ({ t: o.t, text: o.text, role: "claude" as const })),
    ].sort((a, b) => a.t - b.t);

    const merge = (list: { s: number; e: number }[]) => {
      const sorted = [...list].sort((a, b) => a.s - b.s);
      const out: { s: number; e: number }[] = [];
      for (const iv of sorted) {
        const last = out[out.length - 1];
        if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e);
        else out.push({ ...iv });
      }
      return out;
    };
    const clip = (iv: { s: number; e: number }) => ({
      s: Math.max(iv.s, start),
      e: Math.min(iv.e, end),
    });
    const typing = merge(
      selected.texts.map((m) => clip({ s: m.t - TYPING_MS, e: m.t }))
    ).filter((iv) => iv.e > iv.s);
    const typingMs = typing.reduce((a, iv) => a + (iv.e - iv.s), 0);

    // Claude time excludes minutes you were (assumed) typing — typing wins.
    let claudeMs = 0;
    for (const civ of claudeIvs.map(clip)) {
      if (civ.e <= civ.s) continue;
      let ms = civ.e - civ.s;
      for (const tiv of typing) {
        const o = Math.min(civ.e, tiv.e) - Math.max(civ.s, tiv.s);
        if (o > 0) ms -= o;
      }
      claudeMs += Math.max(0, ms);
    }

    // Uncovered gaps: short ones are your reading/thinking time, long ones idle.
    const covered = merge([...claudeIvs.map(clip), ...typing].filter((iv) => iv.e > iv.s));
    let youMs = typingMs;
    let idleMs = 0;
    let cursor = start;
    const classifyGap = (gap: number) => {
      if (gap <= 0) return;
      if (gap > IDLE_GAP_MS) idleMs += gap;
      else youMs += gap;
    };
    for (const c of covered) {
      classifyGap(c.s - cursor);
      cursor = Math.max(cursor, c.e);
    }
    classifyGap(end - cursor);

    const totalMs = end - start;
    const rest = Math.max(0, totalMs - claudeMs - youMs - idleMs);
    const { totalMin, parts } = splitMinutes(totalMs, [claudeMs, youMs + rest, idleMs], 1);

    // Tool/usage stats for the chunk.
    const stats = { edits: 0, reads: 0, bash: 0, commits: 0, agents: 0, tokens: 0 };
    const files = new Set<string>();
    const links = new Map<string, { k: string; l: string }>();
    for (const ev of data.events) {
      if (ev.s !== selected.sessionId || ev.t < start || ev.t > end) continue;
      if (ev.k === "edit") {
        stats.edits++;
        if (ev.f) files.add(ev.f);
      } else if (ev.k === "read") stats.reads++;
      else if (ev.k === "bash") stats.bash++;
      else if (ev.k === "commit") stats.commits++;
      else if (ev.k === "agent") stats.agents++;
      else if (ev.k === "usage") stats.tokens += ev.o ?? 0;
      else if ((ev.k === "pr" || ev.k === "issue") && ev.u && ev.l) {
        links.set(ev.u, { k: ev.k, l: ev.l });
      }
    }
    const outcome = [...msgs].reverse().find((m) => m.role === "claude")?.text;

    return {
      msgs,
      totalMin,
      claudeMin: parts[0],
      youMin: parts[1],
      idleMin: parts[2],
      firstT: start,
      end,
      stats,
      files: [...files],
      links: [...links.entries()].map(([u, v]) => ({ u, ...v })),
      outcome,
    };
  }, [selected, data]);

  // Clicking an operating band selects the input chunk that started it.
  const selectFromActivity = (b: SlotBlock) => {
    if (!blocks || week === null) return;
    const bandStart = week + b.dayIdx * 86400000 + b.startMin * 60000;
    let best: SlotBlock | null = null;
    let bestT = -Infinity;
    let earliest: SlotBlock | null = null;
    let earliestT = Infinity;
    for (const ib of blocks.inputBlocks) {
      if (ib.sessionId !== b.sessionId) continue;
      const t = Math.min(...ib.texts.map((m) => m.t));
      if (t <= bandStart + 60000 && t > bestT) {
        best = ib;
        bestT = t;
      }
      if (t < earliestT) {
        earliest = ib;
        earliestT = t;
      }
    }
    setSelected(best ?? earliest);
  };

  if (error) return <div className="empty">⚠️ {error}</div>;
  if (!data || week === null || !blocks) return <div className="empty">Loading…</div>;

  const { inputBlocks, activityBlocks, minHour, maxHour } = blocks;
  const totalMin = (maxHour - minHour) * 60;
  const toPct = (min: number) => ((min - minHour * 60) / totalMin) * 100;
  const today = weekStart(Date.now()) === week ? Math.floor((Date.now() - week) / 86400000) : -1;

  const toggleProject = (id: string) =>
    setHiddenProjects((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );

  const sessionCount = new Set(inputBlocks.map((b) => b.sessionId)).size;

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Claude sessions</h1>
        <div className="week-nav">
          <button onClick={() => setWeek(addDays(week, -7))} title="Previous week">◀</button>
          <select value={week} onChange={(e) => setWeek(Number(e.target.value))}>
            {weeks.map((w) => (
              <option key={w} value={w}>
                W{isoWeekNumber(w)} · {fmtWeekLabel(w)}
              </option>
            ))}
            {!weeks.includes(week) && <option value={week}>{fmtWeekLabel(week)}</option>}
          </select>
          <button onClick={() => setWeek(addDays(week, 7))} title="Next week">▶</button>
        </div>
        <button className="today-btn" onClick={() => setWeek(weekStart(Date.now()))}>
          Jump to current week
        </button>

        <div className="control">
          <label>Slot granularity</label>
          <select value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))}>
            {SLOT_OPTIONS.map((m) => (
              <option key={m} value={m}>{m} min</option>
            ))}
          </select>
        </div>
        <label className="control checkbox">
          <input
            type="checkbox"
            checked={showActivity}
            onChange={(e) => setShowActivity(e.target.checked)}
          />
          Show Claude operating time
        </label>

        <div className="projects">
          <div className="projects-head">
            <label>Projects</label>
            <span>
              <a onClick={() => setHiddenProjects([])}>all</a>
              {" · "}
              <a onClick={() => setHiddenProjects(projectIds)}>none</a>
            </span>
          </div>
          {data.projects.map((p) => {
            const st = summaries?.week.get(p.id);
            return (
              <label
                key={p.id}
                className="project-row"
                title={(st ? splitTitle(p.label, st) + "\n" : "") + p.cwds.join("\n")}
              >
                <input
                  type="checkbox"
                  checked={visibleProjects.has(p.id)}
                  onChange={() => toggleProject(p.id)}
                />
                <span className="dot" style={{ background: projectColor(projectIds, p.id) }} />
                <span className="pr-name">{p.label}</span>
                {st && <span className="pr-time">{fmtDurationShort(splitTotal(st))}</span>}
              </label>
            );
          })}
          {summaries && (
            <div className="week-total">
              {(() => {
                const sum = { youMs: 0, claudeMs: 0, idleMs: 0 };
                for (const [p, st] of summaries.week) {
                  if (!visibleProjects.has(p)) continue;
                  sum.youMs += st.youMs;
                  sum.claudeMs += st.claudeMs;
                  sum.idleMs += st.idleMs;
                }
                return splitTotal(sum) > 0 ? splitTitle("Σ week", sum) : "no time this week";
              })()}
            </div>
          )}
        </div>

        <div className="legend">
          <div><span className="legend-input" /> you gave input</div>
          <div><span className="legend-activity" /> Claude operating</div>
        </div>

        <div className="meta">
          {sessionCount} session{sessionCount === 1 ? "" : "s"} this week · data from{" "}
          {new Date(data.generatedAt).toLocaleString()}
        </div>

        {selected && (
          <div className="detail">
            <div className="detail-head">
              <span className="dot" style={{ background: projectColor(projectIds, selected.project) }} />
              <strong>{selected.project}</strong>
              <button onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="detail-title">{selected.title}</div>
            {chunk?.outcome && (
              <div className="detail-outcome md">
                <Streamdown>{chunk.outcome}</Streamdown>
              </div>
            )}
            {chunk && (
              <div className="detail-time">
                {fmtDay(addDays(week, selected.dayIdx))} · {fmtTime(chunk.firstT)}–{fmtTime(chunk.end)}
                {" · "}
                <strong>{fmtMinutes(chunk.totalMin)}</strong>
                <div className="detail-split">
                  <span>
                    <i className="swatch seg-you" /> you{" "}
                    <strong>{fmtMinutesShort(chunk.youMin)}</strong>
                  </span>
                  <span>
                    <i className="swatch seg-claude" /> Claude{" "}
                    <strong>{fmtMinutesShort(chunk.claudeMin)}</strong>
                  </span>
                  {chunk.idleMin > 0 && (
                    <span>
                      <i className="swatch seg-idle" /> idle{" "}
                      <strong>{fmtMinutesShort(chunk.idleMin)}</strong>
                    </span>
                  )}
                </div>
                <div className="split-bar">
                  <div
                    className="seg-you"
                    style={{ width: `${(100 * chunk.youMin) / chunk.totalMin}%` }}
                  />
                  <div
                    className="seg-claude"
                    style={{ width: `${(100 * chunk.claudeMin) / chunk.totalMin}%` }}
                  />
                  <div
                    className="seg-idle"
                    style={{ width: `${(100 * chunk.idleMin) / chunk.totalMin}%` }}
                  />
                </div>
              </div>
            )}
            {chunk && (
              <div className="detail-stats">
                {chunk.stats.edits > 0 && (
                  <span>✎ {chunk.stats.edits} edit{chunk.stats.edits > 1 ? "s" : ""}</span>
                )}
                {chunk.stats.commits > 0 && (
                  <span>⇡ {chunk.stats.commits} commit{chunk.stats.commits > 1 ? "s" : ""}</span>
                )}
                {chunk.stats.bash > 0 && <span>$ {chunk.stats.bash} cmds</span>}
                {chunk.stats.reads > 0 && <span>👁 {chunk.stats.reads} reads</span>}
                {chunk.stats.agents > 0 && (
                  <span>🤖 {chunk.stats.agents} agent{chunk.stats.agents > 1 ? "s" : ""}</span>
                )}
                {chunk.stats.tokens > 0 && <span>≈{fmtTokens(chunk.stats.tokens)} tok</span>}
                {data.sessions.find((s) => s.id === selected.sessionId)?.branch && (
                  <span title="git branch">
                    ⎇ {data.sessions.find((s) => s.id === selected.sessionId)!.branch}
                  </span>
                )}
              </div>
            )}
            {chunk && chunk.links.length > 0 && (
              <div className="detail-links">
                {chunk.links.slice(0, 6).map((l) => (
                  <a key={l.u} href={l.u} target="_blank" rel="noreferrer" className="link-chip" title={l.u}>
                    {l.k === "issue" ? "◉" : "⤳"} {l.l}
                  </a>
                ))}
              </div>
            )}
            {chunk && chunk.files.length > 0 && (
              <div className="detail-files">
                {chunk.files.slice(0, 8).map((f) => (
                  <span key={f} className="file-chip" title={f}>
                    {f.split("/").pop()}
                  </span>
                ))}
                {chunk.files.length > 8 && (
                  <span className="file-chip more">+{chunk.files.length - 8}</span>
                )}
              </div>
            )}
            <ul className="detail-msgs">
              {chunk?.msgs.map((m, i) => (
                <li key={i} className={m.role}>
                  <span className="msg-time">{fmtTime(m.t)}</span>{" "}
                  <span className="msg-role">{m.role === "you" ? "You" : "Claude"}</span>
                  <div className="md">
                    <Streamdown>{m.text}</Streamdown>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <main className="calendar">
        <div className="day-headers">
          <div className="gutter" />
          {Array.from({ length: 7 }, (_, i) => {
            const rows = summaries
              ? [...summaries.days[i].entries()].sort(
                  (a, b) => splitTotal(b[1]) - splitTotal(a[1])
                )
              : [];
            const daySum = { youMs: 0, claudeMs: 0, idleMs: 0 };
            for (const [p, st] of rows) {
              if (!visibleProjects.has(p)) continue;
              daySum.youMs += st.youMs;
              daySum.claudeMs += st.claudeMs;
              daySum.idleMs += st.idleMs;
            }
            return (
              <div key={i} className={"day-header" + (i === today ? " today" : "")}>
                <div className="dh-date">{fmtDay(addDays(week, i))}</div>
                {rows.length > 0 && (
                  <div className="day-summary">
                    {rows.slice(0, 6).map(([p, st]) => (
                      <div
                        key={p}
                        className={"ds-row" + (visibleProjects.has(p) ? "" : " off")}
                        onClick={() => toggleProject(p)}
                        title={`${splitTitle(p, st)}\nclick to ${visibleProjects.has(p) ? "hide" : "show"} project`}
                      >
                        <span className="dot" style={{ background: projectColor(projectIds, p) }} />
                        <span className="ds-name">{p}</span>
                        <span className="ds-time">{fmtDurationShort(splitTotal(st))}</span>
                      </div>
                    ))}
                    {rows.length > 6 && <div className="ds-more">+{rows.length - 6} more</div>}
                    {splitTotal(daySum) > 0 && (
                      <div className="ds-row ds-total" title={splitTitle("Σ day", daySum)}>
                        <span className="ds-name">Σ</span>
                        <span className="ds-time">{fmtDurationShort(splitTotal(daySum))}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="grid-scroll">
          <div className="grid" style={{ height: `${(maxHour - minHour) * 48}px` }}>
            <div className="gutter">
              {Array.from({ length: maxHour - minHour }, (_, i) => (
                <div key={i} className="hour-label" style={{ top: `${toPct((minHour + i) * 60)}%` }}>
                  {String(minHour + i).padStart(2, "0")}:00
                </div>
              ))}
            </div>
            {Array.from({ length: 7 }, (_, day) => (
              <div key={day} className={"day-col" + (day === today ? " today" : "")}>
                {Array.from({ length: maxHour - minHour }, (_, i) => (
                  <div key={i} className="hour-line" style={{ top: `${toPct((minHour + i) * 60)}%` }} />
                ))}
                {showActivity &&
                  activityBlocks
                    .filter((b) => b.dayIdx === day)
                    .map((b) => {
                      const width = 92 / b.lanes;
                      return (
                        <div
                          key={b.key}
                          className="block activity"
                          onClick={() => selectFromActivity(b)}
                          title={`${b.title}\nClaude operating ${fmtTime(week + day * 86400000 + b.startMin * 60000)}–${fmtTime(week + day * 86400000 + b.endMin * 60000)} — click for details`}
                          style={{
                            top: `${toPct(b.startMin)}%`,
                            height: `${toPct(b.endMin) - toPct(b.startMin)}%`,
                            left: `${4 + b.lane * width}%`,
                            width: `${width - 1}%`,
                            background: projectColor(projectIds, b.project),
                          }}
                        />
                      );
                    })}
                {inputBlocks
                  .filter((b) => b.dayIdx === day)
                  .map((b) => {
                    const width = 92 / b.lanes;
                    return (
                      <div
                        key={b.key}
                        className={"block input" + (selected?.key === b.key ? " selected" : "")}
                        onClick={() => setSelected(b)}
                        title={`${b.title}\n${b.texts.length} message${b.texts.length === 1 ? "" : "s"} — click for details`}
                        style={{
                          top: `${toPct(b.startMin)}%`,
                          height: `${Math.max(1.2, toPct(b.endMin) - toPct(b.startMin))}%`,
                          left: `${4 + b.lane * width}%`,
                          width: `${width - 1}%`,
                          borderColor: projectColor(projectIds, b.project),
                          background: projectColor(projectIds, b.project) + "d9",
                        }}
                      >
                        <span className="block-title">{b.title}</span>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
