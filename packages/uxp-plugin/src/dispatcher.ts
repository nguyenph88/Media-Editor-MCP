import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type ResultEnvelope,
  type ErrorEnvelope,
} from "@ppmcp/protocol";
import { BridgeError } from "./errors.js";
import { ping } from "./handlers/ping.js";
import { getProjectInfo, listSequences } from "./handlers/project.js";
import { getSequenceClips } from "./handlers/clips.js";
import {
  listAvailableTransitions,
  applyTransitionToAllCuts,
  applyTransitionToClip,
} from "./handlers/transitions.js";
import { addMarkers } from "./handlers/markers.js";
import {
  getAudioClips,
  listProjectItems,
  importFiles,
  placeClip,
  removeClips,
  createSequence,
} from "./handlers/edit.js";
import {
  setClipParam,
  probeEffects,
  listEffects,
  addClipEffect,
  gradeTrack,
  removeTrackEffect,
} from "./handlers/clipfx.js";

type Handler = (params: never) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  ping,
  get_project_info: getProjectInfo,
  list_sequences: listSequences,
  get_sequence_clips: getSequenceClips,
  list_available_transitions: listAvailableTransitions,
  apply_transition_to_all_cuts: applyTransitionToAllCuts,
  apply_transition_to_clip: applyTransitionToClip,
  add_markers: addMarkers,
  get_audio_clips: getAudioClips,
  list_project_items: listProjectItems,
  import_files: importFiles,
  place_clip: placeClip,
  remove_clips: removeClips,
  create_sequence: createSequence,
  set_clip_param: setClipParam,
  probe_effects: probeEffects,
  list_effects: listEffects,
  add_clip_effect: addClipEffect,
  grade_track: gradeTrack,
  remove_track_effect: removeTrackEffect,
};

export async function dispatch(
  envelope: CommandEnvelope,
): Promise<ResultEnvelope | ErrorEnvelope> {
  const handler = handlers[envelope.command];
  if (!handler) {
    return errorEnvelope(envelope.id, "UNKNOWN_COMMAND", `Unknown command: ${envelope.command}`);
  }
  try {
    const result = await handler(envelope.params as never);
    return { v: PROTOCOL_VERSION, type: "result", id: envelope.id, ok: true, result };
  } catch (err) {
    if (err instanceof BridgeError) {
      return errorEnvelope(envelope.id, err.code, err.message, err.detail);
    }
    const message = err instanceof Error ? err.message : String(err);
    return errorEnvelope(envelope.id, "PREMIERE_API_ERROR", message);
  }
}

function errorEnvelope(
  id: string,
  code: ErrorEnvelope["error"]["code"],
  message: string,
  detail?: unknown,
): ErrorEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type: "error",
    id,
    ok: false,
    error: { code, message, ...(detail !== undefined ? { detail } : {}) },
  };
}
