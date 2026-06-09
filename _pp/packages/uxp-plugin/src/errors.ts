import type { BridgeErrorCode } from "@ppmcp/protocol";

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
