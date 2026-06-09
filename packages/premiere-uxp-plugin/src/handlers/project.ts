import type { ProjectInfoResult, ListSequencesResult, SequenceSummary } from "@ppmcp/protocol";
import { getActiveProject, getSequences, sequenceIdOf, getTimebase } from "./ppro.js";

export async function getProjectInfo(): Promise<ProjectInfoResult> {
  const project = await getActiveProject();
  const sequences = await getSequences(project);
  const active = await project.getActiveSequence();
  return {
    name: String(project.name ?? "untitled"),
    path: String(project.path ?? ""),
    sequenceCount: sequences.length,
    activeSequenceName: active ? String(active.name ?? "unnamed") : null,
  };
}

export async function listSequences(): Promise<ListSequencesResult> {
  const project = await getActiveProject();
  const sequences = await getSequences(project);
  const active = await project.getActiveSequence();
  const activeId = active ? await sequenceIdOf(active) : null;

  const summaries: SequenceSummary[] = [];
  for (const seq of sequences) {
    const id = await sequenceIdOf(seq);
    let fps = 0;
    try {
      fps = Math.round((await getTimebase(seq)).fps * 100) / 100;
    } catch {
      /* leave 0 if settings unavailable */
    }
    summaries.push({
      id,
      name: String(seq.name ?? "unnamed"),
      videoTrackCount: await seq.getVideoTrackCount(),
      audioTrackCount: await seq.getAudioTrackCount(),
      frameRateFps: fps,
      isActive: id === activeId,
    });
  }
  return { sequences: summaries };
}
