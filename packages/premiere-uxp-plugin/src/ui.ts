export type ConnectionState = "disconnected" | "connecting" | "connected";

const dot = () => document.getElementById("dot")!;
const statusEl = () => document.getElementById("status")!;
const logEl = () => document.getElementById("log")!;
const toggleBtn = () => document.getElementById("toggle") as HTMLButtonElement;

export function setStatus(state: ConnectionState, detail?: string): void {
  dot().className = state;
  statusEl().textContent =
    detail ?? state.charAt(0).toUpperCase() + state.slice(1);
  toggleBtn().textContent = state === "disconnected" ? "Connect" : "Disconnect";
}

const MAX_LOG_LINES = 200;

export function logLine(msg: string): void {
  const el = logEl();
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  const lines = el.textContent!.split("\n");
  if (lines.length > MAX_LOG_LINES) {
    el.textContent = lines.slice(lines.length - MAX_LOG_LINES).join("\n");
  }
  el.scrollTop = el.scrollHeight;
}

export function onToggleClick(handler: () => void): void {
  toggleBtn().addEventListener("click", handler);
}
