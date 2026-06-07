/**
 * Command names + param/result shapes shared by the MCP server and the UXP plugin.
 */

export const COMMANDS = [
  "ping",
  "get_project_info",
  "list_sequences",
  "get_sequence_clips",
  "list_available_transitions",
  "apply_transition_to_all_cuts",
  "apply_transition_to_clip",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/**
 * Default transition. "Cross Dissolve" ships as the GPU-accelerated
 * "AE.ADBE Cross Dissolve New" on modern Premiere — verify on a live install
 * via list_available_transitions if applying fails.
 */
export const DEFAULT_TRANSITION_MATCH_NAME = "AE.ADBE Cross Dissolve New";

export const DEFAULT_TRANSITION_DURATION_SECONDS = 1.0;

export type TransitionAlignment = "center" | "start" | "end";

// ---------------------------------------------------------------------------
// Per-command param/result types
// ---------------------------------------------------------------------------

export interface PingResult {
  pong: true;
  hostVersion: string;
  pluginVersion: string;
  timestamp: string;
}

export interface ProjectInfoResult {
  name: string;
  path: string;
  sequenceCount: number;
  activeSequenceName: string | null;
}

export interface SequenceSummary {
  id: string;
  name: string;
  videoTrackCount: number;
  audioTrackCount: number;
  frameRateFps: number;
  isActive: boolean;
}

export interface ListSequencesResult {
  sequences: SequenceSummary[];
}

export interface GetSequenceClipsParams {
  /** Defaults to the active sequence. */
  sequenceId?: string;
  /** 0-based. Omit to return all video tracks. */
  videoTrackIndex?: number;
}

export interface ClipInfo {
  /** 0-based position among clips on its track, sorted by start time. */
  index: number;
  name: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  startTimecode: string;
  endTimecode: string;
}

export interface TrackClips {
  trackIndex: number;
  trackName: string;
  clips: ClipInfo[];
}

export interface GetSequenceClipsResult {
  sequenceName: string;
  frameRateFps: number;
  tracks: TrackClips[];
}

export interface ListAvailableTransitionsParams {
  /** Case-insensitive substring filter on matchName, e.g. "dissolve". */
  filter?: string;
}

export interface ListAvailableTransitionsResult {
  transitions: string[];
}

/**
 * What to do when a cut already has a transition:
 * - "ask"       — if any exist, apply NOTHING and return them in
 *                 `existingTransitions` so the client can confirm with the user
 * - "overwrite" — replace them (type + duration + alignment all change)
 * - "skip"      — leave those cuts untouched, fill only the empty cuts
 */
export type OnExistingPolicy = "ask" | "overwrite" | "skip";

export interface ApplyTransitionToAllCutsParams {
  sequenceId?: string;
  /** 0-based video track index. Default 0 (V1). */
  videoTrackIndex?: number;
  matchName?: string;
  durationSeconds?: number;
  alignment?: TransitionAlignment;
  /** Skip cuts lacking handle media instead of failing. Default true. */
  skipInsufficientHandles?: boolean;
  /** Default "ask". */
  onExisting?: OnExistingPolicy;
}

export type CutStatus =
  | "applied"
  | "skipped_insufficient_handles"
  | "skipped_existing"
  | "error";

export interface ExistingTransitionInfo {
  cutIndex: number;
  leftClip: string;
  rightClip: string;
  atSeconds: number;
  /** Best-effort display name of the transition already at this cut. */
  transitionName: string;
  durationSeconds: number;
}

export interface CutResult {
  cutIndex: number;
  leftClip: string;
  rightClip: string;
  atSeconds: number;
  status: CutStatus;
  message?: string;
}

export interface ApplyTransitionToAllCutsResult {
  trackIndex: number;
  matchName: string;
  durationSeconds: number;
  cutsFound: number;
  applied: number;
  skipped: number;
  errored: number;
  results: CutResult[];
  /**
   * True when onExisting was "ask", existing transitions were found, and
   * NOTHING was applied. The client should confirm with the user and call
   * again with onExisting "overwrite" (or "skip", when positions are known).
   */
  pendingConfirmation?: boolean;
  /** Number of transitions already on the track (count is always reliable). */
  existingCount?: number;
  /**
   * Per-cut detail of existing transitions. Premiere 26.x's UXP API returns
   * transition items as nulls (count only, no positions), so this is usually
   * empty — it lights up automatically if Adobe fixes the API.
   */
  existingTransitions?: ExistingTransitionInfo[];
}

export interface ApplyTransitionToClipParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** 0-based clip index on the track (sorted by start time). */
  clipIndex: number;
  /** Which edge of the clip receives the transition. */
  edge: "start" | "end";
  matchName?: string;
  durationSeconds?: number;
  alignment?: TransitionAlignment;
}

export interface ApplyTransitionToClipResult {
  status: CutStatus;
  clipName: string;
  message?: string;
}
