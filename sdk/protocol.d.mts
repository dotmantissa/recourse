export function deploymentScope(chainId: number, contractAddress: string): string;
export function canonicalJson(value: unknown): string;
export function digest(value: unknown): string;
export function resultAccessMessage(value: { chainId: number; contractAddress: string; jobId: string; requestHash: string; wallet: string; audience: string; expiresAt: number }): string;
export function validateAccessExpiry(expiresAt: number, now?: number): void;
export function verifyDelivery(result: unknown, job: unknown, capability: unknown): Promise<void>;
