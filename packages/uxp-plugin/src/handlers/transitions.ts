import {
  DEFAULT_TRANSITION_MATCH_NAME,
  DEFAULT_TRANSITION_DURATION_SECONDS,
  type ListAvailableTransitionsParams,
  type ListAvailableTransitionsResult,
  type ApplyTransitionToAllCutsParams,
  type ApplyTransitionToAllCutsResult,
  type ApplyTransitionToClipParams,
  type ApplyTransitionToClipResult,
  type CutResult,
  type ExistingTransitionInfo,
  type TransitionAlignment,
} from "@ppmcp/protocol";
import { BridgeError } from "../errors.js";
import {
  ppro,
  getActiveProject,
  resolveSequence,
  getVideoTrack,
  getSortedClips,
  clipName,
  getTimebase,
  secondsToFrameSnappedTickTime,
  withLockedAccess,
  describeShape,
  type Timebase,
} from "./ppro.js";

// ---------------------------------------------------------------------------
// list_available_transitions
// ---------------------------------------------------------------------------

export async function listAvailableTransitions(
  params: ListAvailableTransitionsParams,
): Promise<ListAvailableTransitionsResult> {
  const names: string[] = await ppro.TransitionFactory.getVideoTransitionMatchNames();
  const filter = params.filter?.toLowerCase();
  const transitions = filter
    ? names.filter((n) => n.toLowerCase().includes(filter))
    : names;
  return { transitions: transitions.sort() };
}

// ---------------------------------------------------------------------------
// transition application
// ---------------------------------------------------------------------------

/**
 * Alignment value passed to AddTransitionOptions.setTransitionAlignment.
 * Mirrors the QE convention: 0 = start at cut, 0.5 = centered, 1 = end at cut.
 * Verified empirically at M4 — adjust here if the live host disagrees.
 */
function alignmentValue(alignment: TransitionAlignment): number {
  switch (alignment) {
    case "start":
      return 0;
    case "end":
      return 1;
    case "center":
    default:
      return 0.5;
  }
}

async function createTransition(matchName: string): Promise<any> {
  try {
    const transition = await ppro.TransitionFactory.createVideoTransition(matchName);
    if (!transition) throw new Error("factory returned null");
    return transition;
  } catch (e) {
    throw new BridgeError(
      "BAD_PARAMS",
      `Could not create transition "${matchName}". ` +
        `Use list_available_transitions to find valid matchNames. (${e instanceof Error ? e.message : e})`,
    );
  }
}

function buildOptions(
  applyToStart: boolean,
  alignment: TransitionAlignment,
  durationSeconds: number,
  timebase: Timebase,
): any {
  const opts = new ppro.AddTransitionOptions();
  opts.setApplyToStart(applyToStart);
  opts.setForceSingleSided(false); // two-sided: spans the cut into both clips
  opts.setTransitionAlignment(alignmentValue(alignment));
  opts.setDuration(secondsToFrameSnappedTickTime(durationSeconds, timebase));
  return opts;
}

/**
 * Detect transitions already on a track.
 *
 * Premiere 26.x API reality: `getTrackItems(TrackItemType.TRANSITION)` returns
 * an array with the CORRECT COUNT but null elements — so the count is reliable
 * while positions/names are not. We return both: `count` (always trustworthy)
 * and `items` (usable objects only; empty on current builds, lights up
 * automatically if Adobe starts returning real objects).
 */
async function detectTransitions(track: any): Promise<{ count: number; items: any[] }> {
  const types = ppro.Constants?.TrackItemType;
  const transitionType = types?.TRANSITION ?? types?.Transition;
  if (transitionType === undefined) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `Cannot detect existing transitions: TrackItemType.TRANSITION not found. ` +
        `TrackItemType: ${describeShape(types)}`,
    );
  }
  const raw = await track.getTrackItems(transitionType, false);
  const all = Array.isArray(raw) ? raw : [];
  const items = all.filter(
    (i: any) => i && typeof i.getStartTime === "function" && typeof i.getEndTime === "function",
  );
  return { count: all.length, items };
}

