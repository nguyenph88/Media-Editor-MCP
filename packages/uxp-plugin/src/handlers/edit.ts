/**
 * Timeline-editing primitives built on ppro.SequenceEditor (insert/overwrite/
 * clone/remove) — the class that holds all mutation actions in the UXP API.
 */
import type {
  GetAudioClipsParams,
  GetAudioClipsResult,
  AudioClipInfo,
  ListProjectItemsResult,
  ProjectItemInfo,
  ImportFilesParams,
  ImportFilesResult,
  PlaceClipParams,
  PlaceClipResult,
  RemoveClipsParams,
  RemoveClipsResult,
  CreateSequenceParams,
  CreateSequenceResult,
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
  secondsToTimecode,
  withLockedAccess,
  getSequenceEditor,
  walkProjectItems,
  findProjectItemByName,
  asClipProjectItem,
  mediaPathOf,
  sequenceIdOf,
  describeShape,
} from "./ppro.js";

// ---------------------------------------------------------------------------
// get_audio_clips — like get_sequence_clips but for audio tracks + media paths
// ---------------------------------------------------------------------------

export async function getAudioClips(params: GetAudioClipsParams): Promise<GetAudioClipsResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const timebase = await getTimebase(sequence);

  const trackCount: number = await sequence.getAudioTrackCount();
  const indexes =
    params.audioTrackIndex !== undefined
      ? [params.audioTrackIndex]
      : Array.from({ length: trackCount }, (_, i) => i);

  const tracks: GetAudioClipsResult["tracks"] = [];
  for (const trackIndex of indexes) {
    if (trackIndex < 0 || trackIndex >= trackCount) {
      throw new BridgeError(
        "TRACK_OUT_OF_RANGE",
        `Audio track ${trackIndex} out of range (sequence has ${trackCount}; A1 = 0).`,
      );
    }
    const track = await sequence.getAudioTrack(trackIndex);
    const items = await getSortedClips(track);
    const clips: AudioClipInfo[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const start = (await item.getStartTime()).seconds as number;
      const end = (await item.getEndTime()).seconds as number;
      clips.push({
        index: i,
        name: await clipName(item),
        startSeconds: start,
        endSeconds: end,
        durationSeconds: end - start,
        startTimecode: secondsToTimecode(start, timebase.fps),
        endTimecode: secondsToTimecode(end, timebase.fps),
        mediaPath: await mediaPathOf(await item.getProjectItem()),
      });
    }
    tracks.push({ trackIndex, trackName: `A${trackIndex + 1}`, clips });
  }
  return { sequenceName: String(sequence.name ?? "unnamed"), tracks };
}

// ---------------------------------------------------------------------------
// list_project_items
// ---------------------------------------------------------------------------

export async function listProjectItems(): Promise<ListProjectItemsResult> {
  const project = await getActiveProject();
  const items: ProjectItemInfo[] = [];
  await walkProjectItems(project, async (item, binPath) => {
    const clip = asClipProjectItem(item);
    items.push({
      name: String(item.name ?? "unnamed"),
      type: clip ? "clip" : typeof item.getItems === "function" ? "folder" : "other",
      mediaPath: clip ? await mediaPathOf(item) : null,
      binPath: binPath || "/",
    });
  });
  return { items };
}

// ---------------------------------------------------------------------------
// import_files
// ---------------------------------------------------------------------------

export async function importFiles(params: ImportFilesParams): Promise<ImportFilesResult> {
  const project = await getActiveProject();
  const root = await project.getRootItem();
  const ok = await project.importFiles(params.paths, true, root, false);
  if (!ok) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `importFiles returned false for: ${params.paths.join(", ")}. Check the paths exist.`,
    );
  }
  return {
    ok: true,
    imported: params.paths.map((p) => p.split(/[\\/]/).pop() ?? p),
  };
}

// ---------------------------------------------------------------------------
// place_clip — the core primitive for beat-slot editing
// ---------------------------------------------------------------------------

