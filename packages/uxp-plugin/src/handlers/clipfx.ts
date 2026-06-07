/**
 * Per-clip transform/effect params (issue #3 — beat punch-ins).
 *
 * Reuses the component/param surface proven during the MOGRT prototype
 * (commit d7ced57): a track item exposes getComponentChain() -> components
 * (getMatchName/getParamCount/getParam) -> params, and a NUMERIC param is set
 * via param.createKeyframe(value) -> createSetValueAction(kf, true) inside a
 * transaction. Verified live setting Scale on AE.ADBE Motion.
 */
import type { SetClipParamParams, SetClipParamResult } from "@ppmcp/protocol";
import { BridgeError } from "../errors.js";
import {
  getActiveProject,
  resolveSequence,
  getVideoTrack,
  getSortedClips,
  clipName,
  describeShape,
  withLockedAccess,
} from "./ppro.js";

async function getComponents(item: any): Promise<any[]> {
  if (typeof item.getComponentChain !== "function") {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `clip has no getComponentChain — item: ${describeShape(item)}`,
    );
  }
  const chain = await item.getComponentChain();
  const count =
    chain && typeof chain.getComponentCount === "function" ? await chain.getComponentCount() : 0;
  const comps: any[] = [];
  for (let i = 0; i < count; i++) comps.push(await chain.getComponentAtIndex(i));
  return comps;
}

export async function setClipParam(params: SetClipParamParams): Promise<SetClipParamResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, params.videoTrackIndex);
  const items = await getSortedClips(track);
  if (params.clipIndex < 0 || params.clipIndex >= items.length) {
    throw new BridgeError(
      "CLIP_OUT_OF_RANGE",
      `Clip index ${params.clipIndex} out of range (track has ${items.length} clip(s)).`,
    );
  }
  const item = items[params.clipIndex];

  const comps = await getComponents(item);
  const seenComps: string[] = [];
  let target: any;
  for (const comp of comps) {
    const mn = typeof comp.getMatchName === "function" ? await comp.getMatchName() : "";
    seenComps.push(String(mn));
    if (mn !== params.componentMatchName) continue;
    const count = await comp.getParamCount();
    const seenParams: string[] = [];
    for (let p = 0; p < count; p++) {
      const param = await comp.getParam(p);
      const name =
        typeof param.getDisplayName === "function"
          ? await param.getDisplayName()
          : String(param.displayName ?? "");
      seenParams.push(String(name));
      if (name === params.paramName) {
        target = param;
        break;
      }
    }
    if (!target) {
      throw new BridgeError(
        "BAD_PARAMS",
        `Param "${params.paramName}" not found on ${params.componentMatchName}. ` +
          `Available: ${seenParams.join(", ")}`,
      );
    }
    break;
  }
  if (!target) {
    throw new BridgeError(
      "BAD_PARAMS",
      `Component "${params.componentMatchName}" not found on clip. Available: ${seenComps.join(", ")}`,
    );
  }

  try {
    await withLockedAccess(project, () => {
      project.executeTransaction((compound: any) => {
        const kf = target.createKeyframe(params.value);
        compound.addAction(target.createSetValueAction(kf, true));
      }, `MCP: set ${params.componentMatchName}/${params.paramName} = ${params.value}`);
    });
  } catch (e) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `set value failed: ${e instanceof Error ? e.message : e} | param: ${describeShape(target)}`,
    );
  }

  return {
    ok: true,
    clipName: await clipName(item),
    componentMatchName: params.componentMatchName,
    paramName: params.paramName,
    value: params.value,
  };
}
