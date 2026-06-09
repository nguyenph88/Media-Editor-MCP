/**
 * Shared helpers around the `premierepro` UXP API.
 *
 * NOTE: method names follow the official UXP reference
 * (https://developer.adobe.com/premiere-pro/uxp/ppro_reference/) but some are
 * verified empirically at the M2/M4 discovery checkpoints — if a call fails on
 * a live host, fix it HERE so handlers stay stable.
 */
import { BridgeError } from "../errors.js";

export const ppro = require("premierepro");

export async function getActiveProject(): Promise<any> {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new BridgeError(
      "NO_ACTIVE_PROJECT",
      "No project is open in Premiere Pro. Open a project first.",
    );
  }
  return project;
}

export async function resolveSequence(project: any, sequenceId?: string): Promise<any> {
  if (sequenceId) {
    const sequences = await getSequences(project);
    for (const seq of sequences) {
      if (await sequenceIdOf(seq) === sequenceId) return seq;
    }
    throw new BridgeError("NO_ACTIVE_SEQUENCE", `No sequence found with id "${sequenceId}".`);
  }
  const active = await project.getActiveSequence();
  if (!active) {
    throw new BridgeError(
      "NO_ACTIVE_SEQUENCE",
      "No active sequence. Open a sequence in the timeline first.",
    );
  }
  return active;
}

export async function getSequences(project: any): Promise<any[]> {
  const sequences = await project.getSequences();
  return Array.isArray(sequences) ? sequences : [];
}

export async function sequenceIdOf(sequence: any): Promise<string> {
  // Sequence exposes a guid; shape differs slightly across builds.
  const guid = sequence.guid ?? (await sequence.getSequenceId?.()) ?? null;
  if (guid == null) return String(sequence.name ?? "unknown");
  return typeof guid === "object" && guid.toString ? guid.toString() : String(guid);
}

export async function getVideoTrack(sequence: any, trackIndex: number): Promise<any> {
  const count = await sequence.getVideoTrackCount();
  if (trackIndex < 0 || trackIndex >= count) {
    throw new BridgeError(
      "TRACK_OUT_OF_RANGE",
      `Video track index ${trackIndex} is out of range (sequence has ${count} video track(s); V1 = 0).`,
    );
  }
  return sequence.getVideoTrack(trackIndex);
}

/** Clips on a track sorted by start time. */
export async function getSortedClips(track: any): Promise<any[]> {
  const items: any[] = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const withStart = await Promise.all(
    items.map(async (item) => ({ item, start: (await item.getStartTime()).seconds as number })),
  );
  withStart.sort((a, b) => a.start - b.start);
  return withStart.map((w) => w.item);
}

export async function clipName(item: any): Promise<string> {
  try {
    if (typeof item.getName === "function") return await item.getName();
    return String(item.name ?? "unnamed clip");
  } catch {
    return "unnamed clip";
  }
}

export interface Timebase {
  fps: number;
  /** Ticks per frame as a BigInt string-safe value (254016000000 ticks/sec). */
  ticksPerFrame: bigint;
}

export const TICKS_PER_SECOND = 254016000000n;

export async function getTimebase(sequence: any): Promise<Timebase> {
  // The frame-duration object's location/shape varies across builds — probe
  // known candidates; on total failure, report the REAL shape in the error
  // so the next attempt can be fixed from the error message alone.
  const settings =
    typeof sequence.getSettings === "function" ? await sequence.getSettings() : null;

  const candidates: any[] = [
    settings?.videoFrameRate,
    settings?.video?.frameRate,
    typeof settings?.getVideoFrameRate === "function" ? await settings.getVideoFrameRate() : undefined,
    typeof sequence.getTimebase === "function" ? await sequence.getTimebase() : undefined,
  ];

  for (const fr of candidates) {
    const ticksPerFrame = frameDurationToTicks(fr);
    if (ticksPerFrame !== null && ticksPerFrame > 0n) {
      const fps = Number(TICKS_PER_SECOND) / Number(ticksPerFrame);
      return { fps, ticksPerFrame };
    }
  }

  throw new BridgeError(
    "PREMIERE_API_ERROR",
    "Could not read sequence frame rate. " +
      `sequence: ${describeShape(sequence)} | settings: ${describeShape(settings)} | ` +
      `videoFrameRate: ${describeShape(settings?.videoFrameRate)}`,
  );
}