export async function placeClip(params: PlaceClipParams): Promise<PlaceClipResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const timebase = await getTimebase(sequence);

  const item = await findProjectItemByName(project, params.projectItemName);
  const clipItem = asClipProjectItem(item);
  if (!clipItem) {
    throw new BridgeError(
      "BAD_PARAMS",
      `"${params.projectItemName}" is not footage (it's a bin or other item).`,
    );
  }

  // Slice: set source in/out before placing. Placed instances keep their own
  // in/out, so mutating the bin item between placements is safe (verified live).
  if (params.inSeconds !== undefined || params.outSeconds !== undefined) {
    if (params.inSeconds === undefined || params.outSeconds === undefined) {
      throw new BridgeError("BAD_PARAMS", "Provide BOTH inSeconds and outSeconds, or neither.");
    }
    if (params.outSeconds <= params.inSeconds) {
      throw new BridgeError("BAD_PARAMS", "outSeconds must be greater than inSeconds.");
    }
    const inT = secondsToFrameSnappedTickTime(params.inSeconds, timebase);
    const outT = secondsToFrameSnappedTickTime(params.outSeconds, timebase);
    await withLockedAccess(project, () => {
      project.executeTransaction((compound: any) => {
        compound.addAction(clipItem.createSetInOutPointsAction(inT, outT));
      }, "MCP: slice source");
    });
  }

  const editor = getSequenceEditor(sequence);
  const atT = secondsToFrameSnappedTickTime(params.atSeconds, timebase);
  const v = params.videoTrackIndex;
  const a = params.audioTrackIndex ?? params.videoTrackIndex;
  const mode = params.mode ?? "overwrite";

  await withLockedAccess(project, () => {
    project.executeTransaction((compound: any) => {
      const action =
        mode === "insert"
          ? editor.createInsertProjectItemAction(clipItem, atT, v, a, true)
          : editor.createOverwriteItemAction(clipItem, atT, v, a);
      compound.addAction(action);
    }, `MCP: place ${params.projectItemName} @ ${params.atSeconds.toFixed(2)}s`);
  });

  return {
    ok: true,
    placedAtSeconds: params.atSeconds,
    videoTrackIndex: v,
    clipName: params.projectItemName,
  };
}

// ---------------------------------------------------------------------------
// remove_clips
// ---------------------------------------------------------------------------

export async function removeClips(params: RemoveClipsParams): Promise<RemoveClipsResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, params.videoTrackIndex);
  const items = await getSortedClips(track);

  const targets = params.clipIndexes.map((i) => {
    if (i < 0 || i >= items.length) {
      throw new BridgeError(
        "CLIP_OUT_OF_RANGE",
        `Clip index ${i} out of range (track has ${items.length} clip(s)).`,
      );
    }
    return items[i];
  });
  if (targets.length === 0) return { removed: 0 };

  const selection = await ppro.TrackItemSelection.createEmptySelection();
  if (!selection) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `TrackItemSelection unavailable: ${describeShape(ppro.TrackItemSelection)}`,
    );
  }
  for (const t of targets) selection.addItem(t, false);

  const editor = getSequenceEditor(sequence);
  await withLockedAccess(project, () => {
    project.executeTransaction((compound: any) => {
      compound.addAction(
        editor.createRemoveItemsAction(
          selection,
          params.ripple ?? false,
          ppro.Constants.MediaType.VIDEO,
        ),
      );
    }, `MCP: remove ${targets.length} clip(s)`);
  });
  return { removed: targets.length };
}

// ---------------------------------------------------------------------------
// create_sequence
// ---------------------------------------------------------------------------

export async function createSequence(params: CreateSequenceParams): Promise<CreateSequenceResult> {
  const project = await getActiveProject();
  const clipItems: any[] = [];
  for (const name of params.fromProjectItemNames) {
    const item = await findProjectItemByName(project, name);
    const clip = asClipProjectItem(item);
    if (!clip) throw new BridgeError("BAD_PARAMS", `"${name}" is not footage.`);
    clipItems.push(clip);
  }
  const root = await project.getRootItem();
  const sequence = await project.createSequenceFromMedia(params.name, clipItems, root);
  if (!sequence) {
    throw new BridgeError("PREMIERE_API_ERROR", "createSequenceFromMedia returned nothing.");
  }
  if (params.activate ?? true) {
    try {
      await project.setActiveSequence?.(sequence);
    } catch {
      await project.openSequence?.(sequence);
    }
  }
  return {
    sequenceName: String(sequence.name ?? params.name),
    sequenceId: await sequenceIdOf(sequence),
  };
}
