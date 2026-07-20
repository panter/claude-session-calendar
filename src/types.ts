export interface ProjectInfo {
  id: string;
  label: string;
  cwds: string[];
}

export interface SessionInfo {
  id: string;
  project: string;
  title: string;
  branch?: string;
  start: number;
  end: number;
}

export interface ToolEvent {
  t: number;
  s: string;
  /** edit | read | bash | commit | agent | tool | usage | pr | issue */
  k: string;
  f?: string;
  o?: number;
  /** link URL (k = pr | issue) */
  u?: string;
  /** link label, e.g. "repo#42" (k = pr | issue) */
  l?: string;
}

export interface InputEvent {
  t: number;
  s: string;
  text: string;
}

export interface ActivityInterval {
  s: string;
  start: number;
  end: number;
}

export interface OutputEvent {
  t: number;
  s: string;
  text: string;
}

export interface DataFile {
  generatedAt: string;
  projects: ProjectInfo[];
  sessions: SessionInfo[];
  inputs: InputEvent[];
  outputs: OutputEvent[];
  events: ToolEvent[];
  activity: ActivityInterval[];
}

/** A rendered block in the week grid. */
export interface SlotBlock {
  key: string;
  sessionId: string;
  project: string;
  dayIdx: number; // 0 = Monday
  startMin: number; // minutes since midnight
  endMin: number;
  title: string;
  texts: { t: number; text: string }[];
  kind: "input" | "activity";
  lane: number;
  lanes: number;
}