/** Interpret a frame-duration value in any of the shapes the API might use. */
function frameDurationToTicks(fr: any): bigint | null {
  if (fr == null) return null;
  if (typeof fr === "object") {
    const ticks = fr.ticksNumber ?? fr.ticks;
    if (ticks != null && Number(ticks) > 0) return BigInt(Math.round(Number(ticks)));
    if (typeof fr.seconds === "number" && fr.seconds > 0 && fr.seconds < 1) {
      return BigInt(Math.round(fr.seconds * Number(TICKS_PER_SECOND)));
    }
    return null;
  }
  // A bare string/number of ticks-per-frame (ExtendScript-style timebase)
  const n = Number(fr);
  if (Number.isFinite(n) && n > 1000) return BigInt(Math.round(n));
  // ...or a bare fps number
  if (Number.isFinite(n) && n > 0) return BigInt(Math.round(Number(TICKS_PER_SECOND) / n));
  return null;
}

/** Reflection helper: own + prototype member names, for discovery via error messages. */
export function describeShape(obj: any): string {
  if (obj == null) return String(obj);
  if (typeof obj !== "object" && typeof obj !== "function") return `${typeof obj}:${String(obj)}`;
  const own = Object.getOwnPropertyNames(obj);
  const proto = Object.getPrototypeOf(obj);
  const protoKeys = proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto) : [];
  return `[${obj.constructor?.name ?? typeof obj}] own:{${own.join(",")}} proto:{${protoKeys.join(",")}}`;
}

/** Snap a duration in seconds to whole frames and return a TickTime. */
export function secondsToFrameSnappedTickTime(seconds: number, timebase: Timebase): any {
  const frames = Math.max(1, Math.round(seconds * timebase.fps));
  const ticks = timebase.ticksPerFrame * BigInt(frames);
  return ppro.TickTime.createWithTicks(ticks.toString());
}

export function secondsToTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const fpsInt = Math.round(fps);
  const f = totalFrames % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

/** SequenceEditor holds all timeline-mutation actions (insert/overwrite/clone/remove/MOGRT). */
export function getSequenceEditor(sequence: any): any {
  const editor = ppro.SequenceEditor?.getEditor?.(sequence);
  if (!editor) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `SequenceEditor unavailable. ppro.SequenceEditor: ${describeShape(ppro.SequenceEditor)}`,
    );
  }
  return editor;
}

/** Recursively walk the project bins. Calls visit(item, binPath) for every item. */
export async function walkProjectItems(
  project: any,
  visit: (item: any, binPath: string) => void | Promise<void>,
): Promise<void> {
  const root = await project.getRootItem();
  async function walk(folderItem: any, binPath: string): Promise<void> {
    const items: any[] = (await folderItem.getItems?.()) ?? [];
    for (const item of items) {
      await visit(item, binPath);
      const asFolder = safeCast(() => ppro.FolderItem.cast(item));
      if (asFolder && typeof asFolder.getItems === "function") {
        await walk(asFolder, `${binPath}/${String(item.name ?? "")}`);
      }
    }
  }
  await walk(root, "");
}

export async function findProjectItemByName(project: any, name: string): Promise<any> {
  let found: any = null;
  await walkProjectItems(project, (item) => {
    if (!found && String(item.name ?? "") === name) found = item;
  });
  if (!found) {
    throw new BridgeError(
      "BAD_PARAMS",
      `No project item named "${name}" in the bin. Use list_project_items to see what exists.`,
    );
  }
  return found;
}

/** Cast a ProjectItem to ClipProjectItem (footage). Null when it isn't one (e.g. a bin). */
export function asClipProjectItem(item: any): any {
  return safeCast(() => ppro.ClipProjectItem.cast(item));
}

export async function mediaPathOf(projectItem: any): Promise<string | null> {
  try {
    const clipItem = asClipProjectItem(projectItem);
    if (!clipItem || typeof clipItem.getMediaFilePath !== "function") return null;
    const p = await clipItem.getMediaFilePath();
    return p ? String(p) : null;
  } catch {
    return null;
  }
}

function safeCast<T>(fn: () => T): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding the project's write lock, if the API requires it.
 * Some builds require lockedAccess around timeline mutations; harmless if not.
 */
export async function withLockedAccess<T>(project: any, fn: () => T | Promise<T>): Promise<T> {
  if (typeof project.lockedAccess === "function") {
    let result!: T;
    await project.lockedAccess(() => {
      result = fn() as T;
    });
    // lockedAccess callbacks are synchronous; if fn returned a promise, await it after.
    return await result;
  }
  return await fn();
}
