/**
 * Smoke test: spawns the MCP server, connects a FAKE UXP plugin over WebSocket,
 * then drives the server over stdio MCP (newline-delimited JSON-RPC) and checks
 * that premiere_health and premiere_ping round-trip through the bridge.
 *
 * Run: node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(root, "packages", "server", "dist", "index.js");

// Own port so the test never collides with (or hijacks!) a live session's bridge.
const WS_PORT = 3199;

const child = spawn(process.execPath, [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PPMCP_WS_PORT: String(WS_PORT) },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const pendingRpc = new Map();

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 10_000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pendingRpc.has(msg.id)) {
      const p = pendingRpc.get(msg.id);
      pendingRpc.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  }
});

// --- fake UXP plugin -------------------------------------------------------
function startFakePlugin() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "hello",
          role: "uxp-plugin",
          host: { app: "premierepro", version: "26.0-fake" },
          pluginVersion: "0.1.0-fake",
        }),
      );
      resolve(ws);
    });
    ws.on("message", (data) => {
      const cmd = JSON.parse(data.toString());
      if (cmd.type !== "command") return;
      if (cmd.command === "ping") {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "result",
            id: cmd.id,
            ok: true,
            result: {
              pong: true,
              hostVersion: "26.0-fake",
              pluginVersion: "0.1.0-fake",
              timestamp: new Date().toISOString(),
            },
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "error",
            id: cmd.id,
            ok: false,
            error: { code: "UNKNOWN_COMMAND", message: `fake plugin: ${cmd.command}` },
          }),
        );
      }
    });
    ws.on("error", reject);
  });
}

// --- test sequence ---------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

function check(label, cond, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failed = true;
  console.log(`${mark}  ${label}${extra ? ` — ${extra}` : ""}`);
}

try {
  await sleep(500); // let WS host bind

  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.1" },
  });
  notify("notifications/initialized", {});
  check("MCP initialize", true);

  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort();
  check("tools/list", names.length === 8, names.join(", "));

  // health BEFORE plugin connects
  let health = await rpc("tools/call", { name: "premiere_health", arguments: {} });
  check(
    "health: disconnected state reported",
    health.structuredContent?.pluginConnected === false,
    health.content[0].text.slice(0, 80),
  );

  // ping should fail cleanly with PLUGIN_NOT_CONNECTED
  const pingFail = await rpc("tools/call", { name: "premiere_ping", arguments: {} });
  check(
    "ping w/o plugin: clean error",
    pingFail.isError === true && pingFail.content[0].text.includes("PLUGIN_NOT_CONNECTED"),
  );

  // connect fake plugin
  const ws = await startFakePlugin();
  await sleep(300);

  health = await rpc("tools/call", { name: "premiere_health", arguments: {} });
  check(
    "health: connected, hello consumed",
    health.structuredContent?.pluginConnected === true &&
      health.structuredContent?.premiereVersion === "26.0-fake",
  );

  const ping = await rpc("tools/call", { name: "premiere_ping", arguments: {} });
  check(
    "ping round-trip through bridge",
    ping.isError !== true && ping.structuredContent?.pong === true,
    ping.content[0].text,
  );

  // unknown command path: error envelope surfaces as tool error
  const unknownResult = await rpc("tools/call", { name: "get_project_info", arguments: {} });
  check(
    "plugin error envelope surfaces cleanly",
    unknownResult.isError === true && unknownResult.content[0].text.includes("UNKNOWN_COMMAND"),
  );

  // disconnect: health flips back
  ws.close();
  await sleep(300);
  health = await rpc("tools/call", { name: "premiere_health", arguments: {} });
  check("health: disconnect detected", health.structuredContent?.pluginConnected === false);

  console.log(failed ? "\nSMOKE TEST FAILED" : "\nSMOKE TEST PASSED");
} catch (err) {
  console.error("SMOKE TEST ERROR:", err);
  failed = true;
} finally {
  child.kill();
  process.exit(failed ? 1 : 0);
}
