import type { PingResult } from "@ppmcp/protocol";

const uxp = require("uxp");

export async function ping(): Promise<PingResult> {
  return {
    pong: true,
    hostVersion: uxp.host.version,
    pluginVersion: uxp.versions?.plugin ?? "0.1.0",
    timestamp: new Date().toISOString(),
  };
}
