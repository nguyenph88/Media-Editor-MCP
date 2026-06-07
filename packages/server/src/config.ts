export const config = {
  /** Port the embedded WebSocket bridge listens on for the UXP plugin. */
  wsPort: Number(process.env.PPMCP_WS_PORT ?? 3001),
  /** Default per-command timeout. */
  commandTimeoutMs: Number(process.env.PPMCP_TIMEOUT_MS ?? 15_000),
  /** Timeout for bulk operations like apply_transition_to_all_cuts. */
  bulkCommandTimeoutMs: Number(process.env.PPMCP_BULK_TIMEOUT_MS ?? 120_000),
  /** WS heartbeat interval / liveness window. */
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
};
