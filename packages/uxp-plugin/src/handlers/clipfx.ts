/**
 * Per-clip transform/effect params (issue #3 — beat punch-ins).
 *
 * Reuses the component/param surface proven during the MOGRT prototype
 * (commit d7ced57): a track item exposes getComponentChain() -> components
 * (getMatchName/getParamCount/getParam) -> params, and a NUMERIC param is set
 * via param.createKeyframe(value) -> createSetValueAction(kf, true) inside a
 * transaction. Verified live setting Scale on AE.ADBE Motion.
 */
import type {
  SetClipParamParams,
  SetClipParamResult,
  ProbeEffectsParams,
  ProbeEffectsResult,
  ListEffectsParams,
  ListEffectsResult,
  EffectInfo,
  AddClipEffectParams,
  AddClipEffectResult,
  GradeTrackParams,
  GradeTrackResult,
  GradeTrackClipResult,
} from "@ppmcp/protocol";
import { BridgeError } from "../errors.js";
import {
  ppro,
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

// ---------------------------------------------------------------------------
// probe_effects — discovery for issue #4
// ---------------------------------------------------------------------------

export async function probeEffects(params: ProbeEffectsParams): Promise<ProbeEffectsResult> {
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
  const notes: string[] = [];

  // 1. component chain shape + existing components
  let chainShape = "n/a";
  const components: string[] = [];
  try {
    const chain = await item.getComponentChain();
    chainShape = describeShape(chain);
    const count =
      typeof chain.getComponentCount === "function" ? await chain.getComponentCount() : 0;
    for (let i = 0; i < count; i++) {
      const c = await chain.getComponentAtIndex(i);
      components.push(typeof c.getMatchName === "function" ? await c.getMatchName() : "?");
    }
  } catch (e) {
    notes.push(`chain probe: ${e instanceof Error ? e.message : e}`);
  }

  // 2. ppro top-level keys that smell like effects/filters/components
  const pproEffectKeys: string[] = [];
  const factoryShapes: Record<string, string> = {};
  try {
    const keys = [
      ...Object.getOwnPropertyNames(ppro),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ppro) ?? {}),
    ];
    const rx = /(effect|filter|component|lumetri|video|factory)/i;
    for (const k of Array.from(new Set(keys))) {
      if (!rx.test(k)) continue;
      pproEffectKeys.push(k);
      // dump the shape of anything that might be a factory/static class
      const val = safeGet(() => (ppro as any)[k]);
      if (val && (typeof val === "object" || typeof val === "function")) {
        factoryShapes[k] = describeShape(val);
      }
    }
  } catch (e) {
    notes.push(`ppro key scan: ${e instanceof Error ? e.message : e}`);
  }

  return {
    clipName: await clipName(item),
    chainShape,
    components,
    pproEffectKeys,
    factoryShapes,
    notes,
  };
}

function safeGet<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// grade_track — ensure one effect per clip + set params, sequentially
// ---------------------------------------------------------------------------

async function listChainComponents(chain: any): Promise<any[]> {
  const count = await chain.getComponentCount();
  const out: any[] = [];
  for (let i = 0; i < count; i++) out.push(await chain.getComponentAtIndex(i));
  return out;
}

export async function gradeTrack(params: GradeTrackParams): Promise<GradeTrackResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const track = await getVideoTrack(sequence, params.videoTrackIndex);
  const items = await getSortedClips(track);
  const matchName = params.matchName ?? "AE.ADBE Lumetri";
  const factory = (ppro as any).VideoFilterFactory;

  const results: GradeTrackClipResult[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const entry: GradeTrackClipResult = {
      clipIndex: idx,
      clipName: await clipName(item),
      status: "graded",
    };
    try {
      // 1. Find existing instances of the effect.
      let chain = await item.getComponentChain();
      let comps = await listChainComponents(chain);
      const matchingNames = await Promise.all(
        comps.map(async (c) =>
          typeof c.getMatchName === "function" ? await c.getMatchName() : "",
        ),
      );
      const matchIdxs = matchingNames
        .map((mn, i) => (mn === matchName ? i : -1))
        .filter((i) => i >= 0);

      // 2. Remove duplicates (keep the first), so re-runs don't stack.
      let removed = 0;
      for (const dupI of matchIdxs.slice(1).reverse()) {
        await withLockedAccess(project, () => {
          project.executeTransaction((compound: any) => {
            compound.addAction(chain.createRemoveComponentAction(comps[dupI]));
          }, `MCP: dedupe ${matchName} on clip ${idx}`);
        });
        removed++;
      }
      entry.duplicatesRemoved = removed;

      // 3. Add the effect if absent.
      if (matchIdxs.length === 0) {
        await withLockedAccess(project, () => {
          const component =
            factory.createComponent?.(matchName) ?? factory.createComponent(matchName, true);
          if (!component) throw new Error(`createComponent("${matchName}") returned null`);
          project.executeTransaction((compound: any) => {
            compound.addAction(chain.createAppendComponentAction(component));
          }, `MCP: add ${matchName} on clip ${idx}`);
        });
        entry.effect = "added";
      } else {
        entry.effect = "reused";
      }

      // 4. Re-read the chain and locate the (now single) effect component.
      chain = await item.getComponentChain();
      comps = await listChainComponents(chain);
      let target: any;
      for (const c of comps) {
        const mn = typeof c.getMatchName === "function" ? await c.getMatchName() : "";
        if (mn === matchName) {
          target = c;
          break;
        }
      }
      if (!target) throw new Error(`effect ${matchName} missing after add`);

      // 5. Set each param (first display-name match = Basic Correction for Lumetri).
      const paramCount = await target.getParamCount();
      const cache: Record<string, any> = {};
      for (let p = 0; p < paramCount; p++) {
        const param = await target.getParam(p);
        // ComponentParam exposes displayName as a PROPERTY, not a method.
        const name =
          typeof param.getDisplayName === "function"
            ? await param.getDisplayName()
            : String(param.displayName ?? "");
        if (name && !(name in cache)) cache[name] = param;
      }
      let setCount = 0;
      for (const { paramName, value } of params.params) {
        const param = cache[paramName];
        if (!param) {
          entry.message = `${entry.message ?? ""}[no param "${paramName}"]`;
          continue;
        }
        await withLockedAccess(project, () => {
          project.executeTransaction((compound: any) => {
            const kf = param.createKeyframe(value);
            compound.addAction(param.createSetValueAction(kf, true));
          }, `MCP: ${matchName}/${paramName}=${value} clip ${idx}`);
        });
        setCount++;
      }
      entry.paramsSet = setCount;
    } catch (e) {
      entry.status = "error";
      entry.message = `${entry.message ?? ""}${e instanceof Error ? e.message : e}`;
    }
    results.push(entry);
  }

  return {
    matchName,
    clipCount: items.length,
    graded: results.filter((r) => r.status === "graded").length,
    errored: results.filter((r) => r.status === "error").length,
    results,
  };
}

