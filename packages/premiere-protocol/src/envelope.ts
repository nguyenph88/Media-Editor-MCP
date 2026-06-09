/**
 * Wire protocol between the MCP server (WebSocket host) and the UXP plugin
 * running inside Premiere Pro (WebSocket client).
 *
 * All frames are JSON, one envelope per WebSocket message.
 */

import type { CommandName } from "./commands.js";

export const PROTOCOL_VERSION = 1 as const;

export type BridgeErrorCode =
  | "PLUGIN_NOT_CONNECTED"
  | "TIMEOUT"
  | "BAD_PARAMS"
  | "PREMIERE_API_ERROR"
  | "NO_ACTIVE_PROJECT"
  | "NO_ACTIVE_SEQUENCE"
  | "TRACK_OUT_OF_RANGE"
  | "CLIP_OUT_OF_RANGE"
  | "UNKNOWN_COMMAND"
  | "BRIDGE_NOT_OWNED"
  | "INTERNAL";

/** Server -> plugin: execute a command. */
export interface CommandEnvelope<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: "command";
  id: string;
  command: CommandName;
  params: P;
  /** Soft deadline hint for the plugin, in milliseconds. */
  deadlineMs: number;
}

/** Plugin -> server: successful command result. */
export interface ResultEnvelope<R = unknown> {
  v: typeof PROTOCOL_VERSION;
  type: "result";
  id: string;
  ok: true;
  result: R;
}

/** Plugin -> server: command failed. `id` is null for unparseable frames. */
export interface ErrorEnvelope {
  v: typeof PROTOCOL_VERSION;
  type: "error";
  id: string | null;
  ok: false;
  error: {
    code: BridgeErrorCode;
    message: string;
    detail?: unknown;
  };
}

/** Plugin -> server: sent once, unsolicited, immediately after connecting. */
export interface HelloEnvelope {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  role: "uxp-plugin";
  host: {
    app: "premierepro";
    version: string;
  };
  pluginVersion: string;
}

export type PluginToServerEnvelope = ResultEnvelope | ErrorEnvelope | HelloEnvelope;
export type ServerToPluginEnvelope = CommandEnvelope;
export type AnyEnvelope = PluginToServerEnvelope | ServerToPluginEnvelope;

export function isHello(e: AnyEnvelope): e is HelloEnvelope {
  return e.type === "hello";
}
export function isResult(e: AnyEnvelope): e is ResultEnvelope {
  return e.type === "result";
}
export function isError(e: AnyEnvelope): e is ErrorEnvelope {
  return e.type === "error";
}
export function isCommand(e: AnyEnvelope): e is CommandEnvelope {
  return e.type === "command";
}