/** Best-effort display name of a transition track item. */
async function transitionItemName(item: any): Promise<string> {
  try {
    if (typeof item.getName === "function") {
      const n = await item.getName();
      if (n) return String(n);
    }
    if (item.name) return String(item.name);
    if (typeof item.getMatchName === "function") {
      const m = await item.getMatchName();
      if (m) return String(m);
    }
  } catch {
    /* fall through */
  }
  return "transition";
}

/**
 * Map each cut time to the transition item spanning it (only possible when the
 * API returns real transition objects). A transition at a cut contains the cut
 * time within [start, end] regardless of alignment, so containment with a
 * half-frame tolerance covers all cases.
 */
async function mapTransitionsToCuts(
  transitionItems: any[],
  cuts: Array<{ cutIndex: number; leftClip: string; rightClip: string; atSeconds: number }>,
  timebase: Timebase,
): Promise<ExistingTransitionInfo[]> {
  if (transitionItems.length === 0) return [];

  const spans = await Promise.all(
    transitionItems.map(async (item) => ({
      start: (await item.getStartTime()).seconds as number,
      end: (await item.getEndTime()).seconds as number,
      name: await transitionItemName(item),
    })),
  );

  const eps = 1 / timebase.fps / 2;
  const found: ExistingTransitionInfo[] = [];
  for (const cut of cuts) {
    const hit = spans.find((s) => s.start - eps <= cut.atSeconds && cut.atSeconds <= s.end + eps);
    if (hit) {
      found.push({
        ...cut,
        transitionName: hit.name,
        durationSeconds: Math.round((hit.end - hit.start) * 100) / 100,
      });
    }
  }
  return found;
}

/** Heuristic: classify Premiere errors about missing handle media. */
function isInsufficientMediaError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("insufficient") ||
    m.includes("media limit") ||
    m.includes("not enough media") ||
    m.includes("no media") ||
    m.includes("handle")
  );
}

/**
 * Apply one transition action inside its own transaction so a failing cut
 * cannot roll back its neighbours (per-cut partial success > single undo step).
 */
async function applyOne(
  project: any,
  trackItem: any,
  transition: any,
  opts: any,
  undoLabel: string,
): Promise<void> {
  await withLockedAccess(project, () => {
    project.executeTransaction((compoundAction: any) => {
      const action = trackItem.createAddVideoTransitionAction(transition, opts);
      compoundAction.addAction(action);
    }, undoLabel);
  });
}

// ---------------------------------------------------------------------------
// apply_transition_to_all_cuts
// ---------------------------------------------------------------------------

