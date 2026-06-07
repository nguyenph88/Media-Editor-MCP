import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type CommandName,
  type CommandEnvelope,
  type PluginToServerEnvelope,
  type HelloEnvelope,
  type BridgeErrorCode,
} from "@ppmcp/protocol";
import { config } from "../config.js";

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: BridgeError) => void;
  timer: NodeJS.Timeout;
}

const NOT_CONNECTED_MSG =
  "Premiere plugin is not connected. Make sure Premiere Pro is running and the " +
  '"MCP Bridge" panel is open (Window > UXP Plugins / Extensions > MCP Bridge), ' +
  "then check that its status dot is green.";

const NOT_OWNED_MSG = (port: number) =>
  `Another Premiere-MCP session already owns the bridge on port ${port}. ` +
  "Use that session for Premiere commands, or close it and retry here.";

/**
 * Embedded WebSocket host the UXP plugin connects to.
 *
 * - At most one plugin connection; a newer connection replaces the old one.
 * - If the port is taken (another MCP session owns it), we degrade gracefully:
 *   tools return BRIDGE_NOT_OWNED instead of the process crashing.
 */
export class WsHost {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private hello: HelloEnvelope | null = null;
  private pending = new Map<string, PendingRequest>();
  private heartbeat: NodeJS.Timeout | null = null;
  private lastPongAt = 0;

  /** False when another process owns the port. */
  public owned = false;

  constructor(private readonly port: number) {}

  start(): void {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port });

    wss.on("listening", () => {
      this.owned = true;
      log(`bridge listening on ws://127.0.0.1:${this.port}`);
    });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        this.owned = false;
        this.wss = null;
        log(
          `port ${this.port} in use — another session owns the bridge; ` +
            "Premiere tools in this session will return a clear error",
        );
        return;
      }
      log(`bridge server error: ${err.message}`);
    });

    wss.on("connection", (ws) => this.onConnection(ws));
    this.wss = wss;
  }

  private onConnection(ws: WebSocket): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      log("new plugin connection replaces existing one");
      this.socket.close(4000, "replaced by newer connection");
      this.rejectAllPending("PLUGIN_NOT_CONNECTED", "Plugin connection was replaced.");
    }
    this.socket = ws;
    this.hello = null;
    this.lastPongAt = Date.now();
    log("plugin connected");

    ws.on("message", (data) => {
      let envelope: PluginToServerEnvelope;
      try {
        envelope = JSON.parse(data.toString());
      } catch {
        log(`unparseable frame from plugin: ${data.toString().slice(0, 200)}`);
        return;
      }
      this.onEnvelope(envelope);
    });

    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    ws.on("close", () => {
      if (this.socket === ws) {
        this.socket = null;
        this.hello = null;
        log("plugin disconnected");
        this.rejectAllPending("PLUGIN_NOT_CONNECTED", NOT_CONNECTED_MSG);
      }
    });

    ws.on("error", (err) => log(`plugin socket error: ${err.message}`));

    this.startHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > config.heartbeatTimeoutMs) {
        log("plugin heartbeat timed out — dropping connection");
        ws.terminate();
        return;
      }
      ws.ping();
    }, config.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private onEnvelope(envelope: PluginToServerEnvelope): void {
    if (envelope.type === "hello") {
      this.hello = envelope;
      log(
        `plugin hello: premiere ${envelope.host?.version ?? "?"} / ` +
          `plugin ${envelope.pluginVersion ?? "?"}`,
      );
      return;
    }

    const pending = this.pending.get(envelope.id ?? "");
    if (!pending) {
      log(`response for unknown request id: ${envelope.id}`);
      return;
    }
    this.pending.delete(envelope.id!);
    clearTimeout(pending.timer);

    if (envelope.type === "result") {
      pending.resolve(envelope.result);
    } else {
      pending.reject(
        new BridgeError(envelope.error.code, envelope.error.message, envelope.error.detail),
      );
    }
  }

  private rejectAllPending(code: BridgeErrorCode, message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(code, message));
    }
    this.pending.clear();
  }

  get pluginConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  get pluginInfo(): HelloEnvelope | null {
    return this.hello;
  }

  sendCommand<R = unknown>(
    command: CommandName,
    params: unknown,
    timeoutMs: number = config.commandTimeoutMs,
  ): Promise<R> {
    if (!this.owned) {
      return Promise.reject(new BridgeError("BRIDGE_NOT_OWNED", NOT_OWNED_MSG(this.port)));
    }
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError("PLUGIN_NOT_CONNECTED", NOT_CONNECTED_MSG));
    }

    const id = randomUUID();
    const envelope: CommandEnvelope = {
      v: PROTOCOL_VERSION,
      type: "command",
      id,
      command,
      params: params ?? {},
      deadlineMs: timeoutMs,
    };

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            "TIMEOUT",
            `Premiere did not respond to "${command}" within ${timeoutMs / 1000}s. ` +
              "Premiere may be busy (rendering, modal dialog open) — check the app and retry.",
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify(envelope), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new BridgeError("PLUGIN_NOT_CONNECTED", `Failed to send: ${err.message}`));
        }
      });
    });
  }
}

/** stdout is reserved for MCP stdio transport — all logging goes to stderr. */
function log(msg: string): void {
  process.stderr.write(`[ppmcp-bridge] ${msg}\n`);
}