// ---------------------------------------------------------------------------
// list_effects — VideoFilterFactory match/display names
// ---------------------------------------------------------------------------

export async function listEffects(params: ListEffectsParams): Promise<ListEffectsResult> {
  const factory = (ppro as any).VideoFilterFactory;
  if (!factory || typeof factory.getMatchNames !== "function") {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `VideoFilterFactory.getMatchNames unavailable — factory: ${describeShape(factory)}`,
    );
  }
  const matchNames: string[] = await factory.getMatchNames();
  let displayNames: string[] = [];
  try {
    displayNames = await factory.getDisplayNames();
  } catch {
    /* display names optional; align by index when present */
  }
  const filter = params.filter?.toLowerCase();
  const effects: EffectInfo[] = matchNames.map((mn, i) => ({
    matchName: String(mn),
    displayName: String(displayNames[i] ?? ""),
  }));
  return {
    effects: filter
      ? effects.filter(
          (e) =>
            e.matchName.toLowerCase().includes(filter) ||
            e.displayName.toLowerCase().includes(filter),
        )
      : effects,
  };
}

// ---------------------------------------------------------------------------
// add_clip_effect — createComponent + append to the clip's chain
// ---------------------------------------------------------------------------

export async function addClipEffect(params: AddClipEffectParams): Promise<AddClipEffectResult> {
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

  const factory = (ppro as any).VideoFilterFactory;
  if (!factory || typeof factory.createComponent !== "function") {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `VideoFilterFactory.createComponent unavailable — factory: ${describeShape(factory)}`,
    );
  }

  const chain = await item.getComponentChain();

  // Step 1: create the component. Try a few arg shapes — "Illegal Parameter
  // type" on a bare string means createComponent wants something richer.
  let component: any;
  const createErrors: string[] = [];
  const createAttempts: Array<{ label: string; run: () => any }> = [
    { label: "createComponent(matchName)", run: () => factory.createComponent(params.matchName) },
    { label: "createComponent(matchName,true)", run: () => factory.createComponent(params.matchName, true) },
    {
      label: "createComponentByDisplayName(matchName)",
      run: () =>
        typeof factory.createComponentByDisplayName === "function"
          ? factory.createComponentByDisplayName(params.matchName)
          : undefined,
    },
  ];
  for (const attempt of createAttempts) {
    try {
      const c = await attempt.run();
      if (c) {
        component = c;
        createErrors.push(`${attempt.label}: OK -> ${describeShape(c)}`);
        break;
      }
      createErrors.push(`${attempt.label}: returned ${String(c)}`);
    } catch (e) {
      createErrors.push(`${attempt.label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!component) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `createComponent failed — ${createErrors.join(" | ")} | factory: ${describeShape(factory)}`,
    );
  }

  // Step 2: append it to the chain inside a transaction.
  try {
    await withLockedAccess(project, () => {
      project.executeTransaction((compound: any) => {
        compound.addAction(chain.createAppendComponentAction(component));
      }, `MCP: add effect ${params.matchName}`);
    });
  } catch (e) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `append failed: ${e instanceof Error ? e.message : e} | component: ${describeShape(component)} | ` +
        `createLog: ${createErrors.join(" | ")}`,
    );
  }

  // Re-read components so the caller can confirm + see the new index.
  const components: string[] = [];
  const after = await item.getComponentChain();
  const count = await after.getComponentCount();
  for (let i = 0; i < count; i++) {
    const c = await after.getComponentAtIndex(i);
    components.push(typeof c.getMatchName === "function" ? await c.getMatchName() : "?");
  }

  return { ok: true, clipName: await clipName(item), matchName: params.matchName, components };
}
