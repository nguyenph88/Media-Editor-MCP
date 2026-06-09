import { connect, disconnect, isConnected } from "./wsClient.js";
import { onToggleClick, logLine, setStatus } from "./ui.js";

setStatus("disconnected");
logLine("MCP Bridge panel loaded");

onToggleClick(() => {
  if (isConnected()) {
    disconnect();
  } else {
    connect();
  }
});

// Auto-connect on panel load; reconnect loop takes over from there.
connect();
