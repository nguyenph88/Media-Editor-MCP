import {
  PROTOCOL_VERSION,
  type CommandEnvelope,
  type HelloEnvelope,
  type PluginToServerEnvelope,
} from "@ppmcp/protocol";
import { setStatus, logLine } from "./ui.js";
import { dispatch } from "./dispatcher.js";

const uxp = require("uxp");

const WS_URL = "ws://127.0.0.1:3001";
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

let ws: WebSocket | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let manualClose = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  manualClose = false;
  setStatus("connecting");
  logLine(`connecting to ${WS_URL} ...`);

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    logLine(`WebSocket create failed: ${String(e)}`);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    backoffMs = INITIAL_BACKOFF_MS;
    setStatus("connected");
    logLine("connected to MCP bridge");
    sendHello();
  };

  ws.onmessage = (ev: MessageEvent) => {
    void handleFrame(String(ev.data));
  };

  ws.onclose = () => {
    ws = null;
    setStatus("disconnected");
    if (!manualClose) {
      logLine("connection lost");
      scheduleReconnect();
    } else {
      logLine("disconnected");
    }
  };

  ws.onerror = () => {
    // onerror is always followed by onclose; just make sure we tear down.
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

export function disconnect(): void {
  manualClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
  setStatus("disconnected");
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  logLine(`retrying in ${(backoffMs / 1000).toFixed(1)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function send(envelope: PluginToServerEnvelope): void {
  if (!isConnected()) return;
  ws!.send(JSON.stringify(envelope));
}

function sendHello(): void {
  const hello: HelloEnvelope = {
    v: PROTOCOL_VERSION,
    type: "hello",
    role: "uxp-plugin",
    host: { app: "premierepro", version: uxp.host.version },
    pluginVersion: uxp.versions?.plugin ?? "0.1.0",
  };
  send(hello);
}

async function handleFrame(raw: string): Promise<void> {
  let envelope: CommandEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    send({
      v: PROTOCOL_VERSION,
      type: "error",
      id: null,
      ok: false,
      error: { code: "INTERNAL", message: "Unparseable frame from server" },
    });
    return;
  }
  if (envelope.type !== "command") return;

  logLine(`▶ ${envelope.command}`);
  const response = await dispatch(envelope);
  send(response);
  logLine(`◀ ${envelope.command}: ${response.type === "result" ? "ok" : (response as { error: { code: string } }).error.code}`);
}
