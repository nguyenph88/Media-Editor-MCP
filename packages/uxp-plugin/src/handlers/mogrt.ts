/**
 * MOGRT (Motion Graphics Template) handlers — PROTOTYPE.
 *
 * The M2 discovery dump showed SequenceEditor carries a MOGRT insert action,
 * but the exact method name and the component/param surface for adjusting a
 * placed graphic are unverified. Every call here therefore probes candidate
 * method names and reports the REAL shapes in errors/results, per the house
 * discovery pattern: run it, read the dump, fix the accessor.
 */
import type {
  InsertMogrtParams,
  InsertMogrtResult,
  GetMogrtParamsParams,
  GetMogrtParamsResult,
  MogrtParamInfo,
  SetMogrtParamParams,
  SetMogrtParamResult,
} from "@ppmcp/protocol";
import { BridgeError } from "../errors.js";
import {
  ppro,
  getActiveProject,
  resolveSequence,
  getTimebase,
  getSequenceEditor,
  getVideoTrack,
  getSortedClips,
  clipName,
  secondsToFrameSnappedTickTime,
  describeShape,
  withLockedAccess,
} from "./ppro.js";

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return "<unserializable>";
  }
}

// ---------------------------------------------------------------------------
// insert_mogrt
// ---------------------------------------------------------------------------

