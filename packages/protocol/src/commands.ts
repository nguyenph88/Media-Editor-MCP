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

export interface ApplyTransitionToAllCutsParams {
  sequenceId?: string;
  /** 0-based video track index. Default 0 (V1). */
  videoTrackIndex?: number;
  matchName?: string;
  durationSeconds?: number;
  alignment?: TransitionAlignment;
  /** Skip cuts lacking handle media instead of failing. Default true. */
  skipInsufficientHandles?: boolean;
}

export type CutStatus = "applied" | "skipped_insufficient_handles" | "error";

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