export async function applyTransitionToAllCuts(
  params: ApplyTransitionToAllCutsParams,
): Promise<ApplyTransitionToAllCutsResult> {
  const matchName = params.matchName ?? DEFAULT_TRANSITION_MATCH_NAME;
  const durationSeconds = params.durationSeconds ?? DEFAULT_TRANSITION_DURATION_SECONDS;
  const alignment = params.alignment ?? "center";
  const trackIndex = params.videoTrackIndex ?? 0;
  const skipInsufficient = params.skipInsufficientHandles ?? true;
  const onExisting = params.onExisting ?? "ask";

  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, trackIndex);
  const timebase = await getTimebase(sequence);
  const items = await getSortedClips(track);

  // Pass 1: compute the cuts (truly adjacent clip pairs; a gap is not a cut).
  interface Cut {
    cutIndex: number;
    leftClip: string;
    rightClip: string;
    atSeconds: number;
    left: any;
    gapSeconds: number;
  }
  const cuts: Cut[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const left = items[i];
    const right = items[i + 1];
    const leftEnd = (await left.getEndTime()).seconds as number;
    const rightStart = (await right.getStartTime()).seconds as number;
    cuts.push({
      cutIndex: i,
      leftClip: await clipName(left),
      rightClip: await clipName(right),
      atSeconds: leftEnd,
      left,
      gapSeconds: rightStart - leftEnd,
    });
  }
  const halfFrame = 1 / timebase.fps / 2;

  // Pass 2: detect transitions already on the track. The count is always
  // reliable; per-cut positions only when the API returns real objects.
  const detected = await detectTransitions(track);
  const positionsKnown = detected.items.length === detected.count;
  const existing = positionsKnown
    ? await mapTransitionsToCuts(
        detected.items,
        cuts.map(({ cutIndex, leftClip, rightClip, atSeconds }) => ({
          cutIndex,
          leftClip,
          rightClip,
          atSeconds,
        })),
        timebase,
      )
    : [];
  const existingByCut = new Map(existing.map((e) => [e.cutIndex, e]));

  const base = {
    trackIndex,
    matchName,
    durationSeconds,
    cutsFound: cuts.length,
    existingCount: detected.count,
    existingTransitions: existing,
  };

  // "ask" + something found → apply NOTHING; client confirms with the user.
  if (onExisting === "ask" && detected.count > 0) {
    return {
      ...base,
      applied: 0,
      skipped: 0,
      errored: 0,
      results: [],
      pendingConfirmation: true,
    };
  }

  // "skip" needs per-cut positions, which current Premiere builds don't expose.
  if (onExisting === "skip" && detected.count > 0 && !positionsKnown) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `Cannot skip selectively: Premiere reports ${detected.count} existing transition(s) on ` +
        "this track but its API does not expose their positions (known limitation in " +
        "Premiere 26.x UXP). Options: onExisting='overwrite' to re-apply a uniform " +
        "transition at every cut, or adjust the timeline manually.",
    );
  }

  // Pass 3: apply.
  const transition = await createTransition(matchName);
  // Transition goes on the LEFT clip's END edge — that edge IS the cut.
  const opts = buildOptions(false, alignment, durationSeconds, timebase);

  const results: CutResult[] = [];
  for (const cut of cuts) {
    const { left, gapSeconds, ...info } = cut;

    if (Math.abs(gapSeconds) > halfFrame) {
      results.push({
        ...info,
        status: "skipped_insufficient_handles",
        message: `Gap between clips (${gapSeconds.toFixed(2)}s) — no cut here.`,
      });
      continue;
    }

    const already = existingByCut.get(cut.cutIndex);
    if (already && onExisting === "skip") {
      results.push({
        ...info,
        status: "skipped_existing",
        message: `Kept existing "${already.transitionName}" (${already.durationSeconds}s).`,
      });
      continue;
    }

    try {
      await applyOne(project, left, transition, opts, `MCP: ${matchName} @ cut ${cut.cutIndex}`);
      results.push({ ...info, status: "applied" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (skipInsufficient && isInsufficientMediaError(message)) {
        results.push({
          ...info,
          status: "skipped_insufficient_handles",
          message:
            "Not enough handle media beyond the cut for a two-sided transition. " +
            "Trim the clips slightly or use a shorter duration.",
        });
      } else {
        results.push({ ...info, status: "error", message });
      }
    }
  }

  const count = (s: CutResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    ...base,
    applied: count("applied"),
    skipped: count("skipped_insufficient_handles") + count("skipped_existing"),
    errored: count("error"),
    results,
  };
}

// ---------------------------------------------------------------------------
// apply_transition_to_clip
// ---------------------------------------------------------------------------

export async function applyTransitionToClip(
  params: ApplyTransitionToClipParams,
): Promise<ApplyTransitionToClipResult> {
  const matchName = params.matchName ?? DEFAULT_TRANSITION_MATCH_NAME;
  const durationSeconds = params.durationSeconds ?? DEFAULT_TRANSITION_DURATION_SECONDS;
  const alignment = params.alignment ?? "center";

  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, params.videoTrackIndex);
  const timebase = await getTimebase(sequence);
  const items = await getSortedClips(track);

  if (params.clipIndex < 0 || params.clipIndex >= items.length) {
    throw new BridgeError(
      "CLIP_OUT_OF_RANGE",
      `Clip index ${params.clipIndex} is out of range (track has ${items.length} clip(s)).`,
    );
  }
  const item = items[params.clipIndex];
  const name = await clipName(item);

  const transition = await createTransition(matchName);
  const opts = buildOptions(params.edge === "start", alignment, durationSeconds, timebase);

  try {
    await applyOne(project, item, transition, opts, `MCP: ${matchName} on ${name}`);
    return { status: "applied", clipName: name };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isInsufficientMediaError(message)) {
      return {
        status: "skipped_insufficient_handles",
        clipName: name,
        message: "Not enough handle media for a two-sided transition at this edge.",
      };
    }
    return { status: "error", clipName: name, message };
  }
}