export async function insertMogrt(params: InsertMogrtParams): Promise<InsertMogrtResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);
  const timebase = await getTimebase(sequence);
  const editor = getSequenceEditor(sequence);

  const atT = secondsToFrameSnappedTickTime(params.atSeconds, timebase);
  const v = params.videoTrackIndex;
  const a = params.audioTrackIndex ?? params.videoTrackIndex;

  // Verified live (26.2.2): the editor exposes insertMogrtFromPath /
  // insertMogrtFromLibrary as DIRECT methods (not action factories — no
  // transaction needed). Time-arg shape unverified, so try TickTime then
  // raw seconds.
  const fn = (editor as any).insertMogrtFromPath;
  if (typeof fn !== "function") {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `insertMogrtFromPath unavailable — editor: ${describeShape(editor)}`,
    );
  }
  const errors: string[] = [];
  for (const [label, timeArg] of [
    ["tickTime", atT],
    ["seconds", params.atSeconds],
  ] as const) {
    try {
      const result = await withLockedAccess(project, () =>
        fn.call(editor, params.mogrtPath, timeArg, v, a),
      );
      if (result === false || result == null) {
        errors.push(`${label}: returned ${String(result)}`);
        continue;
      }
      return {
        ok: true,
        insertedAtSeconds: params.atSeconds,
        videoTrackIndex: v,
        mogrtName: params.mogrtPath.split(/[\\/]/).pop() ?? params.mogrtPath,
        methodUsed: `insertMogrtFromPath(${label}) → ${describeShape(result)}`,
      };
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw new BridgeError(
    "PREMIERE_API_ERROR",
    `insertMogrtFromPath failed — ${errors.join(" | ")} | editor: ${describeShape(editor)}`,
  );
}

// ---------------------------------------------------------------------------
// get_mogrt_params — also the discovery probe for the component surface
// ---------------------------------------------------------------------------

/** Find the trackItem for (videoTrackIndex, clipIndex). */
async function findClip(params: {
  sequenceId?: string;
  videoTrackIndex: number;
  clipIndex: number;
}): Promise<{ project: any; item: any }> {
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
  return { project, item: items[params.clipIndex] };
}

/** Components of a trackItem, via whichever accessor this build exposes. */
async function getComponents(item: any, notes: string[]): Promise<any[]> {
  // Candidate A: ExtendScript-style direct MGT component
  if (typeof item.getMGTComponent === "function") {
    try {
      const mgt = await item.getMGTComponent();
      if (mgt) return [mgt];
      notes.push("getMGTComponent() returned null");
    } catch (e) {
      notes.push(`getMGTComponent threw: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Candidate B: UXP component chain
  if (typeof item.getComponentChain === "function") {
    const chain = await item.getComponentChain();
    if (chain) {
      const count =
        typeof chain.getComponentCount === "function" ? await chain.getComponentCount() : 0;
      const comps: any[] = [];
      for (let i = 0; i < count; i++) comps.push(await chain.getComponentAtIndex(i));
      if (comps.length > 0) return comps;
      notes.push(`componentChain empty — chain: ${describeShape(chain)}`);
    }
  }
  notes.push(`no component accessor worked — item: ${describeShape(item)}`);
  return [];
}

/** Params of one component, tolerant of count/array style accessors. */
async function getComponentParams(comp: any, notes: string[]): Promise<any[]> {
  if (typeof comp.getParamCount === "function" && typeof comp.getParam === "function") {
    const count = await comp.getParamCount();
    const out: any[] = [];
    for (let i = 0; i < count; i++) out.push(await comp.getParam(i));
    return out;
  }
  if (typeof comp.getParams === "function") {
    const arr = await comp.getParams();
    if (Array.isArray(arr)) return arr;
  }
  notes.push(`no param accessor on component — ${describeShape(comp)}`);
  return [];
}

async function readParamValue(param: any): Promise<{ value: unknown; valueType: string }> {
  try {
    // Verified surface (26.2.2): values live in Keyframe objects; the current
    // static value comes from getStartValue().
    const sources: Array<() => any> = [
      () => (typeof param.getStartValue === "function" ? param.getStartValue() : undefined),
      // Text params return null from getStartValue — getValueAtTime(0) works.
      () =>
        typeof param.getValueAtTime === "function"
          ? param.getValueAtTime(ppro.TickTime.createWithTicks("0"))
          : undefined,
    ];
    for (const src of sources) {
      const kf = await src();
      if (kf == null) continue;
      const v = kf?.value !== undefined ? kf.value : kf;
      const t = typeof v;
      if (t === "string" || t === "number" || t === "boolean") return { value: v, valueType: t };
      if (v == null) continue;
      // Object value (color, point, text document): try JSON, else dump shape.
      try {
        const json = JSON.parse(JSON.stringify(v));
        return { value: json, valueType: `object:${describeShape(v)}` };
      } catch {
        return { value: describeShape(v), valueType: `unknown:${describeShape(v)}` };
      }
    }
  } catch (e) {
    return { value: `read failed: ${e instanceof Error ? e.message : e}`, valueType: "unknown" };
  }
  return { value: null, valueType: "unknown" };
}

export async function getMogrtParams(params: GetMogrtParamsParams): Promise<GetMogrtParamsResult> {
  const { item } = await findClip(params);
  const notes: string[] = [];
  const comps = await getComponents(item, notes);

  const out: MogrtParamInfo[] = [];
  for (let c = 0; c < comps.length; c++) {
    const comp = comps[c];
    const matchName =
      typeof comp.getMatchName === "function"
        ? await comp.getMatchName()
        : String(comp.matchName ?? `component-${c}`);
    const compParams = await getComponentParams(comp, notes);
    for (let p = 0; p < compParams.length; p++) {
      const param = compParams[p];
      const displayName =
        typeof param.getDisplayName === "function"
          ? await param.getDisplayName()
          : String(param.displayName ?? param.name ?? `param-${p}`);
      const { value, valueType } = await readParamValue(param);
      out.push({
        componentIndex: c,
        componentMatchName: String(matchName),
        paramIndex: p,
        displayName: String(displayName),
        value,
        valueType,
      });
    }
  }

  return { clipName: await clipName(item), params: out, discoveryNotes: notes };
}

// ---------------------------------------------------------------------------
// set_mogrt_param
// ---------------------------------------------------------------------------

export async function setMogrtParam(params: SetMogrtParamParams): Promise<SetMogrtParamResult> {
  const { project, item } = await findClip(params);
  const notes: string[] = [];
  const comps = await getComponents(item, notes);
  const comp = comps[params.componentIndex];
  if (!comp) {
    throw new BridgeError(
      "BAD_PARAMS",
      `componentIndex ${params.componentIndex} out of range (clip has ${comps.length}). Notes: ${notes.join(" | ")}`,
    );
  }
  const compParams = await getComponentParams(comp, notes);
  const param = compParams[params.paramIndex];
  if (!param) {
    throw new BridgeError(
      "BAD_PARAMS",
      `paramIndex ${params.paramIndex} out of range (component has ${compParams.length}).`,
    );
  }
  const displayName =
    typeof param.getDisplayName === "function"
      ? await param.getDisplayName()
      : String(param.displayName ?? param.name ?? `param-${params.paramIndex}`);

  // Verified surface (26.2.2): ComponentParam values live in Keyframe objects;
  // createKeyframe REQUIRES the value as its argument. Text params return null
  // from getStartValue, so for strings also try a keyframe built from the
  // current getValueAtTime(0) document with its text field replaced.
  const errors: string[] = [];
  const keyframeSources: Array<{ name: string; make: () => Promise<any> }> = [
    { name: "createKeyframe(value)", make: async () => param.createKeyframe(params.value) },
    {
      name: "getStartValue+mutate",
      make: async () => {
        const kf = await param.getStartValue();
        if (kf) kf.value = params.value;
        return kf;
      },
    },
    {
      // Rich value types (text documents): getValueAtTime refuses them and
      // points to "GetKeyframeAtTime" — the live name is getKeyframePtr(time).
      name: "getKeyframePtr(0)+mutate",
      make: async () => {
        const kf = await param.getKeyframePtr?.(ppro.TickTime.createWithTicks("0"));
        if (kf == null) return null;
        const doc = kf.value;
        if (typeof params.value === "string" && doc != null && typeof doc === "object") {
          const textKeys = ["textEditValue", "text", "sourceText", "mText"];
          const hit = textKeys.find((k) => typeof doc[k] === "string");
          if (hit) {
            doc[hit] = params.value;
            return kf;
          }
          if (typeof doc.setText === "function") {
            await doc.setText(params.value);
            return kf;
          }
          throw new Error(`text doc shape unhandled: ${describeShape(doc)} json:${safeJson(doc)}`);
        }
        kf.value = params.value;
        return kf;
      },
    },
  ];
  const setterShapes: Array<{ name: string; call: (kf: any) => any }> = [
    { name: "setValueAction(kf,true)", call: (kf) => param.createSetValueAction(kf, true) },
    { name: "setValueAction(kf)", call: (kf) => param.createSetValueAction(kf) },
  ];
  for (const src of keyframeSources) {
    let kf: any;
    try {
      kf = await src.make();
    } catch (e) {
      errors.push(`${src.name}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!kf) {
      errors.push(`${src.name}: keyframe is ${String(kf)}`);
      continue;
    }
    for (const setter of setterShapes) {
      try {
        await withLockedAccess(project, () => {
          project.executeTransaction((compound: any) => {
            compound.addAction(setter.call(kf));
          }, `MCP: set MOGRT param "${displayName}"`);
        });
        return {
          ok: true,
          displayName: String(displayName),
          methodUsed: `${src.name} → ${setter.name}`,
        };
      } catch (e) {
        errors.push(`${src.name}→${setter.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  throw new BridgeError(
    "PREMIERE_API_ERROR",
    `set_mogrt_param failed — ${errors.join(" | ")} | param: ${describeShape(param)}`,
  );
}
