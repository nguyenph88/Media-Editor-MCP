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

  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, trackIndex);
  const timebase = await getTimebase(sequence);
  const items = await getSortedClips(track);

  const transition = await createTransition(matchName);
  // Transition goes on the LEFT clip's END edge — that edge IS the cut.
  const opts = buildOptions(false, alignment, durationSeconds, timebase);

  const results: CutResult[] = [];
  for (let i = 0; i < items.length - 1; i++) {
    const left = items[i];
    const right = items[i + 1];
    const cut: Omit<CutResult, "status"> = {
      cutIndex: i,
      leftClip: await clipName(left),
      rightClip: await clipName(right),
      atSeconds: (await left.getEndTime()).seconds as number,
    };

    // Only treat truly adjacent clips as cuts — a gap is not a cut.
    const leftEnd = (await left.getEndTime()).seconds as number;
    const rightStart = (await right.getStartTime()).seconds as number;
    if (Math.abs(rightStart - leftEnd) > 1 / timebase.fps / 2) {
      results.push({
        ...cut,
        status: "skipped_insufficient_handles",
        message: `Gap between clips (${(rightStart - leftEnd).toFixed(2)}s) — no cut here.`,
      });
      continue;
    }

    try {
      await applyOne(project, left, transition, opts, `MCP: ${matchName} @ cut ${i}`);
      results.push({ ...cut, status: "applied" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (skipInsufficient && isInsufficientMediaError(message)) {
        results.push({
          ...cut,
          status: "skipped_insufficient_handles",
          message:
            "Not enough handle media beyond the cut for a two-sided transition. " +
            "Trim the clips slightly or use a shorter duration.",
        });
      } else {
        results.push({ ...cut, status: "error", message });
      }
    }
  }

  const count = (s: CutResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    trackIndex,
    matchName,
    durationSeconds,
    cutsFound: Math.max(items.length - 1, 0),
    applied: count("applied"),
    skipped: count("skipped_insufficient_handles"),
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
