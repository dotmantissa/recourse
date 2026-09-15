import { setTimeout } from "node:timers/promises";

export async function retryRpcRead(operation, { attempts = 4, delayMs = 2000 } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) throw new Error("Invalid RPC read retry limits");
  for (let attempt = 1; ; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (attempt >= attempts) throw error;
      await setTimeout(delayMs);
    }
  }
}
