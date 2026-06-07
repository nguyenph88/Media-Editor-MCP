import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_TRANSITION_MATCH_NAME,
  DEFAULT_TRANSITION_DURATION_SECONDS,
  type AddMarkersResult,
  type ApplyTransitionToAllCutsResult,
  type ApplyTransitionToClipResult,
  type CreateSequenceResult,
  type GetAudioClipsResult,
  type GetSequenceClipsResult,
  type ImportFilesResult,
  type ListAvailableTransitionsResult,
  type ListProjectItemsResult,
  type ListSequencesResult,
  type PingResult,
  type PlaceClipResult,
  type ProjectInfoResult,
  type RemoveClipsResult,
  type SetClipParamResult,
  type ProbeEffectsResult,
  type ListEffectsResult,
  type AddClipEffectResult,
  type GradeTrackResult,
  type RemoveTrackEffectResult,
  type SetClipLutResult,
} from "@ppmcp/protocol";
import { WsHost, BridgeError } from "../bridge/WsHost.js";
import { config } from "../config.js";

const alignmentSchema = z
  .enum(["center", "start", "end"])
  .describe('Where the transition sits relative to the cut: "center" (default), "start", or "end"');

export function registerTools(server: McpServer, bridge: WsHost): void {
  // -------------------------------------------------------------------------
  // premiere_health — never throws; diagnostic entry point
  // -------------------------------------------------------------------------
  server.registerTool(
    "premiere_health",
    {
      title: "Premiere connection health",
      description:
        "Check whether the Premiere Pro UXP plugin is connected to this MCP server. " +
        "Use this first if any other tool fails, or to diagnose setup issues.",
      inputSchema: {},
    },
    async () => {
      const info = bridge.pluginInfo;
      const health = {
        bridgeOwned: bridge.owned,
        wsPort: config.wsPort,
        pluginConnected: bridge.pluginConnected,
        premiereVersion: info?.host?.version ?? null,
        pluginVersion: info?.pluginVersion ?? null,
      };
      let summary: string;
      if (!bridge.owned) {
        summary =
          `Another MCP session owns the bridge port ${config.wsPort}. ` +
          "Premiere tools will not work in this session until the other one closes.";
      } else if (!bridge.pluginConnected) {
        summary =
          "Bridge is running but the Premiere plugin is NOT connected. " +
          "Open Premiere Pro and the 'MCP Bridge' panel (Window > UXP Plugins), " +
          "and make sure its status is green/connected.";
      } else {
        summary = `Connected to Premiere Pro ${health.premiereVersion} (plugin v${health.pluginVersion}).`;
      }
      return textResult(summary, health);
    },
  );

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_project_info",
    {
      title: "Get Premiere project info",
      description: "Get the currently open Premiere Pro project: name, path, and sequence count.",
      inputSchema: {},
    },
    wrap(async () => {
      const r = await bridge.sendCommand<ProjectInfoResult>("get_project_info", {});
      return textResult(
        `Project "${r.name}" (${r.sequenceCount} sequence(s), active: ${r.activeSequenceName ?? "none"})`,
        r,
      );
    }),
  );

  server.registerTool(
    "list_sequences",
    {
      title: "List sequences",
      description:
        "List all sequences in the open Premiere project with their track counts and frame rates.",
      inputSchema: {},
    },
    wrap(async () => {
      const r = await bridge.sendCommand<ListSequencesResult>("list_sequences", {});
      const lines = r.sequences.map(
        (s) =>
          `${s.isActive ? "* " : "  "}${s.name} — ${s.videoTrackCount}V/${s.audioTrackCount}A, ${s.frameRateFps}fps (id: ${s.id})`,
      );
      return textResult(lines.join("\n") || "No sequences found.", r);
    }),
  );

  server.registerTool(
    "get_sequence_clips",
    {
      title: "Get sequence clips",
      description:
        "List the clips on a sequence's video track(s) with timecodes. " +
        "Use this to inspect the timeline before applying transitions.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based video track index (V1 = 0); omit to list all tracks"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<GetSequenceClipsResult>("get_sequence_clips", args);
      const lines: string[] = [`Sequence "${r.sequenceName}" @ ${r.frameRateFps}fps`];
      for (const t of r.tracks) {
        lines.push(`Track V${t.trackIndex + 1} (${t.clips.length} clips):`);
        for (const c of t.clips) {
          lines.push(
            `  [${c.index}] ${c.name}  ${c.startTimecode} → ${c.endTimecode} (${c.durationSeconds.toFixed(2)}s)`,
          );
        }
      }
      return textResult(lines.join("\n"), r);
    }),
  );

  // -------------------------------------------------------------------------
  // Transition tools
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_available_transitions",
    {
      title: "List available transitions",
      description:
        "List the video transition matchNames installed in Premiere Pro " +
        '(e.g. to find the exact Cross Dissolve identifier). Optional substring filter, e.g. "dissolve".',
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring filter"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ListAvailableTransitionsResult>(
        "list_available_transitions",
        args,
      );
      return textResult(
        r.transitions.length
          ? `${r.transitions.length} transition(s):\n` + r.transitions.join("\n")
          : "No transitions matched.",
        r,
      );
    }),
  );

  server.registerTool(
    "apply_transition_to_all_cuts",
    {
      title: "Apply transition to all cuts",
      description:
        "Apply a video transition (default: Cross Dissolve) at every cut between adjacent clips " +
        "on a video track. Returns a per-cut report including cuts skipped for insufficient " +
        "handle media. This is the main bulk tool — one call covers a whole 20-30 clip timeline. " +
        "IMPORTANT: by default (onExisting='ask'), if any cut already has a transition, NOTHING " +
        "is applied and the existing transitions are returned — present them to the user and ask " +
        "whether to overwrite or keep them, then call again with onExisting='overwrite' or 'skip'.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("0-based video track index (V1 = 0)"),
        matchName: z
          .string()
          .default(DEFAULT_TRANSITION_MATCH_NAME)
          .describe("Transition matchName; see list_available_transitions"),
        durationSeconds: z
          .number()
          .positive()
          .max(10)
          .default(DEFAULT_TRANSITION_DURATION_SECONDS)
          .describe("Transition duration in seconds"),
        alignment: alignmentSchema.default("center"),
        skipInsufficientHandles: z
          .boolean()
          .default(true)
          .describe("Skip cuts that lack handle media instead of erroring"),
        onExisting: z
          .enum(["ask", "overwrite", "skip"])
          .default("ask")
          .describe(
            "What to do with cuts that already have a transition: 'ask' (default) applies " +
              "nothing if any exist and returns them for user confirmation; 'overwrite' " +
              "replaces them; 'skip' fills only the empty cuts",
          ),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ApplyTransitionToAllCutsResult>(
        "apply_transition_to_all_cuts",
        args,
        config.bulkCommandTimeoutMs,
      );

      if (r.pendingConfirmation) {
        const detail = r.existingTransitions ?? [];
        const lines: string[] = [];
        if (detail.length > 0) {
          lines.push(
            `NOTHING APPLIED YET — ${detail.length} of ${r.cutsFound} cut(s) already have a ` +
              "transition. Ask the user whether to overwrite them or keep them:",
          );
          for (const e of detail) {
            lines.push(
              `  cut ${e.cutIndex} @ ${e.atSeconds.toFixed(2)}s (${e.leftClip} → ${e.rightClip}): ` +
                `"${e.transitionName}" (${e.durationSeconds}s)`,
            );
          }
          lines.push(
            "Then call this tool again with onExisting='overwrite' (replace them) " +
              "or onExisting='skip' (keep them, fill only empty cuts).",
          );
        } else {
          lines.push(
            `NOTHING APPLIED YET — the track already has ${r.existingCount} transition(s). ` +
              "Premiere's API reports the count but not their positions or types " +
              "(Premiere 26.x UXP limitation), so selective skipping is not possible. " +
              "Ask the user: overwrite ALL cuts with the requested transition " +
              "(call again with onExisting='overwrite'), or cancel and let them adjust manually.",
          );
        }
        return textResult(lines.join("\n"), r);
      }

      const lines = [
        `Applied "${r.matchName}" (${r.durationSeconds}s) on track V${r.trackIndex + 1}: ` +
          `${r.applied}/${r.cutsFound} cuts applied, ${r.skipped} skipped, ${r.errored} errored.`,
      ];
      for (const c of r.results) {
        if (c.status !== "applied") {
          lines.push(
            `  cut ${c.cutIndex} (${c.leftClip} → ${c.rightClip} @ ${c.atSeconds.toFixed(2)}s): ${c.status}${c.message ? ` — ${c.message}` : ""}`,
          );
        }
      }
      return textResult(lines.join("\n"), r);
    }),
  );

  server.registerTool(
    "apply_transition_to_clip",
    {
      title: "Apply transition to one clip",
      description:
        "Apply a video transition (default: Cross Dissolve) to the start or end edge of a single " +
        "clip on a video track. Use get_sequence_clips first to find the clip index.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("0-based video track index (V1 = 0)"),
        clipIndex: z.number().int().min(0).describe("0-based clip index on the track"),
        edge: z.enum(["start", "end"]).describe("Which edge of the clip gets the transition"),
        matchName: z.string().default(DEFAULT_TRANSITION_MATCH_NAME),
        durationSeconds: z.number().positive().max(10).default(DEFAULT_TRANSITION_DURATION_SECONDS),
        alignment: alignmentSchema.default("center"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ApplyTransitionToClipResult>(
        "apply_transition_to_clip",
        args,
      );
      return textResult(
        r.status === "applied"
          ? `Transition applied to "${r.clipName}".`
          : `Not applied (${r.status})${r.message ? `: ${r.message}` : ""}`,
        r,
      );
    }),
  );

  // -------------------------------------------------------------------------
  // Editing primitives (Phase 2)
  // -------------------------------------------------------------------------
  server.registerTool(
    "add_markers",
    {
      title: "Add sequence markers",
      description:
        "Add markers to the active sequence's timeline ruler (e.g. at beat times from " +
        "media-analysis detect_beats). Batched: pass all markers in one call.",
      inputSchema: {
        sequenceId: z.string().optional(),
        markers: z
          .array(
            z.object({
              seconds: z.number().min(0),
              name: z.string().optional(),
              comments: z.string().optional(),
              colorIndex: z.number().int().min(0).max(7).optional()
                .describe("0 green, 1 red, 2 magenta, 3 orange, 4 yellow, 5 white, 6 blue, 7 cyan"),
              durationSeconds: z.number().positive().optional(),
            }),
          )
          .min(1)
          .max(500),
        clearExisting: z.boolean().default(false).describe("Remove all existing markers first"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<AddMarkersResult>("add_markers", args, config.bulkCommandTimeoutMs);
      return textResult(`Added ${r.added} marker(s)${r.removed ? `, removed ${r.removed} old` : ""}.`, r);
    }),
  );

  server.registerTool(
    "get_audio_clips",
    {
      title: "Get audio clips",
      description:
        "List clips on audio track(s) with timecodes AND source media file paths — " +
        "use the path to feed media-analysis tools (detect_beats, transcribe).",
      inputSchema: {
        sequenceId: z.string().optional(),
        audioTrackIndex: z.number().int().min(0).optional().describe("A1 = 0; omit for all"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<GetAudioClipsResult>("get_audio_clips", args);
      const lines: string[] = [`Sequence "${r.sequenceName}"`];
      for (const t of r.tracks) {
        lines.push(`Track ${t.trackName} (${t.clips.length} clips):`);
        for (const c of t.clips) {
          lines.push(`  [${c.index}] ${c.name}  ${c.startTimecode} → ${c.endTimecode}  ${c.mediaPath ?? "(no path)"}`);
        }
      }
      return textResult(lines.join("\n"), r);
    }),
  );

  server.registerTool(
    "list_project_items",
    {
      title: "List project bin items",
      description: "List all items in the project bins with type and media file path.",
      inputSchema: {},
    },
    wrap(async () => {
      const r = await bridge.sendCommand<ListProjectItemsResult>("list_project_items", {});
      const lines = r.items.map(
        (i) => `${i.type === "folder" ? "📁" : "🎞"} ${i.binPath === "/" ? "" : i.binPath + "/"}${i.name}${i.mediaPath ? `  (${i.mediaPath})` : ""}`,
      );
      return textResult(lines.join("\n") || "Project is empty.", r);
    }),
  );

  server.registerTool(
    "import_files",
    {
      title: "Import files into the project",
      description: "Import media files (video, audio, images, PNG overlays) into the project root bin.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(100).describe("Absolute file paths"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ImportFilesResult>("import_files", args, config.bulkCommandTimeoutMs);
      return textResult(`Imported: ${r.imported.join(", ")}`, r);
    }),
  );

  server.registerTool(
    "place_clip",
    {
      title: "Place a clip on the timeline",
      description:
        "Place a project item (by bin name) at an exact time on a track, optionally sliced " +
        "via source in/out points. The core primitive for beat-synced editing: place a slice " +
        "per beat slot. mode 'overwrite' (default) replaces what's there; 'insert' ripples. " +
        "A track index beyond the current count auto-creates the track (use for overlays).",
      inputSchema: {
        sequenceId: z.string().optional(),
        projectItemName: z.string().describe("Bin item name — see list_project_items"),
        atSeconds: z.number().min(0).describe("Timeline position for clip start"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0; higher = overlay tracks"),
        audioTrackIndex: z.number().int().min(0).optional().describe("Defaults to videoTrackIndex"),
        inSeconds: z.number().min(0).optional().describe("Slice start within source media"),
        outSeconds: z.number().min(0).optional().describe("Slice end within source media"),
        mode: z.enum(["overwrite", "insert"]).default("overwrite"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<PlaceClipResult>("place_clip", args);
      return textResult(
        `Placed "${r.clipName}" at ${r.placedAtSeconds.toFixed(2)}s on V${r.videoTrackIndex + 1}.`,
        r,
      );
    }),
  );

  server.registerTool(
    "remove_clips",
    {
      title: "Remove clips from a track",
      description: "Remove clips by index from a video track. ripple=true closes the gaps.",
      inputSchema: {
        sequenceId: z.string().optional(),
        videoTrackIndex: z.number().int().min(0),
        clipIndexes: z.array(z.number().int().min(0)).min(1),
        ripple: z.boolean().default(false),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<RemoveClipsResult>("remove_clips", args);
      return textResult(`Removed ${r.removed} clip(s).`, r);
    }),
  );

  server.registerTool(
    "create_sequence",
    {
      title: "Create a sequence",
      description:
        "Create a new sequence whose settings match the given media item(s); the items are " +
        "placed in it. Becomes the active sequence by default.",
      inputSchema: {
        name: z.string(),
        fromProjectItemNames: z.array(z.string()).min(1).describe("Bin item names"),
        activate: z.boolean().default(true),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<CreateSequenceResult>("create_sequence", args, config.bulkCommandTimeoutMs);
      return textResult(`Created sequence "${r.sequenceName}" (id: ${r.sequenceId}).`, r);
    }),
  );

  // -------------------------------------------------------------------------
  // Per-clip transform (beat punch-ins, etc.)
  // -------------------------------------------------------------------------
  server.registerTool(
    "set_clip_param",
    {
      title: "Set a clip transform/effect param",
      description:
        "Set a fixed numeric value on a placed clip's component param — e.g. " +
        'componentMatchName "AE.ADBE Motion", paramName "Scale", value 108 for a ' +
        "108% punch-in zoom. Also works for Rotation, Opacity. Used to add beat " +
        "punch-ins (alternate Scale per clip so each cut hits visually).",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        clipIndex: z.number().int().min(0).describe("0-based clip index on the track (by start time)"),
        componentMatchName: z
          .string()
          .default("AE.ADBE Motion")
          .describe('Component matchName (default "AE.ADBE Motion")'),
        paramName: z.string().describe('Param display name, e.g. "Scale", "Rotation", "Opacity"'),
        value: z.number().describe("New numeric value (Scale 108 = 108%)"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<SetClipParamResult>("set_clip_param", args);
      return textResult(`Set ${r.componentMatchName}/${r.paramName} = ${r.value} on "${r.clipName}".`, r);
    }),
  );

  // -------------------------------------------------------------------------
  // probe_effects — discovery for adding Lumetri/effects (issue #4)
  // -------------------------------------------------------------------------
  server.registerTool(
    "probe_effects",
    {
      title: "Probe the effect/component API surface",
      description:
        "Read-only discovery: dumps a clip's component-chain shape, its existing " +
        "components, and ppro effect/filter/factory keys — to find whether/how an " +
        "effect (e.g. Lumetri Color) can be added to a clip.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        clipIndex: z.number().int().min(0).describe("0-based clip index on the track (by start time)"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ProbeEffectsResult>("probe_effects", args);
      const lines = [
        `clip: ${r.clipName}`,
        `chain: ${r.chainShape}`,
        `components: ${r.components.join(", ")}`,
        `ppro effect keys: ${r.pproEffectKeys.join(", ")}`,
        ...Object.entries(r.factoryShapes).map(([k, v]) => `  ${k}: ${v}`),
        ...(r.notes.length ? [`notes: ${r.notes.join(" | ")}`] : []),
      ];
      return textResult(lines.join("\n"), r);
    }),
  );

  server.registerTool(
    "list_effects",
    {
      title: "List available video effects",
      description:
        "List installed video effect matchNames + display names (from VideoFilterFactory). " +
        'Optional case-insensitive filter, e.g. "lumetri" or "color".',
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring filter"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<ListEffectsResult>("list_effects", args);
      const lines = r.effects.map((e) => `${e.displayName || "(no name)"} — ${e.matchName}`);
      return textResult(
        r.effects.length ? `${r.effects.length} effect(s):\n${lines.join("\n")}` : "No effects matched.",
        r,
      );
    }),
  );

  server.registerTool(
    "add_clip_effect",
    {
      title: "Add a video effect to a clip",
      description:
        "Add a video effect (e.g. Lumetri Color) to a placed clip via its matchName " +
        "(see list_effects). After adding, use set_clip_param with the effect's " +
        "componentMatchName to adjust its parameters (Exposure, Saturation, etc.).",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        clipIndex: z.number().int().min(0).describe("0-based clip index on the track (by start time)"),
        matchName: z.string().describe("Effect matchName from list_effects"),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<AddClipEffectResult>("add_clip_effect", args);
      return textResult(
        `Added ${r.matchName} to "${r.clipName}". Components now: ${r.components.join(", ")}.`,
        r,
      );
    }),
  );

  server.registerTool(
    "grade_track",
    {
      title: "Color grade every clip on a track",
      description:
        "Apply one effect (default Lumetri Color) + a set of numeric params to EVERY clip on a " +
        "video track, in one reliable sequential pass. Idempotent: ensures exactly one effect " +
        "instance per clip (adds if missing, removes duplicates), so re-running re-grades rather " +
        "than stacking. Use for consistent looks across a whole reel.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        matchName: z
          .string()
          .default("AE.ADBE Lumetri")
          .describe('Effect matchName (default "AE.ADBE Lumetri")'),
        params: z
          .array(z.object({ paramName: z.string(), value: z.number() }))
          .describe('e.g. [{"paramName":"Temperature","value":20},{"paramName":"Saturation","value":85}]'),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<GradeTrackResult>("grade_track", args, config.bulkCommandTimeoutMs);
      return textResult(
        `Graded ${r.graded}/${r.clipCount} clips with ${r.matchName} (${r.errored} errors).`,
        r,
      );
    }),
  );

  server.registerTool(
    "remove_track_effect",
    {
      title: "Remove an effect from every clip on a track",
      description:
        "Strip an effect (default Lumetri Color) from every clip on a video track — the grade " +
        "reset. Use before applying a fresh look so old params don't linger. One sequential pass.",
      inputSchema: {
        sequenceId: z.string().optional().describe("Sequence id; defaults to the active sequence"),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        matchName: z
          .string()
          .default("AE.ADBE Lumetri")
          .describe('Effect matchName to remove (default "AE.ADBE Lumetri")'),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<RemoveTrackEffectResult>("remove_track_effect", args, config.bulkCommandTimeoutMs);
      return textResult(
        `Removed ${r.removed} ${r.matchName} instance(s) across ${r.clipCount} clips (${r.errored} errors).`,
        r,
      );
    }),
  );

  server.registerTool(
    "set_clip_lut",
    {
      title: "Load a LUT / Creative Look into a clip's Lumetri",
      description:
        "DISCOVERY: attempt to set a clip's Lumetri 'Look' or 'Input LUT' param to a .cube " +
        "file (e.g. a Fuji/Kodak film look). Tries several value forms (name, basename, full " +
        "path) and setters, and returns diagnostics about the param either way. The clip must " +
        "already have Lumetri (grade it first).",
      inputSchema: {
        sequenceId: z.string().optional(),
        videoTrackIndex: z.number().int().min(0).describe("V1 = 0"),
        clipIndex: z.number().int().min(0),
        lutPath: z.string().describe("Absolute .cube path"),
        paramName: z.string().default("Look").describe('Lumetri param: "Look" (Creative) or "Input LUT" (Basic)'),
      },
    },
    wrap(async (args) => {
      const r = await bridge.sendCommand<SetClipLutResult>("set_clip_lut", args);
      const head = r.ok ? `LUT set on "${r.paramName}" via ${r.methodUsed}.` : `Could not set "${r.paramName}".`;
      return textResult(`${head}\nDiagnostics:\n${r.diagnostics.join("\n")}`, r);
    }),
  );

  // ping is internal (used by premiere_health flow) but useful to expose for debugging
  server.registerTool(
    "premiere_ping",
    {
      title: "Ping the Premiere plugin",
      description: "Round-trip latency/liveness test against the UXP plugin inside Premiere.",
      inputSchema: {},
    },
    wrap(async () => {
      const start = Date.now();
      const r = await bridge.sendCommand<PingResult>("ping", {});
      return textResult(`pong from Premiere ${r.hostVersion} in ${Date.now() - start}ms`, r);
    }),
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textResult(text: string, structured?: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured !== undefined
      ? { structuredContent: structured as Record<string, unknown> }
      : {}),
  };
}

/** Convert BridgeErrors into readable MCP tool errors instead of protocol failures. */
function wrap<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? `[${err.code}] ${err.message}`
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };
}
