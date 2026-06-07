import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_TRANSITION_MATCH_NAME,
  DEFAULT_TRANSITION_DURATION_SECONDS,
  type ApplyTransitionToAllCutsResult,
  type ApplyTransitionToClipResult,
  type GetSequenceClipsResult,
  type ListAvailableTransitionsResult,
  type ListSequencesResult,
  type PingResult,
  type ProjectInfoResult,
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
