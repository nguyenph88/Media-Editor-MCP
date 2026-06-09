#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsHost } from "./bridge/WsHost.js";
import { registerTools } from "./mcp/registerTools.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const bridge = new WsHost(config.wsPort);
  bridge.start();

  const server = new McpServer({
    name: "premiere-pro",
    version: "0.1.0",
  });

  registerTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[ppmcp] MCP server ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[ppmcp] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
