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
  "set_clip_param",
  "probe_effects",
  "list_effects",
  "add_clip_effect",
  "grade_track",
  "remove_track_effect",
  "set_clip_lut",
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
  /**
   * Source in-point in seconds (0 = start of the source media). Non-zero when
   * the clip was trimmed at the head. Map a source beat `b` to the timeline as
   * `startSeconds + (b - inSeconds)`, keeping only beats where inSeconds <= b <= outSeconds.
   * null if the running plugin build predates this field.
   */
  inSeconds: number | null;
  /** Source out-point in seconds (end of the used region within the source). */
  outSeconds: number | null;
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
// set_clip_param — fixed-value transform/effect params on a placed clip.
// Verified surface (26.2.2): numeric params on AE.ADBE Motion (Scale, Rotation,
// Opacity) settable via param.createKeyframe(value) -> createSetValueAction.
// Used for beat punch-ins (alternating Scale per slot).
// ---------------------------------------------------------------------------

export interface SetClipParamParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** 0-based clip index on the track (sorted by start time). */
  clipIndex: number;
  /** Component matchName, e.g. "AE.ADBE Motion". */
  componentMatchName: string;
  /** Param display name, e.g. "Scale", "Rotation", "Opacity". */
  paramName: string;
  /** New numeric value (e.g. Scale 108 = 108%). */
  value: number;
}

export interface SetClipParamResult {
  ok: boolean;
  clipName: string;
  componentMatchName: string;
  paramName: string;
  value: number;
}

// ---------------------------------------------------------------------------
// probe_effects — read-only discovery for issue #4 (can we ADD Lumetri?).
// Dumps the API surfaces that would let us add an effect component to a clip.
// ---------------------------------------------------------------------------

export interface ProbeEffectsParams {
  sequenceId?: string;
  videoTrackIndex: number;
  clipIndex: number;
}

export interface ProbeEffectsResult {
  clipName: string;
  /** Shape dump of the clip's component chain (what add-methods exist?). */
  chainShape: string;
  /** matchNames of components already on the clip. */
  components: string[];
  /** ppro top-level keys that look effect/filter/component related. */
  pproEffectKeys: string[];
  /** Shape dumps of promising factories found on ppro. */
  factoryShapes: Record<string, string>;
  /** Free-form notes from each probe attempt. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// list_effects / add_clip_effect — verified path from probe_effects (#4):
// VideoFilterFactory.createComponent(matchName) -> chain.createAppendComponentAction.
// ---------------------------------------------------------------------------

export interface ListEffectsParams {
  /** Case-insensitive substring filter on matchName or display name. */
  filter?: string;
}

export interface EffectInfo {
  matchName: string;
  displayName: string;
}

export interface ListEffectsResult {
  effects: EffectInfo[];
}

export interface AddClipEffectParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** 0-based clip index on the track (sorted by start time). */
  clipIndex: number;
  /** Effect matchName from list_effects (e.g. the Lumetri Color matchName). */
  matchName: string;
}

export interface AddClipEffectResult {
  ok: boolean;
  clipName: string;
  matchName: string;
  /** matchNames now on the clip, after adding. */
  components: string[];
}

// ---------------------------------------------------------------------------
// grade_track — apply one effect + a set of numeric params to EVERY clip on a
// video track, sequentially in the plugin (reliable; one call grades a reel).
// Idempotent: ensures exactly one instance of the effect per clip (adds if
// missing, removes duplicates), so re-running re-grades instead of stacking.
// ---------------------------------------------------------------------------

export interface GradeParam {
  paramName: string;
  value: number;
}

export interface GradeTrackParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** Effect to ensure on each clip. Default "AE.ADBE Lumetri". */
  matchName?: string;
  /** Numeric params to set on that effect (Basic Correction for Lumetri). */
  params: GradeParam[];
}

export interface GradeTrackClipResult {
  clipIndex: number;
  clipName: string;
  status: "graded" | "error";
  /** How the effect instance was obtained: "added" | "reused". */
  effect?: string;
  /** Duplicate effect instances removed to keep exactly one. */
  duplicatesRemoved?: number;
  paramsSet?: number;
  message?: string;
}

export interface GradeTrackResult {
  matchName: string;
  clipCount: number;
  graded: number;
  errored: number;
  results: GradeTrackClipResult[];
}

// ---------------------------------------------------------------------------
// remove_track_effect — strip an effect (e.g. Lumetri) from every clip on a
// track, back to ungraded. The "reset" before applying a fresh grade.
// ---------------------------------------------------------------------------

export interface RemoveTrackEffectParams {
  sequenceId?: string;
  videoTrackIndex: number;
  /** Effect matchName to remove from each clip. Default "AE.ADBE Lumetri". */
  matchName?: string;
}

export interface RemoveTrackEffectResult {
  matchName: string;
  clipCount: number;
  /** Total effect instances removed across all clips. */
  removed: number;
  errored: number;
}

// ---------------------------------------------------------------------------
// set_clip_lut — discovery probe: try to load a .cube / Creative Look into a
// clip's Lumetri "Look" or "Input LUT" param (asset/string-valued, not numeric).
// Returns rich diagnostics about the param so we can learn the value shape.
// ---------------------------------------------------------------------------

export interface SetClipLutParams {
  sequenceId?: string;
  videoTrackIndex: number;
  clipIndex: number;
  /** Absolute .cube path (Creative looks resolve by name; Input LUT by path). */
  lutPath: string;
  /** Lumetri param display name to target. Default "Look". */
  paramName?: string;
}

export interface SetClipLutResult {
  ok: boolean;
  paramName: string;
  /** Which value form + setter worked (empty if none). */
  methodUsed: string;
  /** Per-attempt log + param/keyframe shape dumps for discovery. */
  diagnostics: string[];
}
