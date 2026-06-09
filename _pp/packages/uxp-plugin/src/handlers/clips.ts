import type {
  GetSequenceClipsParams,
  GetSequenceClipsResult,
  TrackClips,
  ClipInfo,
} from "@ppmcp/protocol";
import {
  getActiveProject,
  resolveSequence,
  getVideoTrack,
  getSortedClips,
  clipName,
  getTimebase,
  secondsToTimecode,
} from "./ppro.js";

export async function getSequenceClips(
  params: GetSequenceClipsParams,
): Promise<GetSequenceClipsResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const timebase = await getTimebase(sequence);

  const trackCount: number = await sequence.getVideoTrackCount();
  const trackIndexes =
    params.videoTrackIndex !== undefined
      ? [params.videoTrackIndex]
      : Array.from({ length: trackCount }, (_, i) => i);

  const tracks: TrackClips[] = [];
  for (const trackIndex of trackIndexes) {
    const track = await getVideoTrack(sequence, trackIndex);
    const items = await getSortedClips(track);
    const clips: ClipInfo[] = [];
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
      });
    }
    tracks.push({
      trackIndex,
      trackName: `V${trackIndex + 1}`,
      clips,
    });
  }

  return {
    sequenceName: String(sequence.name ?? "unnamed"),
    frameRateFps: Math.round(timebase.fps * 100) / 100,
    tracks,
  };
}
