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
  "add_markers",
  "get_audio_clips",
  "list_project_items",
  "import_files",
  "place_clip",
  "remove_clips",
  "create_sequence",
  "insert_mogrt",
  "get_mogrt_params",
  "set_mogrt_param",
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

// ---------------------------------------------------------------------------
// Editing primitives (Phase 2)
// ---------------------------------------------------------------------------

export interface MarkerSpec {
  seconds: number;
  name?: string;
  comments?: string;
  /** Premiere marker color index (0-7: green, red, magenta, orange, yellow, white, blue, cyan). */
  colorIndex?: number;
  durationSeconds?: number;
}

export interface AddMarkersParams {
  sequenceId?: string;
  markers: MarkerSpec[];
  /** Remove all existing sequence markers first. Default false. */
  clearExisting?: boolean;
}

export interface AddMarkersResult {
  added: number;
  removed: number;
}

export interface GetAudioClipsParams {
  sequenceId?: string;
  /** 0-based audio track index (A1 = 0). Omit for all audio tracks. */
  audioTrackIndex?: number;
}

export interface AudioClipInfo extends ClipInfo {
  /** Absolute path of the source media file (for external analysis). */
  mediaPath: string | null;
}

export interface GetAudioClipsResult {
  sequenceName: string;
  tracks: Array<{ trackIndex: number; trackName: string; clips: AudioClipInfo[] }>;
}

export interface ProjectItemInfo {
  name: string;
  /** "clip" | "folder" | "other" */
  type: string;
  mediaPath: string | null;
  binPath: string;
}

export interface ListProjectItemsResult {
  items: ProjectItemInfo[];
}

export interface ImportFilesParams {
  /** Absolute file paths to import into the project root bin. */
  paths: string[];
}

export interface ImportFilesResult {
  ok: boolean;
  imported: string[];
}

export interface PlaceClipParams {
  sequenceId?: string;
  /** Project item name as shown in the bin (see list_project_items). */
  projectItemName: string;
  /** Timeline position for the clip start. */
  atSeconds: number;
  videoTrackIndex: number;
  /** Default: same as videoTrackIndex. */
  audioTrackIndex?: number;
  /** Source in/out (seconds within the media) to slice before placing. */
  inSeconds?: number;
  outSeconds?: number;
  /** "overwrite" replaces whatever occupies the range (default); "insert" ripples. */
  mode?: "overwrite" | "insert";
}

export interface PlaceClipResult {
  ok: boolean;
  placedAtSeconds: number;
  videoTrackIndex: number;
  clipName: string;
}

export interface RemoveClipsParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** 0-based clip indexes on that track (sorted by start time). */
  clipIndexes: number[];
  /** Close the gaps (ripple delete). Default false. */
  ripple?: boolean;
}

export interface RemoveClipsResult {
  removed: number;
}

export interface CreateSequenceParams {
  name: string;
  /** Bin item names; sequence settings derive from the first item's media. */
  fromProjectItemNames: string[];
  /** Make it the active sequence. Default true. */
  activate?: boolean;
}

export interface CreateSequenceResult {
  sequenceName: string;
  sequenceId: string;
}

// ---------------------------------------------------------------------------
// MOGRT (Motion Graphics Template) support — prototype, API surface partially
// verified (SequenceEditor exposes a MOGRT insert action per M2 discovery).
// ---------------------------------------------------------------------------

export interface InsertMogrtParams {
  sequenceId?: string;
  /** Absolute path to a .mogrt file on disk. */
  mogrtPath: string;
  /** Timeline position for the graphic's start. */
  atSeconds: number;
  videoTrackIndex: number;
  /** Default: same as videoTrackIndex. */
  audioTrackIndex?: number;
}

export interface InsertMogrtResult {
  ok: boolean;
  insertedAtSeconds: number;
  videoTrackIndex: number;
  mogrtName: string;
  /** Which editor method name worked — informs future calls. */
  methodUsed: string;
}

/** One adjustable parameter of a MOGRT clip's component. */
export interface MogrtParamInfo {
  componentIndex: number;
  componentMatchName: string;
  paramIndex: number;
  displayName: string;
  /** Current value if readable; otherwise a shape dump of the value object. */
  value: unknown;
  /** "string" | "number" | "boolean" | "color" | "unknown:<shape>" */
  valueType: string;
}

export interface GetMogrtParamsParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** 0-based clip index on that track (sorted by start time). */
  clipIndex: number;
}

export interface GetMogrtParamsResult {
  clipName: string;
  params: MogrtParamInfo[];
  /** Raw shape dumps for anything the prototype couldn't interpret. */
  discoveryNotes: string[];
}

export interface SetMogrtParamParams {
  sequenceId?: string;
  videoTrackIndex: number;
  clipIndex: number;
  /** Component + param indexes as returned by get_mogrt_params. */
  componentIndex: number;
  paramIndex: number;
  /** New value: string for text, number, boolean, or [r,g,b,a] 0-1 floats for color. */
  value: string | number | boolean | number[];
}

export interface SetMogrtParamResult {
  ok: boolean;
  displayName: string;
  /** Which setter strategy worked — informs future calls. */
  methodUsed: string;
}
